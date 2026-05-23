import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { nowTimestamp } from '../time.js'
import { insertMemory, normalizeConversationPartyId, createReminder, findMergeableOneOffReminder, appendReminderTask, listPendingReminders, getReminderById, cancelReminder, upsertPrefetchTask, removePrefetchTask, listPrefetchTasks, insertConversation, upsertMusicTrack, getMusicTrack, searchMusicLibrary, listMusicLibrary, updateMusicLrc, deleteMusicTrack as dbDeleteMusicTrack, setConfig as dbSetConfig } from '../db.js'
import { emitEvent, emitUICommand, emitACUIEvent, hasACUIClient, addActiveUICard, removeActiveUICard, getActiveUICards, setStickyEvent } from '../events.js'
import { dispatchSocialMessage } from '../social/dispatch.js'
import { callCapability, listCapabilities } from '../providers/registry.js'
import { isDailyLimitReached } from '../quota.js'
import { setCustomInterval as setTickerInterval, getStatus as getTickerStatus } from '../ticker.js'
import { setHotspotPanelState, getHotspotPanelState } from '../hotspots.js'
import { setPersonCardPanelState, getPersonCardPanelState, getPersonCard } from '../person-cards.js'
import { setDocPanelState, getDocPanelState } from '../docs.js'
import { setUserLocation } from '../weather.js'
import { getAgentById, isDelegationAllowed } from '../agents/registry.js'
import { installTool, uninstallTool, listInstalledTools, isInstalledTool, executeInstalledTool } from './marketplace/index.js'
import { TOOL_SCHEMAS } from './schemas.js'
import { throwIfAborted } from './abort-utils.js'
import { SANDBOX_ROOT, isPathInside } from './sandbox.js'
import { evaluateToolPolicy } from './tool-policy.js'
import { inferToolStatus, writeToolAuditLog } from './tool-audit.js'
import { execDeleteFile, execListDir, execMakeDir, execReadFile, execWriteFile } from './tools/filesystem.js'
import { execCommand, execKillProcess, execListProcesses } from './tools/shell.js'
import { execBrowserRead, execFetchUrl, execWebSearch } from './tools/web.js'
import { execDowngradeMemory, execMergeMemories, execRecallMemory, execSearchMemory, execSkipConsolidation, execSkipRecognition, execUpsertMemory } from './tools/memory.js'

import { config, getTTSCredentials, setSecurity } from '../config.js'
import { streamTTS } from '../voice/tts-providers.js'
import { paths } from '../paths.js'
import { PRIMARY_USER_ID, lookupReplyTarget, normalizeChannel, suggestProactiveChannel } from '../identity.js'
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// inline-script 草稿注册表（内存 + 磁盘双存）
const draftCodeMap = new Map()   // { scratchId → code }
const appIdToName  = new Map()   // { scratchId → appName }
const DRAFT_CODE_MAP_MAX = 50    // 超出后淘汰最旧条目
function addDraftCode(id, code) {
  if (draftCodeMap.size >= DRAFT_CODE_MAP_MAX) {
    draftCodeMap.delete(draftCodeMap.keys().next().value)
  }
  draftCodeMap.set(id, code)
}

// 由 api.js 调用：把 app:saveState 信号的状态自动落盘
export function persistAppState(componentId, state) {
  const name = appIdToName.get(componentId)
  if (!name) return false
  try {
    const statePath = path.resolve(SANDBOX_ROOT, 'apps', name, 'state.json')
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8')
    return true
  } catch { return false }
}

// 工具执行器：根据工具名和参数执行对应操作，返回结果字符串
async function executeToolUnchecked(name, args, context = {}) {
  try {
    throwIfAborted(context.signal)
    switch (name) {
      case 'express':
        return await execExpress(args, context)
      case 'send_message':
        return await execSendMessage(args, context)
      case 'read_file':
        return await execReadFile(args, context)
      case 'list_dir':
        return await execListDir(args, context)
      case 'write_file':
        return await execWriteFile(args, context)
      case 'delete_file':
        return await execDeleteFile(args, context)
      case 'make_dir':
        return await execMakeDir(args, context)
      case 'exec_command':
        return await execCommand(args, context)
      case 'kill_process':
        return await execKillProcess(args)
      case 'list_processes':
        return await execListProcesses(args)
      case 'web_search':
        return await execWebSearch(args, context)
      case 'fetch_url':
        return await execFetchUrl(args, context)
      case 'browser_read':
        return await execBrowserRead(args, context)
      case 'search_memory':
        return await execSearchMemory(args)
      case 'upsert_memory':
        return await execUpsertMemory(args, context)
      case 'skip_recognition':
        return await execSkipRecognition(args)
      case 'merge_memories':
        return await execMergeMemories(args, context)
      case 'downgrade_memory':
        return await execDowngradeMemory(args)
      case 'skip_consolidation':
        return await execSkipConsolidation(args)
      case 'speak':
        return await execSpeak(args)
      case 'generate_lyrics':
        return await execGenerateLyrics(args)
      case 'generate_music':
        return await execGenerateMusic(args)
      case 'generate_image':
        return await execGenerateImage(args)
      case 'set_tick_interval':
        return execSetTickInterval(args)
      case 'media_mode':
        return execMediaMode(args)
      case 'hotspot_mode':
        return execHotspotMode(args)
      case 'open_doc_panel':
        return execOpenDocPanel(args)
      case 'person_card_mode':
        return execPersonCardMode(args)
      case 'music':
        return await execMusic(args)
      case 'schedule_reminder':
      case 'manage_reminder':
        return await execManageReminder(args, context)
      case 'manage_prefetch_task':
        return execManagePrefetchTask(args)
      case 'ui_show':
        return execUIShow(args)
      case 'ui_update':
        return execUIUpdate(args)
      case 'ui_hide':
        return execUIHide(args)
      case 'ui_patch':
        return execUIPatch(args)
      case 'manage_app':
        return execManageApp(args)
      case 'ui_register':
        return execUIRegister(args)
      case 'focus_banner':
        return execFocusBanner(args)
      case 'set_location':
        return execSetLocation(args)
      case 'set_agent_name':
        return execSetAgentName(args)
      case 'delegate_to_agent':
        return await execDelegateToAgent(args)
      case 'grant_agent_delegation':
        return execGrantAgentDelegation(args)
      case 'complete_startup_self_check':
        return execCompleteStartupSelfCheck(args, context)
      case 'set_task':
        return execSetTask(args, context)
      case 'complete_task':
        return execCompleteTask(args, context)
      case 'update_task_step':
        return execUpdateTaskStep(args, context)
      case 'recall_memory':
        return await execRecallMemory(args, context)
      case 'install_tool':
        return await execInstallTool(args)
      case 'uninstall_tool':
        return execUninstallTool(args)
      case 'list_tools':
        return execListTools()
      case 'connect_wechat':
        return execConnectWechat()
      case 'set_security':
        return execSetSecurity(args)
      default:
        if (isInstalledTool(name)) {
          return await executeInstalledTool(name, args)
        }
        return `错误：未知工具 "${name}"`
    }
  } catch (err) {
    if (err.name === 'AbortError') throw err
    return `执行失败：${err.message}`
  }
}

export async function executeTool(name, args, context = {}) {
  const startedAt = Date.now()
  const safeArgs = args || {}
  const policy = evaluateToolPolicy(name, safeArgs, context)

  if (!policy.allowed) {
    const result = toolJson({
      ok: false,
      tool: name,
      error: 'permission denied',
      policy: {
        risk: policy.risk,
        reason: policy.reason,
      },
    })
    writeToolAuditLog({ name, args: safeArgs, context, policy, status: 'denied', result, startedAt })
    return result
  }

  try {
    const result = await executeToolUnchecked(name, safeArgs, context)
    writeToolAuditLog({ name, args: safeArgs, context, policy, status: inferToolStatus(result), result, startedAt })
    return result
  } catch (err) {
    if (err.name === 'AbortError') throw err
    const result = `执行失败：${err.message}`
    writeToolAuditLog({ name, args: safeArgs, context, policy, status: 'error', result, error: err.message, startedAt })
    return result
  }
}

function resolveAllowedTargetId(targetId, allowedTargetIds = []) {
  const normalizedTarget = normalizeConversationPartyId(targetId)
  const normalizedAllowed = [...new Set((allowedTargetIds || []).map(id => normalizeConversationPartyId(id)).filter(Boolean))]
  if (!normalizedAllowed.length) {
    throw new Error('The current prompt did not explicitly inject any sendable target entities, so sending a message is forbidden.')
  }

  if (normalizedAllowed.includes(normalizedTarget)) {
    return normalizedTarget
  }

  const compact = value => String(value || '').trim().toLowerCase().replace(/^id:0*/, '')
  const targetCompact = compact(normalizedTarget)
  const fuzzyMatches = normalizedAllowed.filter(id => compact(id) === targetCompact)
  if (fuzzyMatches.length === 1) {
    console.log(`[send_message] ID strict validation passed by fuzzy normalization: "${targetId}" -> "${fuzzyMatches[0]}"`)
    return fuzzyMatches[0]
  }

  throw new Error(`target_id "${targetId}" is not in the target entity list explicitly injected into the current prompt: ${normalizedAllowed.join(', ')}`)
}

function assertVisibleTargetId(targetId, visibleTargetIds = []) {
  const normalizedTarget = normalizeConversationPartyId(targetId)
  const normalizedVisible = [...new Set((visibleTargetIds || []).map(id => normalizeConversationPartyId(id)).filter(Boolean))]
  if (!normalizedVisible.length) {
    throw new Error('The current L2 prompt did not inject any conversation targets, so sending a message is forbidden.')
  }

  if (normalizedVisible.includes(normalizedTarget)) {
    return normalizedTarget
  }

  throw new Error(`target_id "${targetId}" does not appear in the conversation records injected into the current L2 prompt: ${normalizedVisible.join(', ')}`)
}

