// Focus Stack —— 动态上下文记忆池架构第 3b 步（多帧栈 + 回归判断）
//
// 设计原则（来自 DynamicMemoryPool.md 3.1 ~ 3.5）：
//   - 「专注」是连续判断的副产品，不是事件触发的开关。
//   - 当焦点在某个话题上稳定一段时间 = 自然形成一帧；漂移 = 自然不再被选中 = 等于自动 pop。
//   - 用户和 Agent 都不主动声明「进入专注」。
//   - 子主题切换：push 新帧到栈顶；回到旧主题：pop 到对应帧（多帧 pop）。
//   - pop 出来的帧会进入压缩回填流水线（focus-compress.js），把那段时间的对话和工具调用压成
//     一句话结论，挂回到下一帧的 conclusions 列表，并沉淀到长期记忆。
//
// 不在本模块的职责：
//   - 持久化（栈是内存状态，不写 db）。
//   - 主动操作 memory visibility（剔除残留噪声）—— 第 3 步暂不做。
//   - LLM 调用（压缩回填在 focus-compress.js 里发起，本模块只产出 poppedFrames）。
//
// 注意：直接从 keywords.js 拿 extractKeywords，绕开 injector.js（避免拉起 SQLite）
// 这样 focus.js 可以在纯 Node 环境下被单元测试，不需要 better-sqlite3 native binding。
import { extractKeywords } from './keywords.js'

// 焦点失活阈值：lastSeenTick 超过这么多 tick 没被命中就 pop 栈顶。
export const FOCUS_FRAME_STALE_TICKS = 20

// 栈深上限。push 第 N+1 帧时，shift 出栈底那帧（也触发压缩回填）。
export const MAX_FOCUS_DEPTH = 4

// 单帧 conclusions 数量上限（滚动丢最旧）。
export const FRAME_CONCLUSIONS_LIMIT = 5

// 关键词最低门槛：少于这个数说明消息太空泛，不参与焦点判断。
const MIN_KEYWORDS_FOR_FRAME = 3   // 严格大于 2 → 至少 3 个

// 单帧 topic 关键词数量上限。
const TOPIC_KEYWORDS_LIMIT = 3

// 抽取关键词时给到 extractKeywords 的预算（适度宽一点便于做交集）。
const KEYWORD_EXTRACT_BUDGET = 8

// 太短的消息直接跳过焦点判断（裸字符长度，含格式头）。
const MIN_MESSAGE_LENGTH = 4

// 判断当前输入是不是 TICK。复用 injector 的同源识别。
function isTickMessage(message) {
  return typeof message === 'string' && /^TICK\s/i.test(message.trim())
}

// 从消息里拨开 [ID:xxx] 时间戳 [渠道] 这层壳，拿到消息正文。
// 仅供 focus 用——若解析失败，回退到整条消息。
function stripMessageEnvelope(message) {
  if (!message) return ''
  if (isTickMessage(message)) return ''
  const m = message.match(/^\[[^\]]+\]\s*[\d\-T:+]+\s*\[[^\]]*\]\s*(.*)$/s)
  return m ? m[1].trim() : message.trim()
}

// 工厂：新建一帧。startedAt 走 ISO 时间戳，给压缩回填按时间拉对话用。
function makeFrame(topic, tickCounter) {
  return {
    topic,
    startedAtTick: tickCounter,
    lastSeenTick: tickCounter,
    hitCount: 1,
    startedAt: new Date().toISOString(),
    conclusions: [],
  }
}

// 取栈顶（数组最后一个），栈空返回 null。
function topOf(stack) {
  return stack && stack.length > 0 ? stack[stack.length - 1] : null
}

// 判断关键词与某帧 topic 是否有交集（≥1 命中）。
function frameOverlap(frame, kws) {
  if (!frame || !Array.isArray(frame.topic) || frame.topic.length === 0) return 0
  const set = new Set(frame.topic)
  let n = 0
  for (const k of kws) {
    if (set.has(k)) n++
  }
  return n
}

// 确保 state.focusStack 存在；向后兼容：如果旧 state.focusFrame 残留也清掉。
function ensureStack(state) {
  if (!Array.isArray(state.focusStack)) {
    state.focusStack = []
  }
  // 把旧的 focusFrame 引用清掉，避免两套状态不一致
  if ('focusFrame' in state) {
    delete state.focusFrame
  }
}

