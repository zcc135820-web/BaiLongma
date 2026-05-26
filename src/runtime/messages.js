import { normalizeChannel } from './channel.js'
import { trimAssistantFluff } from './reply-cleanup.js'

export function formatConversationMessage(row, currentMsg = null, prevChannel = '') {
  if (row.role === 'jarvis') {
    // Jarvis 出站的渠道也标出来，让模型能"看到"自己上次回到了哪里
    const rawChannel = row.channel || ''
    const normalized = normalizeChannel(rawChannel)
    const channelTag = (normalized && normalized !== 'TUI' && normalized !== 'SYSTEM') ? `[via ${normalized}] ` : ''
    return {
      role: 'assistant',
      content: `${channelTag}${trimAssistantFluff(row.content || '')}`,
    }
  }

  // Truncate timestamp to minute precision (drop seconds and timezone)
  const ts = row.timestamp ? row.timestamp.slice(0, 16).replace('T', ' ') : ''
  const rawChannel = row.channel || currentMsg?.channel || ''
  const normalizedChannel = normalizeChannel(rawChannel)

  const isSystemSignal = row.from_id === 'SYSTEM' || normalizedChannel === 'SYSTEM' || rawChannel === 'APP_SIGNAL' || rawChannel === 'REMINDER'

  if (isSystemSignal) {
    const channelLabel = rawChannel ? ` · ${rawChannel}` : ''
    return {
      role: 'user',
      content: `[system signal · ${ts}${channelLabel}]\n${row.content || ''}\n(Respond with tools only. Do NOT call send_message.)`.trim(),
    }
  }

  const isCurrent = currentMsg
    && row.role === 'user'
    && row.from_id === currentMsg.fromId
    && row.timestamp === currentMsg.timestamp
    && row.content === currentMsg.content
  const marker = isCurrent ? 'current user message' : 'user message'
  // 简化后的渠道：TUI 视为默认不显示；其他（WECHAT/DISCORD/FEISHU/WECOM）显示
  let channelLabel = (normalizedChannel && normalizedChannel !== 'TUI') ? ` · ${normalizedChannel}` : ''

  // channel 切换提示：本条消息相对上一条的入口换了，给模型一个显眼的指代锚点。
  // 主要场景：用户在 TUI 聊到一半切到微信继续问"那现在呢？"——必须让 LLM 知道
  // 入口变了、感知能力也跟着变了，否则代词会被 runtime 块（电池/系统块）抢走。
  if (prevChannel && normalizedChannel && prevChannel !== normalizedChannel) {
    channelLabel += ` (channel switch: ${prevChannel} → ${normalizedChannel})`
  }

  return {
    role: 'user',
    content: `[${marker} · ${row.from_id || 'unknown'} · ${ts}${channelLabel}]\n${row.content || ''}`.trim(),
  }
}

export function formatTaskSteps(taskSteps = []) {
  if (!taskSteps?.length) return ''
  const statusIcon = { done: '✓', failed: '✗', skipped: '—', pending: '○' }
  const lines = taskSteps.map((s, i) => {
    const icon = statusIcon[s.status] || '○'
    const note = s.note ? ` (${s.note})` : ''
    return `  ${i + 1}. [${icon}] ${s.text}${note}`
  })
  const done = taskSteps.filter(s => s.status === 'done').length
  const total = taskSteps.length
  return `Task step progress (${done}/${total}):\n${lines.join('\n')}`
}

export function buildRuntimeContextMessages({ recentActions = [], actionLog = [], lastToolResult = null, taskSteps = [], batteryBlock = '' } = {}) {
  const parts = []

  if (batteryBlock) {
    parts.push(batteryBlock)
  }

  if (taskSteps?.length > 0) {
    parts.push(formatTaskSteps(taskSteps))
  }

  if (recentActions?.length > 0) {
    const lines = recentActions.map(item => `- ${item.ts?.slice(11, 16) || ''} ${item.summary || ''}`).join('\n')
    parts.push(`Recent assistant actions:\n${lines}\nAvoid immediately repeating the same action unless the current user message asks for it.`)
  }

  if (actionLog?.length > 0) {
    const lines = actionLog.slice(-10).map(item => {
      const time = item.timestamp?.slice(11, 16) || ''
      const detail = item.detail ? `\n  ${item.detail}` : ''
      return `- ${time} ${item.tool || ''} · ${item.summary || ''}${detail}`
    }).join('\n')
    parts.push(`Recent tool/action log:\n${lines}\nUse this as runtime context only. Do not repeat completed actions unless the current task requires it.`)
  }

  if (lastToolResult) {
    const argsSummary = Object.entries(lastToolResult.args || {})
      .map(([key, value]) => `${key}=${String(value).slice(0, 60)}`)
      .join(', ')
    const resultPreview = String(lastToolResult.result || '').slice(0, 500)
    parts.push(`Previous tool result:\n${lastToolResult.name}(${argsSummary}) ->\n${resultPreview}\nAbsorb this result before deciding the next step.`)
  }

  if (parts.length === 0) return []
  return [{
    role: 'user',
    content: `[runtime context]\n${parts.join('\n\n')}`,
  }]
}

export function buildLLMMessages({ systemPrompt, contextBlock = '', conversationWindow = [], input, msg = null, recentActions = [], actionLog = [], lastToolResult = null, taskSteps = [], batteryBlock = '' }) {
  const messages = [{ role: 'system', content: systemPrompt }]
  messages.push(...buildRuntimeContextMessages({ recentActions, actionLog, lastToolResult, taskSteps, batteryBlock }))

  const rows = Array.isArray(conversationWindow) ? conversationWindow : []
  // Track which message in the array should receive this round's <context> block:
  // it's the last user-role message representing the "current" turn — either the
  // matched row from conversationWindow (when msg is already persisted to db) or
  // the appended fallback message below (TICK / unmatched cases).
  let currentMessageIndex = -1
  // prevChannel 维护：上一条非 SYSTEM 消息的 normalized channel，用于在 marker
  // 上标注 channel switch（"那现在呢"代词消解所依赖的核心信号之一）。
  let prevChannel = ''

  for (const row of rows) {
    if (!row?.content) continue
    const rowNorm = normalizeChannel(row.channel || '')
    const isSystemRow = row.from_id === 'SYSTEM' || rowNorm === 'SYSTEM' || row.channel === 'APP_SIGNAL' || row.channel === 'REMINDER'
    const formatted = formatConversationMessage(row, msg, isSystemRow ? '' : prevChannel)
    if (!formatted.content) continue
    messages.push(formatted)
    const isCurrent = !!msg
      && row.role === 'user'
      && row.from_id === msg.fromId
      && row.timestamp === msg.timestamp
      && row.content === msg.content
    if (isCurrent) currentMessageIndex = messages.length - 1
    if (!isSystemRow && rowNorm) prevChannel = rowNorm
  }

  const hasCurrentMessage = currentMessageIndex >= 0

  if (!hasCurrentMessage) {
    messages.push({
      role: 'user',
      content: input,
    })
    currentMessageIndex = messages.length - 1
  }

  // Prepend this round's <context>...</context> to the current user message.
  // The block is NOT persisted to db — conversations are written from the raw
  // user content (see queue.pushMessage) and assistant outputs are stored
  // verbatim, so the next round's conversationWindow stays clean.
  if (contextBlock && currentMessageIndex >= 0) {
    const target = messages[currentMessageIndex]
    target.content = `${contextBlock}\n\n${target.content || ''}`
  }

  return messages
}