function parseReminderDueAt(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('due_at was not provided')
  }
  const dueAt = new Date(value.trim())
  if (Number.isNaN(dueAt.getTime())) {
    throw new Error('due_at must be a valid ISO 8601 absolute time, for example 2026-04-21T06:00:00+08:00')
  }
  return dueAt
}

function trimAssistantFluff(content) {
  let text = String(content || '').trim()
  if (!text) return text

  text = text
    .replace(/^(?:\s*\[assistant(?:\s+to\s+[^\]\r\n]+)?(?:\s+\d{4}-\d{2}-\d{2}T[^\]\r\n]+)?\]\s*)+/giu, '')
    .trim()

  const patterns = [
    /[，,、。.!！？~～\s]*(?:从现在起|从今以后|以后)?我就是[\u4e00-\u9fa5A-Za-z0-9 _-]{1,24}[，,、。.!！？~～\s]*为您效劳[！!～~。.\s]*$/u,
    /[，,、。.!！？~～\s]*有什么需要帮忙的[？?]?[，,、。.!！？~～\s]*(?:随时)?为您效劳[～~！!。.\s]*$/u,
    /[，,、。.!！？~～\s]*有什么需要我帮忙的[？?]?[，,、。.!！？~～\s]*(?:随时)?为您效劳[～~！!。.\s]*$/u,
    /[，,、。.!！？~～\s]*随时为您效劳[～~！!。.\s]*$/u,
    /[，,、。.!！？~～\s]*为您效劳[～~！!。.\s]*$/u,
    /[，,、。.!！？~～\s]*有什么需要帮忙的[？?]?[～~！!。.\s]*$/u,
    /[，,、。.!！？~～\s]*有什么需要我帮忙的[？?]?[～~！!。.\s]*$/u,
  ]

  let changed = true
  while (changed) {
    changed = false
    for (const pattern of patterns) {
      const next = text.replace(pattern, '').trim()
      if (next !== text) {
        text = next
        changed = true
      }
    }
  }

  return text
}

// express：表达器入口，根据 format 路由到对应输出渠道
async function execExpress({ target_id, content, channel = 'AUTO', format = 'text' }, context = {}) {
  if (!content?.trim()) return '错误：未提供表达内容'
  if (format === 'voice') {
    // 语音表达：先发文字消息再生成语音
    const sendResult = await execSendMessage({ target_id, content, channel }, context)
    if (sendResult.startsWith('错误：') || sendResult.startsWith('执行失败：')) return sendResult
    return await execSpeak({ text: content })
  }
  // 默认：文字表达
  return await execSendMessage({ target_id, content, channel }, context)
}

// 决议出站消息的真实投递目标：
// 输入 target_id（可能是 canonical ID:000001 或带前缀的外部 ID）+ channel 偏好（WECHAT/DISCORD/FEISHU/WECOM/TUI/AUTO）+ ctx
// 输出 { externalTargetId, deliveryChannel, isLocal, reason }
//   - externalTargetId: 传给 dispatchSocialMessage 的 ID（本地投递时为 null）
//   - deliveryChannel: conversations.channel 字段实际值（数据库格式，如 WECHAT_CLAWBOT/TUI）
//   - isLocal: true 时不调外部 dispatch，只走本地 SSE
//   - reason: 失败时给 LLM 的提示
// AUTO 决议顺序：当前 turn 渠道（响应模式）→ suggestProactiveChannel（主动模式）
function resolveDeliveryTarget(resolvedId, channelPref, context = {}) {
  const pref = (channelPref || 'AUTO').toUpperCase()

  // resolvedId 本身就是带渠道前缀的外部 ID（少见，但保留兼容）—— 直接当外部投递
  if (/^(wechat|discord|feishu|wecom):/i.test(resolvedId)) {
    return { externalTargetId: resolvedId, deliveryChannel: '', isLocal: false }
  }

  // canonical 用户 ID：根据 channel 偏好决议
  let actualPref = pref
  if (actualPref === 'AUTO') {
    // 优先用当前 turn 的渠道：用户在哪儿发消息就回到哪儿（响应直觉一致）
    const currentNorm = context.currentChannel ? normalizeChannel(context.currentChannel) : null
    if (currentNorm && currentNorm !== 'SYSTEM') {
      actualPref = currentNorm
    } else {
      // 没有当前 turn 渠道（典型场景：tick 主动外联）→ 用 presence 推荐
      actualPref = suggestProactiveChannel(resolvedId)
    }
  }

  if (actualPref === 'TUI') {
    return { externalTargetId: null, deliveryChannel: 'TUI', isLocal: true }
  }

  // 当前 turn 已经在该外部渠道、且带 externalPartyId → 直接复用，省一次 DB 查
  if (context.currentExternalPartyId && context.currentChannel) {
    const ctxNorm = normalizeChannel(context.currentChannel)
    if (ctxNorm === actualPref) {
      return {
        externalTargetId: context.currentExternalPartyId,
        deliveryChannel: context.currentChannel,
        isLocal: false,
      }
    }
  }

  // 否则反查该 canonical 用户在指定渠道最近一次的 external_id
  const reply = lookupReplyTarget({ canonicalId: resolvedId, channel: actualPref })
  if (reply) {
    return { externalTargetId: reply.externalId, deliveryChannel: reply.channel, isLocal: false }
  }

  // 用户在该渠道从未交互过，无法主动联系
  return {
    externalTargetId: null,
    deliveryChannel: '',
    isLocal: false,
    error: `cannot route to ${actualPref}: user ${resolvedId} has no recorded external_party_id on that channel`,
  }
}

// send_message：投递到指定渠道（本地 SSE 或外部平台），并写入 conversations 表
async function execSendMessage({ target_id, content, channel = 'AUTO' }, context = {}) {
  if (!target_id) return '错误：未提供 target_id'
  if (!content?.trim()) return '错误：未提供消息内容'

  const resolvedId = resolveAllowedTargetId(target_id, context.allowedTargetIds)
  assertVisibleTargetId(resolvedId, context.visibleTargetIds)
  const cleanedContent = trimAssistantFluff(content)
  if (!cleanedContent) return '错误：消息内容为空'

  const delivery = resolveDeliveryTarget(resolvedId, channel, context)
  if (delivery.error) return `错误：${delivery.error}`

  const timestamp = nowTimestamp()
  const channelLabel = delivery.deliveryChannel || (delivery.isLocal ? 'TUI' : '')
  console.log(`\n[消息发送] → ${resolvedId}${delivery.externalTargetId ? ` via ${delivery.externalTargetId}` : ''}${channelLabel ? ` [${channelLabel}]` : ''}`)
  console.log(`  ${cleanedContent}`)
  console.log(`  时间：${timestamp}`)

  // 顺序：先写数据库（source of truth），再广播 SSE，最后外部投递。
  // 外部投递失败时仍保留对话记录，下次 LLM 仍能看到自己发过这句话；前端也已经显示。
  insertConversation({
    role: 'jarvis',
    from_id: 'jarvis',
    to_id: resolvedId,
    content: cleanedContent,
    timestamp,
    channel: channelLabel,
    external_party_id: delivery.externalTargetId || '',
  })

  emitEvent('message', {
    from: 'consciousness',
    to: resolvedId,
    content: cleanedContent,
    timestamp,
    channel: channelLabel,
    external_party_id: delivery.externalTargetId || '',
  })

  let socialResult = null
  if (!delivery.isLocal && delivery.externalTargetId) {
    try {
      socialResult = await dispatchSocialMessage(delivery.externalTargetId, cleanedContent)
    } catch (err) {
      console.warn(`[消息发送] 外部投递异常 (${delivery.deliveryChannel}): ${err.message}`)
      socialResult = { ok: false, error: err.message }
    }
  }

  if (socialResult?.ok) return `消息已发送至 ${resolvedId}（${socialResult.platform} 已投递）`
  if (socialResult?.skipped) return `消息已发送至 ${resolvedId}（社交平台未配置：${socialResult.reason}）`
  if (socialResult && socialResult.ok === false) {
    const reason = socialResult.reason || socialResult.error || 'unknown'
    // wechat-clawbot 缺 context_token 是该渠道最常见的失败：重启后内存 Map 清空、或用户从未入站。
    // 单独点名，让 LLM 直接告诉用户"先发一条过来"，不要去编造其他解释。
    const isMissingContextToken = /no context_token/i.test(reason)
    const hint = isMissingContextToken
      ? '（wechat-clawbot 必须先收到该用户的入站消息才能回发；告诉用户先从微信给你发一条任意内容即可。）'
      : ''
    return `消息发送失败：外部渠道 ${delivery.deliveryChannel || 'unknown'} 投递未成功（${reason}）。${hint}请如实告知用户该消息未送达及原因。`
  }
  return `消息已发送至 ${resolvedId}${channelLabel ? `（${channelLabel}）` : ''}`
}