/**
 * 更新 focus stack。直接 mutate state.focusStack。
 *
 * @param {object} state          — 进程级 state 对象（必须可写）
 * @param {string} message        — 当前 process 拿到的裸消息字符串
 * @param {object} ctx
 * @param {boolean} ctx.isTick    — 当前是不是 TICK 心跳
 * @param {number}  ctx.tickCounter — 当前 tickCounter（用作帧的时间轴）
 * @returns {{
 *   event: 'created' | 'kept' | 'pushed' | 'returned' | 'cleared' | 'noop',
 *   poppedFrames: object[]
 * }}
 *
 * 事件语义：
 *   - created  ：栈空，新建第一帧
 *   - kept     ：命中栈顶 topic，保持栈顶（更新 lastSeenTick / hitCount）
 *   - pushed   ：与栈中所有帧都无交集，push 新帧（子主题深化）
 *   - returned ：与栈中某个非栈顶帧有交集，pop 到那一帧（回归主线）
 *   - cleared  ：栈顶 idle 超过 FOCUS_FRAME_STALE_TICKS，pop 栈顶
 *   - noop     ：栈无变化（TICK 心跳、空消息、关键词太少等）
 *
 * poppedFrames：本次操作中被 pop / shift 出栈的帧（栈底先出，栈顶后出），
 *   传给上层做压缩回填。stale clear 也算进去。
 */
export function updateFocusFrame(state, message, { isTick = false, tickCounter = 0 } = {}) {
  if (!state) return { event: 'noop', poppedFrames: [] }
  ensureStack(state)

  // TICK：叶子心跳不该影响焦点。但可以触发 stale 清理。
  if (isTick) {
    return maybeClearStale(state, tickCounter)
  }

  // 太短 / 空消息：不动
  const body = stripMessageEnvelope(message)
  if (!body || body.length < MIN_MESSAGE_LENGTH) {
    return maybeClearStale(state, tickCounter)
  }

  // 抽关键词
  const kws = extractKeywords(body, KEYWORD_EXTRACT_BUDGET)
  // 关键词太少（≤2）= 太空泛，不动
  if (kws.length < MIN_KEYWORDS_FOR_FRAME) {
    return maybeClearStale(state, tickCounter)
  }

  // 栈空 → 创建第一帧
  if (state.focusStack.length === 0) {
    state.focusStack.push(makeFrame(kws.slice(0, TOPIC_KEYWORDS_LIMIT), tickCounter))
    return { event: 'created', poppedFrames: [] }
  }

  // 已有帧：先看栈顶
  const top = topOf(state.focusStack)
  if (frameOverlap(top, kws) >= 1) {
    top.lastSeenTick = tickCounter
    top.hitCount += 1
    return { event: 'kept', poppedFrames: [] }
  }

  // 与栈顶无交集 → 看栈中其他帧（回归判断）。
  // 从栈顶往栈底找：找到第一个与新关键词有交集的旧帧 = 回归该帧。
  // 注意：跳过栈顶（i = length - 2 起），栈顶已经检查过了。
  for (let i = state.focusStack.length - 2; i >= 0; i--) {
    if (frameOverlap(state.focusStack[i], kws) >= 1) {
      // 命中第 i 帧 → pop 到 i（保留 0..i，丢 i+1..length-1）
      // pop 顺序：从靠近栈底的先 pop 还是栈顶先 pop？这里栈顶先 pop（splice 后保留前缀，
      // 被截掉的部分按原栈位置顺序传给压缩回填——栈底先出，栈顶后出）
      const popped = state.focusStack.splice(i + 1)
      const newTop = state.focusStack[i]
      newTop.lastSeenTick = tickCounter
      newTop.hitCount += 1
      return { event: 'returned', poppedFrames: popped }
    }
  }

  // 栈中所有帧都无交集 → push 新帧（subtopic 深化）
  const newFrame = makeFrame(kws.slice(0, TOPIC_KEYWORDS_LIMIT), tickCounter)
  state.focusStack.push(newFrame)

  // 栈深超限 → shift 栈底，把它也送进压缩回填
  const poppedFrames = []
  while (state.focusStack.length > MAX_FOCUS_DEPTH) {
    const shifted = state.focusStack.shift()
    if (shifted) poppedFrames.push(shifted)
  }

  return { event: 'pushed', poppedFrames }
}

// 帧失活：太久没被命中就 pop 栈顶。栈非空时连锁 pop 栈顶（一次只 pop 一个，多 tick 多次 pop）。
function maybeClearStale(state, tickCounter) {
  ensureStack(state)
  const top = topOf(state.focusStack)
  if (!top) return { event: 'noop', poppedFrames: [] }
  const idle = tickCounter - top.lastSeenTick
  if (idle > FOCUS_FRAME_STALE_TICKS) {
    state.focusStack.pop()
    return { event: 'cleared', poppedFrames: [top] }
  }
  return { event: 'noop', poppedFrames: [] }
}

// 把 focusFrame 翻译成「人话」age 描述，供 <focus> 段用
export function describeFocusFrameAge(focusFrame, tickCounter = 0) {
  if (!focusFrame) return ''
  const since = Math.max(0, tickCounter - focusFrame.startedAtTick)
  const idle = Math.max(0, tickCounter - focusFrame.lastSeenTick)
  if (focusFrame.hitCount <= 1) {
    return 'just started focusing on this'
  }
  if (idle === 0) {
    return `${since} rounds since first seen, last seen this round`
  }
  return `${since} rounds since first seen, last seen ${idle} rounds ago`
}

// 便捷读取：取当前栈顶帧（向后兼容旧调用点）
export function getFocusFrame(state) {
  if (!state) return null
  return topOf(state.focusStack)
}
