export function trimAssistantFluff(content) {
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

function compactReplyLine(line) {
  return String(line || '')
    .trim()
    .replace(/^[`'"“”‘’]+|[`'"“”‘’。.!！?？,，:：;；\s]+$/g, '')
    .replace(/\s+/g, ' ')
}

function normalizePathEcho(line) {
  return compactReplyLine(line)
    .replace(/`/g, '')
    .replace(/[\\\/]+/g, '/')
    .toLowerCase()
}

function lineFingerprint(line) {
  return compactReplyLine(line)
    .replace(/[`'"“”‘’。.!！?？,，:：;；、\s]/g, '')
    .toLowerCase()
}

function charSimilarity(a, b) {
  const left = new Set([...lineFingerprint(a)])
  const right = new Set([...lineFingerprint(b)])
  if (!left.size || !right.size) return 0
  let overlap = 0
  for (const ch of left) if (right.has(ch)) overlap++
  return overlap / Math.max(left.size, right.size)
}

const NEAR_DUPLICATE_ANCHORS = [
  '\u767d\u9f99\u9a6c',
  'bailongma',
  '\u5b98\u7f51',
  '\u7f51\u7ad9',
  'agent',
  'ai',
  '\u535a\u5ba2',
  '\u6587\u6863',
  'github',
  '\u4e0b\u8f7d',
  '\u5165\u53e3',
  '\u8bb0\u5fc6',
  '\u56fe\u8c31',
  '\u4ea7\u54c1',
  '\u9875\u9762',
]

function meaningFingerprint(line) {
  return compactReplyLine(line)
    .toLowerCase()
    .replace(/bailongma/g, '\u767d\u9f99\u9a6c')
    .replace(/ai\s*agent/g, 'agent')
    .replace(/[\s`'"“”‘’、。?!？！；;：:，,（）()【】[\]《》<>「」『』\-—_]/g, '')
}

function meaningSimilarity(a, b) {
  const left = new Set([...meaningFingerprint(a)])
  const right = new Set([...meaningFingerprint(b)])
  if (!left.size || !right.size) return 0
  let overlap = 0
  for (const ch of left) if (right.has(ch)) overlap++
  return overlap / Math.max(left.size, right.size)
}

function sharedAnchorCount(a, b) {
  const left = compactReplyLine(a).toLowerCase().replace(/bailongma/g, '\u767d\u9f99\u9a6c')
  const right = compactReplyLine(b).toLowerCase().replace(/bailongma/g, '\u767d\u9f99\u9a6c')
  return NEAR_DUPLICATE_ANCHORS.filter(anchor => left.includes(anchor) && right.includes(anchor)).length
}

function isStructuredLine(line) {
  return /^\s*(?:[-*]|\d+[.)]|#{1,6}\s|```)/.test(String(line || ''))
}

function isNearDuplicateReplyLine(previousLine, line) {
  const previous = compactReplyLine(previousLine)
  const current = compactReplyLine(line)
  if (previous.length < 18 || current.length < 18) return false
  if (previous.length > 260 || current.length > 260) return false
  if (isStructuredLine(previousLine) || isStructuredLine(line)) return false
  const anchors = sharedAnchorCount(previousLine, line)
  if (anchors < 2) return false
  const similarity = meaningSimilarity(previousLine, line)
  return similarity >= 0.66 || (anchors >= 5 && similarity >= 0.5)
}

function preferCurrentReplyLine(previousLine, line) {
  const previous = compactReplyLine(previousLine)
  const current = compactReplyLine(line)
  const previousScore = previous.length + sharedAnchorCount(previousLine, previousLine) * 12
  const currentScore = current.length + sharedAnchorCount(line, line) * 12
  return currentScore >= previousScore
}

function isPathOnlyLine(line) {
  const normalized = normalizePathEcho(line)
  return /^[a-z]:\/[^<>|?*\r\n]+$/i.test(normalized) || /^\/[^<>|?*\r\n]+$/.test(normalized)
}

export function dedupeReplyLines(content) {
  const lines = String(content || '').split(/\r?\n/)
  const result = []
  let previousCompact = ''

  for (const line of lines) {
    const compact = compactReplyLine(line)
    if (!compact) {
      result.push(line)
      continue
    }

    const previousLine = result.length ? result[result.length - 1] : ''
    const previousPath = normalizePathEcho(previousLine)
    const currentPath = normalizePathEcho(line)

    if (compact === previousCompact) continue

    if (isPathOnlyLine(previousLine) && currentPath.includes(previousPath) && currentPath.length > previousPath.length) {
      result[result.length - 1] = line
      previousCompact = compact
      continue
    }

    if (previousCompact && isNearDuplicateReplyLine(previousLine, line)) {
      if (preferCurrentReplyLine(previousLine, line)) {
        result[result.length - 1] = line
        previousCompact = compact
      }
      continue
    }

    if (previousCompact && compact.length <= 180 && previousCompact.length <= 180 && charSimilarity(previousLine, line) >= 0.78) {
      continue
    }

    result.push(line)
    previousCompact = compact
  }

  return result.join('\n').trim()
}

function sentenceSplit(text) {
  return String(text || '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .split(/(?<=[。！？!?])\s*|\n+/)
    .map(s => s.trim())
    .filter(Boolean)
}

function isExplicitDetailRequest(text = '') {
  return /(详细|展开|列出|清单|配置|参数|端口|技术栈|命令|步骤|完整|全部|逐项|日志|原文|明细|说了什么|讲了什么|内容|文章|博客|list|detail|config|step)/i.test(String(text || ''))
}

function isMeaningOrStatusRequest(text = '') {
  return /(是什么|像什么|状态|怎么样|跑着什么|算活着|正常|有没有问题|干嘛|意味着|关系|现在|这个东西|这个项目|这个文件|这个页面|这个网站|服务器|电脑|机器|产品|官网|入口|本体)/i.test(String(text || ''))
}

function looksLikeInventory(text = '') {
  const value = String(text || '')
  return value.length > 260
    || /\n\s*(?:[-*]|\d+[.)]|#{1,6}\s|\*\*[^*]+\*\*)/.test(value)
    || /(核心应用|阿里云全家桶|PM2|Nginx|Next\.js|Docker|端口|worker|进程|内存|CPU|sandbox|文件沙箱)/i.test(value)
}

function firstUsefulSentences(text, max = 2) {
  const preferred = sentenceSplit(text)
    .filter(s => !/^(我来|让我|先|当前|另外还有|如果这个文件|要不要|你想让我|你能给我|Docker 和端口|docker 和端口)/i.test(s))
    .filter(s => /(正常|在线|稳定|稳|跑着|就是|像|应该|大概率|状态|入口|外壳|本体|官网|产品|活着|够不到|看不到|沙箱)/i.test(s))

  const picked = (preferred.length ? preferred : sentenceSplit(text)).slice(0, max)
  return picked.join('').trim()
}

function stripMarkdownInventory(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter(line => !/^\s*(?:[-*]|\d+[.)]|#{1,6}\s)/.test(line))
    .filter(line => !/^\s*\*\*[^*]+\*\*\s*$/.test(line))
    .join('\n')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim()
}

export function compactMeaningFirstReply(content, { userMessage = '', channel = '' } = {}) {
  let text = dedupeReplyLines(trimAssistantFluff(content))
  if (!text) return text

  const user = String(userMessage || '')
  const isVoice = /voice|语音|語音/i.test(String(channel || ''))
  if (isExplicitDetailRequest(user)) return text

  if (/服务器/.test(user) && /(next\.js|pm2|nginx|ecs|阿里云|白龙马|bailongma|官网|博客)/i.test(text)) {
    if (/(白龙马|bailongma|官网|博客)/i.test(text)) {
      return '上面跑的是白龙马官网和博客，服务正常；这基本就是它对外露面的地方。'
    }
    return '上面跑着一个网站服务，Nginx 和 PM2 在守着；看起来是白龙马的对外入口。'
  }

  if (/bailongma|白龙马/i.test(user) && /(sandbox|沙箱|看不到|没找到|够不到|限制)/i.test(text)) {
    return '我现在被沙箱挡在外面，不能直接打开；但 BaiLongma 这个名字指向的就是它自己的本体项目。'
  }

  if (/activation\.html/i.test(user) && /(sandbox|沙箱|看不到|没找到|够不到|限制)/i.test(text)) {
    return '我现在还够不到这个页面；从名字看，它像产品激活入口，是第一次把它接进系统的那道门。'
  }

  if (/(算活着|活着吗)/.test(user)) {
    if (/(跑着|在线|正常|稳定|200|可访问)/i.test(text)) {
      return '算活着。它在响应、运行，也和当前系统发生着关系。'
    }
    return '要看它有没有响应。如果只是文件躺着，那还只是躯壳；能运行、能被访问，才算活起来。'
  }

  if (text.length <= 140 && !/\n\s*(?:[-*]|\d+[.)]|#{1,6}\s|\*\*[^*]+\*\*)/.test(text)) return text
  if (!isVoice && !isMeaningOrStatusRequest(user) && !looksLikeInventory(text)) return text

  text = stripMarkdownInventory(text)
  const compact = firstUsefulSentences(text, isVoice ? 2 : 2)
  if (!compact) return text
  return compact.length > 180 ? `${compact.slice(0, 176)}...` : compact
}

export function requiresToolForUserMessage(text = '') {
  const input = String(text || '')
  const fileIntent = /(sandbox|文件|目录|创建|新建|写入|读取|删除|列出|保存|test-\d+|\.txt|\.json|\.md|\.js|\.html|\.css)/i.test(input)
    && /(创建|新建|写入|读取|删除|列出|保存|改|修改|生成|create|write|read|delete|list|save)/i.test(input)
  const commandIntent = /(执行命令|运行命令|跑命令|exec|command|npm|node|git|powershell|cmd)/i.test(input)
  const webIntent = /(打开网页|抓取|联网|搜索|查询最新|fetch|url|https?:\/\/)/i.test(input)
  return fileIntent || commandIntent || webIntent
}