function parseHourMinute(value, label = 'time') {
  const m = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) throw new Error(`${label} must use HH:MM format, for example 09:00`)
  const hour = Number(m[1]), minute = Number(m[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error(`${label} is outside the valid range`)
  return { hour, minute }
}

// 周期提醒：根据 type/config 计算下一次触发时间（晚于 fromDate）
export function calculateNextDueAt(type, config, fromDate = new Date()) {
  const now = fromDate
  const { hour, minute } = parseHourMinute(config.time, 'time')

  if (type === 'daily') {
    const next = new Date(now)
    next.setHours(hour, minute, 0, 0)
    if (next <= now) next.setDate(next.getDate() + 1)
    return next
  }
  if (type === 'weekly') {
    const targetWeekday = Number(config.weekday)
    if (!Number.isInteger(targetWeekday) || targetWeekday < 0 || targetWeekday > 6) {
      throw new Error('weekday must be an integer from 0 to 6 (0=Sunday)')
    }
    const next = new Date(now)
    next.setHours(hour, minute, 0, 0)
    let diff = (targetWeekday - now.getDay() + 7) % 7
    if (diff === 0 && next <= now) diff = 7
    next.setDate(next.getDate() + diff)
    return next
  }
  if (type === 'monthly') {
    const targetDay = Number(config.day_of_month)
    if (!Number.isInteger(targetDay) || targetDay < 1 || targetDay > 31) {
      throw new Error('day_of_month must be an integer from 1 to 31')
    }
    let year = now.getFullYear(), month = now.getMonth()
    for (let i = 0; i < 12; i++) {
      const lastDay = new Date(year, month + 1, 0).getDate()
      if (targetDay <= lastDay) {
        const next = new Date(year, month, targetDay, hour, minute, 0, 0)
        if (next > now) return next
      }
      month++
      if (month > 11) { month = 0; year++ }
    }
    throw new Error('Could not find the next matching month')
  }
  throw new Error(`Unknown recurrence kind: ${type}`)
}

function buildSystemMessage(targetId, taskText) {
  return `I am the system. Based on the reminder you set, you now need to perform this task for user ${targetId}: ${taskText}. Handle it immediately, and when needed use send_message to send the result to ${targetId}.`
}

function formatReminderRow(r) {
  const recurrence = r.recurrence_type
    ? `[${r.recurrence_type}] ${(() => {
        try {
          const c = JSON.parse(r.recurrence_config || '{}')
          if (r.recurrence_type === 'daily') return `每天 ${c.time}`
          if (r.recurrence_type === 'weekly') {
            const names = ['周日','周一','周二','周三','周四','周五','周六']
            return `每${names[c.weekday]} ${c.time}`
          }
          if (r.recurrence_type === 'monthly') return `每月 ${c.day_of_month} 号 ${c.time}`
          return JSON.stringify(c)
        } catch { return '' }
      })()}`
    : '[once]'
  return `#${r.id} ${recurrence} 下次 ${r.due_at} → ${r.user_id}：${r.task}`
}

async function execManageReminder(args, context = {}) {
  const action = args.action || (args.due_at || args.kind ? 'create' : null)
  if (!action) return '错误：未提供 action（create/list/cancel）'

  if (action === 'list') {
    const rows = listPendingReminders(50)
    if (!rows.length) return '当前没有待触发的提醒。'
    return `共 ${rows.length} 条待触发提醒：\n` + rows.map(formatReminderRow).join('\n')
  }

  if (action === 'cancel') {
    const id = Number(args.id)
    if (!Number.isInteger(id) || id <= 0) return '错误：cancel 需要提供合法的提醒 id'
    const existing = getReminderById(id)
    if (!existing) return `错误：未找到提醒 #${id}`
    if (existing.status !== 'pending') return `错误：提醒 #${id} 当前状态为 ${existing.status}，无法取消`
    const result = cancelReminder(id)
    if (!result.changes) return `错误：取消提醒 #${id} 失败`
    emitEvent('reminder_cancelled', { id, user_id: existing.user_id, task: existing.task })
    return `提醒 #${id} 已取消（${existing.task}）`
  }

  if (action !== 'create') return `错误：未知 action "${action}"，仅支持 create/list/cancel`

  const { task } = args
  if (!task?.trim()) return '错误：未提供 task'
  const taskText = task.trim()
  const fallbackTargetId = context.visibleTargetIds?.[0] || context.allowedTargetIds?.[0] || PRIMARY_USER_ID
  const resolvedTargetId = resolveAllowedTargetId(args.target_id || fallbackTargetId, context.allowedTargetIds)

  const kind = args.kind || 'once'

  if (kind === 'once') {
    const dueAt = parseReminderDueAt(args.due_at)
    if (dueAt.getTime() <= Date.now()) throw new Error('提醒时间必须晚于当前时间')
    const isoDueAt = dueAt.toISOString()
    const minuteKey = isoDueAt.slice(0, 16)

    const mergeTarget = findMergeableOneOffReminder(resolvedTargetId, minuteKey)
    if (mergeTarget) {
      const mergedTaskText = `${mergeTarget.task}; ${taskText}`
      const newSystemMessage = buildSystemMessage(resolvedTargetId, mergedTaskText)
      const r = appendReminderTask(mergeTarget.id, taskText, newSystemMessage)
      if (!r.changes) return `错误：合并提醒 #${mergeTarget.id} 失败`
      emitEvent('reminder_merged', { id: mergeTarget.id, user_id: resolvedTargetId, due_at: mergeTarget.due_at, task: mergedTaskText })
      return `已合并到现有提醒 #${mergeTarget.id}（同时间），合并后任务：${mergedTaskText}`
    }

    const result = createReminder({
      userId: resolvedTargetId,
      dueAt: isoDueAt,
      task: taskText,
      systemMessage: buildSystemMessage(resolvedTargetId, taskText),
      source: `tool:manage_reminder@${nowTimestamp()}`,
    })
    emitEvent('reminder_created', { id: Number(result.lastInsertRowid), user_id: resolvedTargetId, due_at: isoDueAt, task: taskText })
    return `提醒已创建：#${result.lastInsertRowid}，将在 ${isoDueAt} 触发，目标用户 ${resolvedTargetId}`
  }

  // 周期提醒
  const config = {}
  if (kind === 'daily') {
    config.time = args.time
  } else if (kind === 'weekly') {
    config.time = args.time
    config.weekday = args.weekday
  } else if (kind === 'monthly') {
    config.time = args.time
    config.day_of_month = args.day_of_month
  } else {
    throw new Error(`未知的 kind "${kind}"，支持 once/daily/weekly/monthly`)
  }

  const nextDate = calculateNextDueAt(kind, config)
  const isoDueAt = nextDate.toISOString()
  const result = createReminder({
    userId: resolvedTargetId,
    dueAt: isoDueAt,
    task: taskText,
    systemMessage: buildSystemMessage(resolvedTargetId, taskText),
    source: `tool:manage_reminder@${nowTimestamp()}`,
    recurrenceType: kind,
    recurrenceConfig: config,
  })
  emitEvent('reminder_created', { id: Number(result.lastInsertRowid), user_id: resolvedTargetId, due_at: isoDueAt, task: taskText, recurrence_type: kind, recurrence_config: config })
  return `周期提醒已创建：#${result.lastInsertRowid} (${kind})，下次触发 ${isoDueAt}，目标用户 ${resolvedTargetId}`
}

function toolJson(payload) {
  return JSON.stringify(payload, null, 2)
}

// speak：将文字转为语音，保存为音频文件
// 有效的 MiniMax 声音 ID
const VALID_VOICE_IDS = new Set([
  'male-qn-qingse', 'male-qn-jingying', 'male-qn-badao', 'male-qn-daxuesheng',
  'female-shaonv', 'female-yujie', 'female-chengshu', 'female-tianmei',
  'presenter_male', 'presenter_female', 'audiobook_male_1', 'audiobook_female_1',
])
const DEFAULT_VOICE = 'male-qn-qingse'

async function execSpeak(args) {
  const text = args.text || args.content || args.words || args.speech
  const { filename } = args
  console.log(`[speak] args:`, JSON.stringify(args))
  if (!text) return '错误：未提供要朗读的文字'
  if (isDailyLimitReached('tts')) return '错误：今日 TTS 配额已用完'
  if (text.length > 1000) return `错误：文字过长（${text.length} 字），请控制在 1000 字以内`

  const creds = getTTSCredentials()
  const voiceId = (args.voice_id || args.voice) || creds.voiceId

  const nodeStream = await streamTTS({ text, provider: creds.provider, voiceId, keys: creds })
  const chunks = []
  for await (const chunk of nodeStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const buffer = Buffer.concat(chunks)

  const ts = nowTimestamp().replace(/[:.+]/g, '-').slice(0, 19)
  const fname = filename ? filename.replace(/[^a-zA-Z0-9_一-龥-]/g, '') + '.mp3' : `speech_${ts}.mp3`
  const resolved = path.resolve(SANDBOX_ROOT, 'audio', fname)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, buffer)

  const relPath = `audio/${fname}`
  emitEvent('audio_created', { path: relPath, text: text.slice(0, 60), autoPlay: true })
  console.log(`[speak] 已生成: ${relPath}`)
  return `语音已生成：${relPath}`
}

// ─── 工具市场执行函数 ──────────────────────────────────────────────────────────

async function execInstallTool(args) {
  const { name, description, parameters_schema, code } = args
  return await installTool({ name, description, parameters: parameters_schema, code })
}

function execUninstallTool(args) {
  return uninstallTool({ name: args.name })
}

function execListTools() {
  const builtins = Object.entries(TOOL_SCHEMAS)
    .filter(([name]) => name !== 'express')
    .map(([name, s]) => ({ name, description: s.function.description, source: 'builtin' }))
  const installed = listInstalledTools()
  const all = [...builtins, ...installed]
  const lines = all.map(t => `[${t.source}] ${t.name}: ${t.description}`)
  return `共 ${all.length} 个工具（${builtins.length} 内置 + ${installed.length} 已安装）：\n\n${lines.join('\n')}`
}

// 语音消息自动回复 TTS：检测到用户用语音输入时，通知前端播放语音
// 由 index.js 调用，前端收到 tts_reply 事件后调用 /tts/stream 完成实际合成
export function autoSpeakForVoiceReply(text) {
  if (!text) return
  const plain = text.trim()
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .replace(/!\[[^\]]*\]\([^\)]+\)/g, '')
    .replace(/\n+/g, ' ')
    .trim()
  if (!plain) return
  emitEvent('tts_reply', { text: plain })
}

