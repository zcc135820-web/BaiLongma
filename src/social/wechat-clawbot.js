import { WeChatClient } from 'wechat-ilink-client'
import { getClawbotCredentials, setClawbotCredentials, clearClawbotCredentials } from '../config.js'

let client = null
let currentQrUrl = null   // set during login, cleared after scan
let clawbotStatus = 'idle' // idle | qr_pending | connected | error

// Called by dispatch.js to send replies back to WeChat
export async function sendClawbotMessage(userId, content) {
  if (!client || clawbotStatus !== 'connected') {
    return { ok: false, reason: 'wechat-clawbot not connected' }
  }
  try {
    await client.sendText(userId, content)
    return { ok: true, platform: 'wechat-clawbot' }
  } catch (err) {
    console.error(`[ClawBot] sendText 失败: ${err.message}`)
    return { ok: false, error: err.message }
  }
}

// Called by api.js for GET /social/wechat-clawbot/qr
export function getClawbotQR() {
  return { status: clawbotStatus, qr_url: currentQrUrl }
}

// Called by api.js for POST /social/wechat-clawbot/logout
export function logoutClawbot() {
  clearClawbotCredentials()
  clawbotStatus = 'idle'
  currentQrUrl = null
  try { client?.stop?.() } catch {}
  client = null
}

export function startClawbotConnector({ pushMessage, emitEvent } = {}) {
  const saved = getClawbotCredentials()

  client = new WeChatClient(saved ? {
    accountId: saved.accountId,
    token: saved.botToken,
    baseUrl: saved.baseUrl,
  } : {})

  client.on('message', (msg) => {
    const text = WeChatClient.extractText?.(msg) ?? extractText(msg)
    if (!text) return
    const fromId = `wechat:clawbot:${msg.from_user_id}`
    pushMessage(fromId, text, 'WECHAT_CLAWBOT', {
      social: { platform: 'wechat-clawbot', user_id: msg.from_user_id },
    })
    emitEvent?.('message_in', {
      from_id: fromId,
      content: text,
      channel: 'WECHAT_CLAWBOT',
      timestamp: new Date().toISOString(),
    })
  })

  client.on('error', (err) => {
    console.error(`[ClawBot] 错误: ${err.message}`)
    emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'error', error: err.message })
  })

  client.on('sessionExpired', () => {
    console.warn('[ClawBot] 会话已过期，请重新扫码登录')
    clearClawbotCredentials()
    clawbotStatus = 'idle'
    emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'session_expired' })
  })

  if (!saved) {
    // 首次登录：发起扫码流程
    clawbotStatus = 'qr_pending'
    console.log('[ClawBot] 未找到已保存凭证，开始扫码登录...')
    emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'qr_pending' })

    client.login({
      onQRCode(url) {
        currentQrUrl = url
        clawbotStatus = 'qr_ready'
        console.log(`[ClawBot] 二维码已就绪，请在设置面板扫码`)
        emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'qr_ready', qr_url: url })
      },
    }).then(result => {
      currentQrUrl = null
      // wechat-ilink-client 的 login() 在超时/取消等情况下不会 reject，
      // 而是 resolve 一个 { connected: false, message } —— 必须显式检查 connected 字段，
      // 否则会误把超时当成扫码成功，UI 卡在虚假的"已连接"
      if (!result?.connected || !result?.accountId || !result?.botToken) {
        clawbotStatus = 'idle'
        const reason = result?.message || '未知原因'
        console.warn(`[ClawBot] 扫码登录未完成: ${reason}`)
        emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'idle', reason })
        return
      }
      clawbotStatus = 'connected'
      setClawbotCredentials({
        accountId: result.accountId,
        botToken: result.botToken,
        baseUrl: result.baseUrl,
      })
      console.log(`[ClawBot] 扫码登录成功，已保存凭证`)
      emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'connected', accountId: result.accountId })
      client.start().catch(err => console.error(`[ClawBot] start 失败: ${err.message}`))
    }).catch(err => {
      clawbotStatus = 'error'
      console.error(`[ClawBot] 扫码登录失败: ${err.message}`)
      emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'error', error: err.message })
    })
  } else {
    // 凭证已存，直接启动
    clawbotStatus = 'connected'
    console.log(`[ClawBot] 使用已保存凭证启动（accountId: ${saved.accountId}）`)
    emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'connected', accountId: saved.accountId })
    client.start().catch(err => {
      // start 失败说明凭证已失效或后端连不上 —— 必须同步把内存状态打回去，
      // 否则 popup 查询时仍会拿到 'connected'，UI 显示"已连接"但实际啥都不通
      clawbotStatus = 'error'
      console.error(`[ClawBot] start 失败: ${err.message}`)
      emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'error', error: err.message })
    })
  }

  return {
    platform: 'wechat-clawbot',
    stop() {
      clawbotStatus = 'idle'
      try { client?.stop?.() } catch {}
    },
  }
}

// 从消息结构中提取文本（兼容 extractText 未导出的情况）
function extractText(msg) {
  if (!msg) return ''
  const items = msg.item_list || msg.itemList || []
  for (const item of items) {
    if (item.type === 1 || item.type === 'text') {
      return item.text_item?.text || item.textItem?.text || ''
    }
  }
  return ''
}