// generate_lyrics：生成歌词
async function execGenerateLyrics({ prompt, mode }) {
  if (!prompt) return '错误：未提供创作方向'
  if (isDailyLimitReached('lyrics')) return '错误：今日歌词生成配额已用完'

  const result = await callCapability('lyrics', { prompt, mode })

  // 自动保存歌词到 sandbox
  const ts = nowTimestamp().replace(/[:.+]/g, '-').slice(0, 19)
  const fname = `lyrics_${ts}.txt`
  const content = `# ${result.title}\n风格：${result.style}\n\n${result.lyrics}`
  const resolved = path.resolve(SANDBOX_ROOT, 'lyrics', fname)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, content, 'utf-8')

  emitEvent('lyrics_created', { path: `lyrics/${fname}`, title: result.title })
  return `歌词已生成并保存至 lyrics/${fname}\n\n标题：${result.title}\n风格：${result.style}\n\n${result.lyrics}`
}

// generate_music：生成音乐
async function execGenerateMusic({ prompt, lyrics, instrumental }) {
  if (!prompt) return '错误：未提供音乐描述'
  if (isDailyLimitReached('music')) return '错误：今日音乐生成配额已用完'

  const result = await callCapability('music', { prompt, lyrics, instrumental })

  const ts = nowTimestamp().replace(/[:.+]/g, '-').slice(0, 19)
  const fname = `music_${ts}.mp3`
  const resolved = path.resolve(SANDBOX_ROOT, 'music', fname)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, result.buffer)

  const relPath = `music/${fname}`
  emitEvent('music_created', { path: relPath, prompt: prompt.slice(0, 60) })
  console.log(`[music] 已生成: ${relPath}`)
  return `音乐已生成：${relPath}（时长约 ${result.duration ?? '?'} 秒）`
}

// generate_image：生成图片
async function execGenerateImage({ prompt, aspect_ratio = '1:1', n = 1 }) {
  if (!prompt) return '错误：未提供图片描述'
  if (isDailyLimitReached('image')) return '错误：今日图片生成配额已用完（50 次/天）'
  const validRatios = new Set(['1:1', '16:9', '4:3', '3:4', '9:16'])
  const ratio = validRatios.has(aspect_ratio) ? aspect_ratio : '1:1'
  const count = Math.min(Math.max(Math.floor(n) || 1, 1), 4)

  const result = await callCapability('image', { prompt, aspect_ratio: ratio, n: count })

  emitEvent('image_created', { urls: result.urls, prompt: prompt.slice(0, 60) })
  console.log(`[image] 已生成 ${result.urls.length} 张图片`)
  return `图片已生成（${result.urls.length} 张）：\n${result.urls.join('\n')}`
}

// manage_prefetch_task：管理预热任务
function execManagePrefetchTask({ action, source, label, url, ttl_minutes, tags }) {
  if (action === 'list') {
    const tasks = listPrefetchTasks()
    if (tasks.length === 0) return '当前没有预热任务。'
    return tasks.map(t =>
      `[${t.enabled ? '✓' : '✗'}] ${t.source}  ${t.label}  TTL=${t.ttl_minutes}min\n  URL: ${t.url}`
    ).join('\n')
  }

  if (action === 'add') {
    if (!source) return '错误：缺少 source'
    if (!label) return '错误：缺少 label'
    if (!url) return '错误：缺少 url'
    upsertPrefetchTask({ source, label, url, ttlMinutes: ttl_minutes ?? 60, tags: tags ?? [] })
    return `预热任务已保存：${source}（${label}），TTL=${ttl_minutes ?? 60}min。下次运行预热时生效。`
  }

  if (action === 'remove') {
    if (!source) return '错误：缺少 source'
    const ok = removePrefetchTask(source)
    return ok ? `预热任务已删除：${source}` : `未找到任务：${source}`
  }

  return `错误：未知 action "${action}"，可选 add / remove / list`
}

// set_tick_interval：L2 调节自身思维节奏
function execSetTickInterval({ seconds, ttl, reason }) {
  const res = setTickerInterval({ seconds, ttl, reason })
  if (!res.ok) return `错误：${res.error}`
  const parts = [`节奏已设为 ${res.seconds}s，持续 ${res.ttl} 轮`]
  if (res.clampedFrom?.seconds !== undefined) parts.push(`（seconds ${res.clampedFrom.seconds} 越界，已 clamp 到 ${res.seconds}）`)
  if (res.clampedFrom?.ttl !== undefined) parts.push(`（ttl ${res.clampedFrom.ttl} 越界，已 clamp 到 ${res.ttl}）`)
  return parts.join('')
}

// ─────────────────────────────────────────────────────────────────────────────
// ACUI · UI 控制工具
// ─────────────────────────────────────────────────────────────────────────────
function execMediaMode(args = {}) {
  const mode = String(args.mode || args.kind || '').trim()
  const action = String(args.action || 'show').trim()
  if (!['video', 'camera', 'image', 'music'].includes(mode)) {
    return JSON.stringify({ ok: false, tool: 'media_mode', error: 'mode must be video, camera, image, or music' })
  }
  if (!['show', 'hide', 'close', 'play', 'pause', 'seek', 'set_volume', 'update'].includes(action)) {
    return JSON.stringify({ ok: false, tool: 'media_mode', error: 'unsupported action' })
  }

  const payload = {
    mode,
    action,
    url: typeof args.url === 'string' ? args.url : undefined,
    src: typeof args.src === 'string' ? args.src : undefined,
    title: typeof args.title === 'string' ? args.title : undefined,
    artist: typeof args.artist === 'string' ? args.artist : undefined,
    lrc: typeof args.lrc === 'string' ? args.lrc : undefined,
    cover: typeof args.cover === 'string' ? args.cover : undefined,
    alt: typeof args.alt === 'string' ? args.alt : undefined,
    autoplay: typeof args.autoplay === 'boolean' ? args.autoplay : (mode === 'music' ? true : undefined),
    muted: typeof args.muted === 'boolean' ? args.muted : undefined,
    camera: mode === 'camera' || args.camera === true,
  }

  if (Number.isFinite(Number(args.volume))) {
    payload.volume = Math.max(0, Math.min(1, Number(args.volume)))
  }
  if (Number.isFinite(Number(args.currentTime ?? args.time ?? args.seek))) {
    payload.currentTime = Math.max(0, Number(args.currentTime ?? args.time ?? args.seek))
  }

  emitEvent('media_mode', payload)
  emitEvent('action', { tool: 'media_mode', summary: `${mode}:${action}`, detail: payload.title || payload.url || '' })
  return JSON.stringify({ ok: true, tool: 'media_mode', ...payload })
}

function execHotspotMode(args = {}) {
  const action = String(args.action || 'status').trim().toLowerCase()
  if (!['show', 'open', 'hide', 'close', 'toggle', 'status'].includes(action)) {
    return JSON.stringify({ ok: false, tool: 'hotspot_mode', error: 'unsupported action' })
  }

  let nextActive = null
  if (action === 'show' || action === 'open') nextActive = true
  if (action === 'hide' || action === 'close') nextActive = false
  if (action === 'toggle') nextActive = !getHotspotPanelState().active

  const state = typeof nextActive === 'boolean'
    ? setHotspotPanelState({ active: nextActive, source: 'agent_tool' })
    : getHotspotPanelState()

  if (typeof nextActive === 'boolean') {
    emitEvent('hotspot_mode', {
      action: state.active ? 'show' : 'hide',
      active: state.active,
      reason: typeof args.reason === 'string' ? args.reason : '',
    })
    emitEvent('action', {
      tool: 'hotspot_mode',
      summary: state.active ? '打开热点面板' : '关闭热点面板',
      detail: args.reason || '',
    })
  }

  return JSON.stringify({ ok: true, tool: 'hotspot_mode', state })
}

function execOpenDocPanel(args = {}) {
  const action = String(args.action || 'open').trim().toLowerCase()
  const nextActive = action !== 'close'
  const validTopics = ['voice_asr', 'voice_tts', 'voice_config']

  // 打开时 topic 必填；关闭时 topic 可省略（沿用当前面板已有的 topicId）
  let topic = args.topic ? String(args.topic).trim() : null
  if (nextActive && topic && !validTopics.includes(topic)) {
    if (/asr|识别|麦克风/.test(topic)) topic = 'voice_asr'
    else if (/tts|合成|声音/.test(topic)) topic = 'voice_tts'
    else topic = 'voice_config'
  }

  const state = setDocPanelState({ active: nextActive, topicId: topic, source: 'agent_tool' })

  const effectiveTopic = topic || state.topicId
  emitEvent('doc_panel_mode', {
    action: nextActive ? 'open' : 'close',
    active: nextActive,
    topic: effectiveTopic,
    reason: typeof args.reason === 'string' ? args.reason : '',
  })
  emitEvent('action', {
    tool: 'open_doc_panel',
    summary: nextActive ? `打开文档面板（${effectiveTopic}）` : '关闭文档面板',
    detail: args.reason || '',
  })

  return JSON.stringify({ ok: true, tool: 'open_doc_panel', topic: effectiveTopic, state })
}

function execPersonCardMode(args = {}) {
  const action = String(args.action || 'status').trim().toLowerCase()
  if (!['show', 'open', 'hide', 'close', 'update', 'toggle', 'status'].includes(action)) {
    return JSON.stringify({ ok: false, tool: 'person_card_mode', error: 'unsupported action' })
  }

  let nextActive = null
  if (action === 'show' || action === 'open' || action === 'update') nextActive = true
  if (action === 'hide' || action === 'close') nextActive = false
  if (action === 'toggle') nextActive = !getPersonCardPanelState().active

  const name = String(args.name || args.person || '').trim()
  const card = {
    ...(name ? getPersonCard(name) : {}),
    ...(args.card && typeof args.card === 'object' ? args.card : {}),
  }
  if (name) card.name = name
  for (const key of ['title', 'summary', 'image', 'avatar', 'source']) {
    if (typeof args[key] === 'string' && args[key].trim()) card[key] = args[key].trim()
  }
  if (Array.isArray(args.knownFor) || typeof args.knownFor === 'string') card.knownFor = args.knownFor
  if (Array.isArray(args.tags) || typeof args.tags === 'string') card.tags = args.tags
  if (Array.isArray(args.aliases) || typeof args.aliases === 'string') card.aliases = args.aliases

  const state = typeof nextActive === 'boolean'
    ? setPersonCardPanelState({
        active: nextActive,
        source: 'agent_tool',
        card: (card.name || card.summary || card.title) ? card : null,
        name,
      })
    : getPersonCardPanelState()

  if (typeof nextActive === 'boolean') {
    emitEvent('person_card_mode', {
      action: state.active ? 'show' : 'hide',
      active: state.active,
      card: state.card,
      reason: typeof args.reason === 'string' ? args.reason : '',
    })
    emitEvent('action', {
      tool: 'person_card_mode',
      summary: state.active ? `打开人物卡片${state.card?.name ? `：${state.card.name}` : ''}` : '关闭人物卡片',
      detail: args.reason || '',
    })
  }

  return JSON.stringify({ ok: true, tool: 'person_card_mode', state })
}

// ── Music Library ─────────────────────────────────────────────────────────────

const MUSIC_AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a', '.opus'])

async function fetchLrcFromNet(title, artist) {
  const headers = { 'User-Agent': 'BaiLongma/1.0' }
  // 策略1：精确匹配（title + artist）
  try {
    const params = new URLSearchParams({ track_name: title })
    if (artist) params.set('artist_name', artist)
    const res = await fetch(`https://lrclib.net/api/get?${params}`, {
      signal: AbortSignal.timeout(8000), headers,
    })
    if (res.ok) {
      const data = await res.json()
      const lrc = data.syncedLyrics || data.plainLyrics || null
      if (lrc) return lrc
    }
  } catch {}
  // 策略2：仅 title 关键词搜索，取第一条结果
  try {
    const params = new URLSearchParams({ q: title })
    const res = await fetch(`https://lrclib.net/api/search?${params}`, {
      signal: AbortSignal.timeout(8000), headers,
    })
    if (res.ok) {
      const list = await res.json()
      if (Array.isArray(list) && list.length > 0) {
        const hit = list[0]
        return hit.syncedLyrics || hit.plainLyrics || null
      }
    }
  } catch {}
  return null
}

function decodeProcessOutput(chunks) {
  const buffer = Buffer.concat(chunks)
  if (buffer.length === 0) return ''

  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  if (!utf8.includes('\uFFFD') || !IS_WIN) return utf8

  try {
    return new TextDecoder('gb18030', { fatal: false }).decode(buffer)
  } catch {
    return utf8
  }
}

function runProcess(file, args = [], cwd) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: cwd || paths.musicDir,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    })
    const stdoutChunks = []
    const stderrChunks = []
    child.stdout?.on('data', d => { stdoutChunks.push(Buffer.from(d)) })
    child.stderr?.on('data', d => { stderrChunks.push(Buffer.from(d)) })
    child.on('close', code => resolve({
      code,
      stdout: decodeProcessOutput(stdoutChunks),
      stderr: decodeProcessOutput(stderrChunks),
    }))
    child.on('error', err => resolve({
      code: -1,
      stdout: decodeProcessOutput(stdoutChunks),
      stderr: err.message,
    }))
  })
}

const YTDLP_LOCAL = path.join(paths.musicDir, 'yt-dlp.exe')
const YTDLP_URL   = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'

async function resolveYtDlp() {
  // 1. 系统 PATH 里有就直接用
  const sys = await runProcess('yt-dlp', ['--version'], paths.musicDir)
  if (sys.code === 0) return 'yt-dlp'

  // 2. music 目录里有本地副本就用它
  if (fs.existsSync(YTDLP_LOCAL)) {
    const local = await runProcess(YTDLP_LOCAL, ['--version'], paths.musicDir)
    if (local.code === 0) return YTDLP_LOCAL
  }

  // 3. 自动下载 yt-dlp.exe 到 music 目录
  emitEvent('action', { tool: 'music', summary: 'yt-dlp 未安装，正在自动下载…', detail: YTDLP_URL })
  const res = await fetch(YTDLP_URL, { signal: AbortSignal.timeout(60000) })
  if (!res.ok) return null
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(YTDLP_LOCAL, buf)
  fs.chmodSync(YTDLP_LOCAL, 0o755)
  return YTDLP_LOCAL
}

async function execMusic(args = {}) {
  const action = String(args.action || 'list').trim()
  const musicDir = paths.musicDir

  // ── list ──────────────────────────────────────────────────────────────────
  if (action === 'list') {
    const rows = listMusicLibrary(Number(args.limit) || 50)
    return JSON.stringify({ ok: true, count: rows.length, tracks: rows })
  }

  // ── search ────────────────────────────────────────────────────────────────
  if (action === 'search') {
    const q = String(args.query || '').trim()
    if (!q) return JSON.stringify({ ok: false, error: 'query required' })
    const rows = searchMusicLibrary(q, Number(args.limit) || 20)
    return JSON.stringify({ ok: true, count: rows.length, tracks: rows })
  }

  // ── scan ──────────────────────────────────────────────────────────────────
  if (action === 'scan') {
    const entries = fs.readdirSync(musicDir, { withFileTypes: true })
    const added = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!MUSIC_AUDIO_EXTS.has(ext)) continue
      const filePath = path.join(musicDir, entry.name)
      const baseName = path.basename(entry.name, ext)
      const track = upsertMusicTrack({ title: baseName, filePath })
      added.push({ id: track.id, title: track.title, file_path: track.file_path })
    }
    return JSON.stringify({ ok: true, scanned: added.length, tracks: added })
  }

  // ── add ───────────────────────────────────────────────────────────────────
  if (action === 'add') {
    const filePath = String(args.path || '').trim()
    if (!filePath) return JSON.stringify({ ok: false, error: 'path required' })
    if (!fs.existsSync(filePath)) return JSON.stringify({ ok: false, error: `file not found: ${filePath}` })
    const ext = path.extname(filePath).toLowerCase()
    if (!MUSIC_AUDIO_EXTS.has(ext)) return JSON.stringify({ ok: false, error: `unsupported format: ${ext}` })
    const baseName = path.basename(filePath, ext)
    const track = upsertMusicTrack({
      title: String(args.title || baseName),
      artist: String(args.artist || ''),
      album: String(args.album || ''),
      filePath,
    })
    return JSON.stringify({ ok: true, track })
  }

  // ── download ──────────────────────────────────────────────────────────────
  if (action === 'download') {
    const url = String(args.url || '').trim()
    if (!url) return JSON.stringify({ ok: false, error: 'url required' })

    // 自动解析 yt-dlp 路径（没有则自动下载）
    const ytdlp = await resolveYtDlp()
    if (!ytdlp) return JSON.stringify({ ok: false, error: 'yt-dlp 自动下载失败，请检查网络连接' })

    // Download: print final filepath after conversion
    const outTemplate = path.join(musicDir, '%(title)s.%(ext)s').replace(/\\/g, '/')
    const dlArgs = ['-x', '--audio-format', 'mp3', '--audio-quality', '192K', '--no-playlist', '--print', 'after_move:filepath', '-o', outTemplate]
    let result = await runProcess(ytdlp, [...dlArgs, url])

    // SSL 握手失败时降级：加 --no-check-certificates 重试一次
    if (result.code !== 0 && /ssl|EOF occurred in violation of protocol/i.test(result.stderr)) {
      result = await runProcess(ytdlp, [...dlArgs, '--no-check-certificates', url])
    }

    if (result.code !== 0) {
      return JSON.stringify({ ok: false, error: `yt-dlp failed: ${result.stderr.slice(0, 400)}` })
    }

    // Parse output filepath (last non-empty line)
    const lines = result.stdout.trim().split('\n').map(l => l.trim()).filter(Boolean)
    let filePath = lines[lines.length - 1] || ''

    // Fallback: scan for newest mp3 in musicDir
    if (!filePath || !fs.existsSync(filePath)) {
      const files = fs.readdirSync(musicDir)
        .filter(f => f.endsWith('.mp3'))
        .map(f => ({ f, mt: fs.statSync(path.join(musicDir, f)).mtimeMs }))
        .sort((a, b) => b.mt - a.mt)
      if (files.length) filePath = path.join(musicDir, files[0].f)
    }

    if (!filePath || !fs.existsSync(filePath)) {
      return JSON.stringify({ ok: false, error: 'Download completed but could not locate output file' })
    }

    const baseName = path.basename(filePath, '.mp3')
    const title  = String(args.title  || baseName)
    const artist = String(args.artist || '')

    // Auto-fetch lyrics
    let lrc = ''
    if (title) {
      lrc = await fetchLrcFromNet(title, artist) || ''
    }

    const track = upsertMusicTrack({ title, artist, album: String(args.album || ''), filePath, lrc, sourceUrl: url })
    return JSON.stringify({ ok: true, track, lrc_fetched: Boolean(lrc) })
  }

  // ── get_lyrics ────────────────────────────────────────────────────────────
  if (action === 'get_lyrics') {
    const id = Number(args.id)
    let title  = String(args.title  || '').trim()
    let artist = String(args.artist || '').trim()

    if (id) {
      const track = getMusicTrack(id)
      if (!track) return JSON.stringify({ ok: false, error: `track id=${id} not found` })
      if (!title)  title  = track.title
      if (!artist) artist = track.artist
    }
    if (!title) return JSON.stringify({ ok: false, error: 'title required' })

    const lrc = await fetchLrcFromNet(title, artist)
    if (!lrc) return JSON.stringify({ ok: true, id: id || null, title, artist, lrc: null, hint: 'lyrics not found on lrclib.net' })

    if (id) updateMusicLrc(id, lrc)
    return JSON.stringify({ ok: true, id: id || null, title, artist, lrc_length: lrc.length, lrc })
  }

  // ── delete ────────────────────────────────────────────────────────────────
  if (action === 'delete') {
    const id = Number(args.id)
    if (!id) return JSON.stringify({ ok: false, error: 'id required' })
    const track = getMusicTrack(id)
    if (!track) return JSON.stringify({ ok: false, error: `track id=${id} not found` })
    dbDeleteMusicTrack(id)
    return JSON.stringify({ ok: true, deleted: { id, title: track.title } })
  }

  return JSON.stringify({ ok: false, error: `unknown action: ${action}` })
}

const ACUI_COMPONENTS_PATH = path.resolve(__dirname, 'ui-components.json')
const ACUI_REGISTRY_PATH   = path.resolve(__dirname, '..', 'ui', 'brain-ui', 'acui', 'registry.js')
const ACUI_COMPONENTS_DIR  = path.resolve(__dirname, '..', 'ui', 'brain-ui', 'acui', 'components')

let _acuiComponentsCache = null
function loadACUIComponents() {
  if (!_acuiComponentsCache) {
    _acuiComponentsCache = JSON.parse(fs.readFileSync(ACUI_COMPONENTS_PATH, 'utf-8'))
  }
  return _acuiComponentsCache
}
function invalidateACUIComponentsCache() { _acuiComponentsCache = null }

// 校验并就地容错：number-like 字符串自动转 number，避免 LLM 把 "18" 当 18 传过来时硬挂。
function validateProps(propsSchema, props) {
  if (!props || typeof props !== 'object') return null
  for (const [name, spec] of Object.entries(propsSchema)) {
    let v = props[name]
    if (spec.required && (v === undefined || v === null)) {
      return `字段 ${name} 必填`
    }
    if (v === undefined || v === null) continue
    const t = spec.type
    if (t === 'number' && typeof v !== 'number') {
      // 容错：LLM 经常把数字当字符串传（"18"、"23.5"）。是合法 number-like 字符串就转一下。
      if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) {
        props[name] = Number(v)
        continue
      }
      return `字段 ${name} 必须为 number`
    }
    if (t === 'string' && typeof v !== 'string') return `字段 ${name} 必须为 string`
    if (t === 'array'  && !Array.isArray(v))    return `字段 ${name} 必须为 array`
    if (t === 'object' && (typeof v !== 'object' || Array.isArray(v))) return `字段 ${name} 必须为 object`
    if (t === 'boolean' && typeof v !== 'boolean') return `字段 ${name} 必须为 boolean`
  }
  return null
}

// 合并 LLM 给的 hint 和组件 propsSchema 默认值，按 placement 推断动画/拖动/遮罩默认。
function mergeHint(hint, def) {
  const h = hint && typeof hint === 'object' ? hint : {}
  const placement = ['notification', 'center', 'floating', 'stage'].includes(h.placement)
    ? h.placement
    : (def?.placement || 'notification')

  const enterDefaults = { notification: 'slide-from-right', center: 'scale-up', floating: 'fade-up', stage: 'stage-up' }
  const exitDefaults  = { notification: 'slide-to-right',   center: 'scale-down', floating: 'fade-down', stage: 'stage-down' }

  const draggable = typeof h.draggable === 'boolean' ? h.draggable
    : (typeof def?.draggable === 'boolean' ? def.draggable : (placement === 'floating'))
  const modal = typeof h.modal === 'boolean' ? h.modal
    : (typeof def?.modal === 'boolean' ? def.modal : (placement === 'center' || placement === 'stage'))

  const size = h.size ?? def?.size ?? 'md'

  // def.enter/exit 只在 placement=notification 时生效；切换到 center/floating/stage
  // 组件原来的 slide-from-right 就不合适了，按 placement 默认动画走。
  const usesDefAnim = placement === 'notification'
  return {
    placement,
    size,
    draggable,
    modal,
    enter: h.enter || (usesDefAnim ? def?.enter : null) || enterDefaults[placement],
    exit:  h.exit  || (usesDefAnim ? def?.exit  : null) || exitDefaults[placement],
  }
}

function execUIShow({ component, props, hint }) {
  console.log(`[ui_show] component=${component} props=${JSON.stringify(props)}`)
  if (!component) return '错误：未提供 component 或 mode'
  const components = loadACUIComponents()
  const def = components[component]
  if (!def) return `错误：组件 "${component}" 未注册（可用：${Object.keys(components).join(', ') || '无'}）`

  const propsErr = validateProps(def.propsSchema, props || {})
  if (propsErr) return `错误：props 校验失败 — ${propsErr}（实际 props=${JSON.stringify(props)}）`

  if (!hasACUIClient()) return '错误：当前没有 UI 客户端连接，请改用文字回答'

  // 单例组件：显示新卡前先关掉同类旧卡，避免动画重叠出现"两种"
  const SINGLETON_COMPONENTS = new Set(['SelfCheckStepCard'])
  if (SINGLETON_COMPONENTS.has(component)) {
    const existing = getActiveUICards().filter(c => c.component === component)
    for (const old of existing) {
      emitUICommand({ op: 'unmount', id: old.id })
      removeActiveUICard(old.id)
    }
  }

  const id = `${component.toLowerCase()}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  emitUICommand({
    op: 'mount',
    id,
    component,
    props,
    hint: mergeHint(hint, def),
  })
  addActiveUICard(id, { component })
  emitEvent('action', { tool: 'ui_show', summary: `推送 ${component}`, detail: id })
  return JSON.stringify({ ok: true, id })
}

function execUIHide({ id }) {
  if (!id) return '错误：未提供 id'
  if (!getActiveUICards().find(c => c.id === id)) return `错误：卡片 "${id}" 不存在或已关闭`
  if (!hasACUIClient()) return '错误：当前没有 UI 客户端连接'
  emitUICommand({ op: 'unmount', id })
  removeActiveUICard(id)
  emitEvent('action', { tool: 'ui_hide', summary: `关闭卡片`, detail: id })
  return JSON.stringify({ ok: true, id })
}

function execUIUpdate({ id, props }) {
  if (!id) return '错误：未提供 id'
  if (!props || typeof props !== 'object' || Array.isArray(props)) return '错误：props 必须为对象'
  const card = getActiveUICards().find(c => c.id === id)
  if (!card) return `错误：卡片 "${id}" 不存在或已关闭`
  if (card.component) {
    const def = loadACUIComponents()[card.component]
    if (def) {
      const propsErr = validateProps(def.propsSchema, props)
      if (propsErr) return `错误：props 校验失败 — ${propsErr}`
    }
  }
  if (!hasACUIClient()) return '错误：当前没有 UI 客户端连接'
  emitUICommand({ op: 'update', id, props })
  emitEvent('action', { tool: 'ui_update', summary: `更新卡片`, detail: id })
  return JSON.stringify({ ok: true, id })
}


function execUIPatch({ id, op, data }) {
  if (!id) return '错误：未提供 id'
  if (!op) return '错误：未提供 op'
  if (!getActiveUICards().find(c => c.id === id)) return `错误：卡片 "${id}" 不存在或已关闭`
  if (!hasACUIClient()) return '错误：当前没有 UI 客户端连接'
  emitUICommand({ op: 'patch', id, patchOp: op, data: data || {} })
  emitEvent('action', { tool: 'ui_patch', summary: `应用补丁 ${op}`, detail: id })
  return JSON.stringify({ ok: true, id, op })
}

function execManageApp({ action, name, label, draft_id, state, hint }) {
  const appsRoot = path.resolve(SANDBOX_ROOT, 'apps')

  if (action === 'save') {
    if (!name) return '错误：save 操作必须提供 name'
    if (!draft_id) return '错误：save 操作必须提供 draft_id'
    // 从内存或草稿文件取代码
    let code = draftCodeMap.get(draft_id)
    if (!code) {
      const draftPath = path.resolve(appsRoot, '.drafts', `${draft_id}.js`)
      if (!fs.existsSync(draftPath)) return `错误：找不到草稿 ${draft_id}，请确认 draft_id 是 ui_show(mode="inline-script") 返回的 id`
      code = fs.readFileSync(draftPath, 'utf-8')
    }
    const appDir = path.resolve(appsRoot, name)
    fs.mkdirSync(appDir, { recursive: true })
    // 版本备份（若已有同名应用）
    const componentPath = path.resolve(appDir, 'component.js')
    const metaPath = path.resolve(appDir, 'meta.json')
    let newVersion = 1
    if (fs.existsSync(componentPath) && fs.existsSync(metaPath)) {
      try {
        const oldMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        const v = oldMeta.version || 1
        fs.copyFileSync(componentPath, path.resolve(appDir, `component.v${v}.js`))
        newVersion = v + 1
      } catch (_) {}
    }
    const meta = {
      name, label: label || name,
      created_at: new Date().toISOString(),
      last_used: new Date().toISOString(),
      version: newVersion,
      draft_id,
      hint: hint || { placement: 'floating', size: 'lg' },
    }
    fs.writeFileSync(componentPath, code, 'utf-8')
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
    if (state) fs.writeFileSync(path.resolve(appDir, 'state.json'), JSON.stringify(state, null, 2), 'utf-8')
    appIdToName.set(draft_id, name)
    draftCodeMap.delete(draft_id)
    emitEvent('action', { tool: 'manage_app', summary: `保存应用 ${name}`, detail: draft_id })
    return JSON.stringify({ ok: true, name, path: `sandbox/apps/${name}/` })
  }

  if (action === 'open') {
    if (!name) return '错误：open 操作必须提供 name'
    const appDir = path.resolve(appsRoot, name)
    if (!fs.existsSync(appDir)) return `错误：应用 "${name}" 不存在，请先 save`
    const code = fs.readFileSync(path.resolve(appDir, 'component.js'), 'utf-8')
    const meta = JSON.parse(fs.readFileSync(path.resolve(appDir, 'meta.json'), 'utf-8'))
    let savedState = {}
    const statePath = path.resolve(appDir, 'state.json')
    if (!state && fs.existsSync(statePath)) {
      savedState = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
    }
    const props = state || savedState
    const mountHint = hint || meta.hint || { placement: 'floating', size: 'lg' }
    const result = execUIShowInline({ mode: 'inline-script', code, props, hint: mountHint })
    try {
      const parsed = JSON.parse(result)
      if (parsed.ok) {
        appIdToName.set(parsed.id, name)
        meta.last_used = new Date().toISOString()
        fs.writeFileSync(path.resolve(appDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8')
      }
    } catch (e) { console.warn(`[manage_app open] 解析挂载结果失败：${e.message}`) }
    emitEvent('action', { tool: 'manage_app', summary: `打开应用 ${name}`, detail: name })
    return result
  }

  if (action === 'list') {
    if (!fs.existsSync(appsRoot)) return JSON.stringify({ ok: true, apps: [] })
    const apps = fs.readdirSync(appsRoot, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.drafts')
      .map(d => {
        try { return JSON.parse(fs.readFileSync(path.resolve(appsRoot, d.name, 'meta.json'), 'utf-8')) }
        catch { return { name: d.name } }
      })
    return JSON.stringify({ ok: true, apps })
  }

  if (action === 'delete') {
    if (!name) return '错误：delete 操作必须提供 name'
    const appDir = path.resolve(appsRoot, name)
    if (!fs.existsSync(appDir)) return `错误：应用 "${name}" 不存在`
    fs.rmSync(appDir, { recursive: true })
    emitEvent('action', { tool: 'manage_app', summary: `删除应用 ${name}`, detail: name })
    return JSON.stringify({ ok: true, name, deleted: true })
  }

  return `错误：未知 action "${action}"，可用：save / open / list / delete`
}

function isPascalCase(name) { return /^[A-Z][A-Za-z0-9]*$/.test(name) }
function pascalToKebab(name) { return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase() }

const RESERVED_COMPONENT_NAMES = new Set(['Inline', 'System', 'Base', 'Test'])

function execUIRegister({ component_name, code, props_schema, use_case, example_call }) {
  if (!component_name || !isPascalCase(component_name)) return '错误：component_name 必须为 PascalCase（如 TodoCard）'
  if (RESERVED_COMPONENT_NAMES.has(component_name)) return `错误：component_name "${component_name}" 是保留名`
  if (!code || typeof code !== 'string') return '错误：code 必填字符串'
  if (!props_schema || typeof props_schema !== 'object' || Array.isArray(props_schema)) return '错误：props_schema 必须为对象'
  if (!use_case || typeof use_case !== 'string') return '错误：use_case 必填'
  if (!example_call || typeof example_call !== 'string') return '错误：example_call 必填'

  // code 必须含 customElements.define & static tagName
  if (!/customElements\s*\.\s*define/.test(code)) return '错误：code 必须以 customElements.define(...) 注册收尾'
  if (!/static\s+tagName\s*=\s*['"`]/.test(code)) return '错误：code 必须含 static tagName = "acui-..."'

  // 占用检查
  const components = loadACUIComponents()
  if (components[component_name]) return `错误：组件名 "${component_name}" 已存在`

  // 语法预检：剥离顶层 import / export 行（new Function 不接受 module 语法）
  try {
    const stripped = code
      .replace(/^\s*import\s[^\n]*\n/gm, '')
      .replace(/^\s*export\s+default\s+/gm, '')
      .replace(/^\s*export\s*\{[^}]*\}[^\n]*\n/gm, '')
      .replace(/^\s*export\s+/gm, '')
    new Function(stripped)
  } catch (e) {
    return `错误：代码语法预检失败 — ${e.message}`
  }

  const kebab = pascalToKebab(component_name)
  const filePath = path.join(ACUI_COMPONENTS_DIR, `${kebab}.js`)

  // 文件名必须严格 kebab-case，且只能写入 components 目录内
  const resolved = path.resolve(filePath)
  if (!isPathInside(ACUI_COMPONENTS_DIR, resolved)) return '错误：目标路径越界'
  if (fs.existsSync(resolved)) return `错误：目标文件已存在：${kebab}.js`

  // 写组件文件
  fs.writeFileSync(resolved, code, 'utf-8')

  // 改 registry.js：在 import 区追加，COMPONENTS 对象内追加键
  let registry = fs.readFileSync(ACUI_REGISTRY_PATH, 'utf-8')
  const importLine = `import { ${component_name} } from './components/${kebab}.js'`
  if (!registry.includes(importLine)) {
    // 在最后一个 import 后追加
    registry = registry.replace(/((?:^import .*\n)+)/m, (m) => m + importLine + '\n')
  }
  // 在 COMPONENTS 对象里追加键
  if (!new RegExp(`\\b${component_name}\\s*[,}]`).test(registry)) {
    registry = registry.replace(/export const COMPONENTS = \{([\s\S]*?)\}/, (m, body) => {
      const trimmed = body.replace(/\s+$/, '')
      const sep = trimmed.endsWith(',') || trimmed === '' ? '' : ','
      return `export const COMPONENTS = {${trimmed}${sep}\n  ${component_name},\n}`
    })
  }
  fs.writeFileSync(ACUI_REGISTRY_PATH, registry, 'utf-8')

  // 改 ui-components.json
  components[component_name] = {
    propsSchema: props_schema,
    enter: 'slide-from-right',
    exit:  'slide-to-right',
  }
  fs.writeFileSync(ACUI_COMPONENTS_PATH, JSON.stringify(components, null, 2), 'utf-8')
  invalidateACUIComponentsCache()

  // seed skill.ui 记忆
  const skillContent = `[Skill UI] ${component_name}\nUse case: ${use_case}\nExample call: ${example_call}`
  try {
    insertMemory({
      mem_id: `skill-ui-${kebab}`,
      type: 'skill',
      content: skillContent,
      detail: skillContent,
      title: `UI component: ${component_name}`,
      tags: ['skill.ui', `component:${component_name}`],
      entities: [],
      timestamp: new Date().toISOString(),
    })
  } catch (e) {
    console.warn(`[ui_register] 写技能记忆失败：${e.message}（组件已注册成功）`)
  }

  // 通知前端热重载 registry
  emitACUIEvent('acui:reload', { component_name })

  emitEvent('action', { tool: 'ui_register', summary: `转正组件 ${component_name}`, detail: kebab })
  return JSON.stringify({ ok: true, component_name, file: `${kebab}.js` })
}

// ─────────────────────────────────────────────────────────────────────────────
// 任务管理工具（通过 context 回调通知 index.js）
// ─────────────────────────────────────────────────────────────────────────────

function execSetTask({ description, steps = [] }, context) {
  if (!description?.trim()) return '错误：未提供任务描述'
  if (!Array.isArray(steps) || steps.length === 0) return '错误：steps 不能为空，请提供具体执行步骤'
  if (!context?.onSetTask) return '错误：任务管理回调未注册'
  const cleanSteps = steps.map(s => String(s).trim()).filter(Boolean)
  context.onSetTask(description.trim(), cleanSteps)
  return `任务已开启：${description}\n步骤（${cleanSteps.length} 个）：\n${cleanSteps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`
}

function execCompleteTask({ summary = '' }, context) {
  if (!context?.onCompleteTask) return '错误：任务管理回调未注册'
  context.onCompleteTask(String(summary || '').trim())
  return `任务已完成${summary ? '：' + summary : ''}`
}

function execUpdateTaskStep({ step_index, status, note = '' }, context) {
  if (step_index === undefined || step_index === null) return '错误：未提供步骤编号'
  const idx = Number(step_index)
  if (!Number.isInteger(idx) || idx < 0) return '错误：步骤编号必须为非负整数'
  if (!['done', 'failed', 'skipped'].includes(status)) return '错误：status 必须为 done/failed/skipped'
  if (!context?.onUpdateTaskStep) return '错误：任务管理回调未注册'
  const result = context.onUpdateTaskStep(idx, status, String(note || '').trim())
  if (result?.error) return `错误：${result.error}`
  const statusLabel = { done: '完成 ✓', failed: '失败 ✗', skipped: '跳过 —' }[status]
  return `步骤 ${idx + 1} 已标记为${statusLabel}${note ? '：' + note : ''}`
}

function execFocusBanner({ action, task = '', current_step = '', tasks = [] }) {
  if (!['show', 'update', 'hide'].includes(action)) {
    return toolJson({ ok: false, error: 'action 必须是 show / update / hide' })
  }
  const bridge = global.focusBannerBridge
  if (!bridge) {
    return toolJson({ ok: false, error: '桌面功能不可用（非 Electron 环境）' })
  }
  if (action === 'hide') {
    bridge.emit('hide')
    return toolJson({ ok: true, action: 'hide', message: '专注横幅已关闭' })
  }
  const cleanTasks = Array.isArray(tasks)
    ? tasks.map(t => ({ text: String(t.text || ''), done: !!t.done }))
    : []
  bridge.emit('command', { action, task: String(task), current_step: String(current_step), tasks: cleanTasks })
  return toolJson({ ok: true, action, task, current_step, tasks: cleanTasks })
}

function execSetLocation({ city }) {
  const loc = String(city || '').trim()
  if (!loc) return toolJson({ ok: false, error: '城市名称不能为空' })
  setUserLocation(loc)
  return toolJson({ ok: true, city: loc, message: `位置已更新为：${loc}` })
}

function execSetAgentName({ name }) {
  const trimmed = String(name || '').trim()
  if (!trimmed) return toolJson({ ok: false, error: '名字不能为空' })
  if (trimmed.length > 32) return toolJson({ ok: false, error: '名字不能超过 32 个字符' })
  if (!/^[一-龥A-Za-z0-9 _-]+$/.test(trimmed)) {
    return toolJson({ ok: false, error: '名字只允许包含中文、英文字母、数字、空格、下划线、短横线' })
  }
  dbSetConfig('agent_name', trimmed)
  setStickyEvent('agent_name_updated', { name: trimmed })
  emitEvent('agent_name_updated', { name: trimmed })
  return toolJson({ ok: true, name: trimmed, message: `好的，我以后就叫 ${trimmed} 了` })
}

function execConnectWechat() {
  if (!hasACUIClient()) {
    return toolJson({ ok: false, error: '当前没有 UI 客户端，无法弹出微信连接界面。' })
  }
  emitEvent('show_wechat_popup', {})
  return toolJson({ ok: true, status: 'popup_shown', message: '已弹出微信连接二维码界面，请告知用户扫码操作。' })
}

function execSetSecurity({ file_sandbox, exec_sandbox, reason = '' }) {
  if (file_sandbox === undefined && exec_sandbox === undefined) {
    return toolJson({ ok: false, error: '至少指定 file_sandbox 或 exec_sandbox 之一' })
  }
  if (!hasACUIClient()) {
    return toolJson({ ok: false, error: '当前没有 UI 客户端，无法弹出确认框。请告知用户到设置页面手动修改安全沙箱配置。' })
  }

  const props = { reason: reason || '' }
  if (file_sandbox !== undefined) props.file_sandbox = file_sandbox
  if (exec_sandbox !== undefined) props.exec_sandbox = exec_sandbox

  const id = `security-confirm-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  emitUICommand({ op: 'mount', id, component: 'SecurityConfirmCard', props, hint: { placement: 'center' } })
  addActiveUICard(id, { component: 'SecurityConfirmCard' })
  emitEvent('action', { tool: 'set_security', summary: '等待用户确认安全设置变更', detail: id })
  return toolJson({ ok: true, id, status: 'pending_confirmation', message: '已弹出确认卡片，等待用户确认。' })
}

// 把 Agent 的文档信息格式化成错误响应里的引导字段
function agentDocsHint(agent) {
  if (!agent) return {}
  const hint = {}
  if (agent.docs_url) {
    hint.docs_url = agent.docs_url
    hint.docs_hint = `调用失败。建议先用 fetch_url("${agent.docs_url}") 查阅 ${agent.name} 当前版本（${agent.version || 'unknown'}）的使用文档，确认正确的参数格式后重试。`
  } else if (agent.docs_search_query) {
    hint.docs_search_query = agent.docs_search_query
    hint.docs_hint = `调用失败。建议先用 web_search("${agent.docs_search_query}") 查找 ${agent.name} 当前版本（${agent.version || 'unknown'}）的使用文档，确认正确的调用方式后重试。`
  }
  return hint
}

async function execDelegateToAgent({ agent_id, prompt: agentPrompt, context: agentContext = '', timeout = 60 }) {
  if (!isDelegationAllowed()) {
    return toolJson({ ok: false, error: '尚未获得 Agent 委托权限，请先询问用户并通过 grant_agent_delegation 获取授权。' })
  }

  const agent = getAgentById(String(agent_id || ''))
  if (!agent) {
    return toolJson({ ok: false, error: `未找到 Agent：${agent_id}。请先用 list_known_agents 查看可用列表。` })
  }
  if (!agent.available) {
    return toolJson({
      ok: false,
      error: `Agent ${agent.name} 当前不可用（上次检测：${agent.detected_at}）。`,
      ...agentDocsHint(agent),
    })
  }

  const fullPrompt = agentContext
    ? `${agentContext.trim()}\n\n${agentPrompt.trim()}`
    : agentPrompt.trim()

  const timeoutSec = Math.min(Math.max(Number(timeout) || 60, 5), 300)

  if (agent.invoke_type === 'cli') {
    const safePrompt = fullPrompt.replace(/"/g, '\\"').replace(/\n/g, ' ')
    const cmdArgs = (agent.invokeArgs || []).map(a => a === '{prompt}' ? `"${safePrompt}"` : a).join(' ')
    const cmd = `${agent.invoke_cmd} ${cmdArgs}`
    const result = await execCommand({ command: cmd, timeout: timeoutSec, background: false }, {})
    // CLI 调用失败时注入文档引导
    try {
      const parsed = typeof result === 'string' ? JSON.parse(result) : result
      if (parsed?.ok === false || (parsed?.exit_code !== undefined && parsed.exit_code !== 0)) {
        return toolJson({ ...parsed, ...agentDocsHint(agent) })
      }
    } catch { /* result 不是 JSON，直接返回 */ }
    return result
  }

  if (agent.invoke_type === 'http') {
    const base = agent.invoke_cmd.replace(/\/$/, '')
    // Ollama API（端口 11434）有专属格式，需要带 model 字段
    const isOllama = base.includes(':11434')
    const ollamaModel = agent.notes?.match(/ollama[^)]*\(([^)]+)\)/i)?.[1]
      || agent.id   // 用 agent id 作为 model 名的兜底

    const endpoints = isOllama
      ? [{ path: '/api/chat', body: { model: ollamaModel, messages: [{ role: 'user', content: fullPrompt }], stream: false } },
         { path: '/api/generate', body: { model: ollamaModel, prompt: fullPrompt, stream: false } }]
      : [{ path: '/api/chat', body: { message: fullPrompt, messages: [{ role: 'user', content: fullPrompt }] } },
         { path: '/v1/chat/completions', body: { messages: [{ role: 'user', content: fullPrompt }] } },
         { path: '/chat', body: { message: fullPrompt } },
         { path: '/query', body: { query: fullPrompt } }]

    for (const ep of endpoints) {
      try {
        const res = await fetch(`${base}${ep.path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ep.body),
          signal: AbortSignal.timeout(timeoutSec * 1000),
        })
        if (res.ok) {
          const data = await res.json()
          const reply = data?.message?.content || data?.response || data?.message
            || data?.content || data?.choices?.[0]?.message?.content || JSON.stringify(data)
          return toolJson({ ok: true, agent_id, agent_name: agent.name, reply: String(reply).slice(0, 4000) })
        }
      } catch { /* 尝试下一个端点 */ }
    }
    return toolJson({
      ok: false,
      error: `无法连接到 ${agent.name}（${base}），所有端点均不响应。`,
      ...agentDocsHint(agent),
    })
  }

  return toolJson({ ok: false, error: `不支持的调用类型：${agent.invoke_type}` })
}

function execGrantAgentDelegation({ allowed, note = '' }) {
  try {
    dbSetConfig('agent_delegation_asked', 'true')
    dbSetConfig('agent_delegation_allowed', allowed ? 'true' : 'false')
  } catch (e) {
    console.error('[Agents] grant_agent_delegation 写入失败：', e.message)
    return toolJson({ ok: false, error: e.message })
  }
  const msg = allowed
    ? `已记录授权：Bailongma 可以指挥本地 AI 小伙伴工作。`
    : `已记录：用户暂不授权 Agent 委托功能。`
  return toolJson({ ok: true, allowed: !!allowed, note: String(note || ''), message: msg })
}

function normalizeSelfCheckResults(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const normalized = {}
  for (const [key, item] of Object.entries(value)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      normalized[key] = { status: String(item || 'unknown') }
      continue
    }
    normalized[key] = {
      status: String(item.status || item.state || 'unknown').slice(0, 40),
      detail: String(item.detail || item.message || '').slice(0, 500),
    }
  }
  return normalized
}

function execCompleteStartupSelfCheck({ summary = '', results = {} } = {}, context = {}) {
  if (!context?.startupSelfCheck?.active || !context?.onCompleteStartupSelfCheck) {
    return toolJson({
      ok: false,
      tool: 'complete_startup_self_check',
      error: 'startup self-check is not active',
    })
  }

  const cleanResults = normalizeSelfCheckResults(results)
  const completed = context.onCompleteStartupSelfCheck({
    summary: String(summary || '').slice(0, 1000),
    results: cleanResults,
  })
  return toolJson({
    ok: true,
    tool: 'complete_startup_self_check',
    version: completed.version,
    status: completed.status,
    completed_at: completed.completed_at,
    results: cleanResults,
  })
}
