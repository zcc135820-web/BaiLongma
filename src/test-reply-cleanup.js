// Run: node src/test-reply-cleanup.js

import {
  compactMeaningFirstReply,
  dedupeReplyLines,
  requiresToolForUserMessage,
  trimAssistantFluff,
} from './runtime/reply-cleanup.js'

let failed = 0
function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    failed++
    process.exitCode = 1
    console.error(`FAIL: ${label}`)
    console.error(`  expected: ${JSON.stringify(expected)}`)
    console.error(`  actual:   ${JSON.stringify(actual)}`)
  } else {
    console.log(`PASS: ${label}`)
  }
}

function assert(cond, label) {
  if (!cond) {
    failed++
    process.exitCode = 1
    console.error(`FAIL: ${label}`)
  } else {
    console.log(`PASS: ${label}`)
  }
}

assertEqual(
  trimAssistantFluff('[assistant to ID:000001 2026-05-25T10:00:00+08:00] 已完成，随时为您效劳！'),
  '已完成',
  'trimAssistantFluff removes assistant envelope and service-tail fluff',
)

assertEqual(
  trimAssistantFluff('文件已经写入。有什么需要我帮忙的？'),
  '文件已经写入',
  'trimAssistantFluff removes trailing helper question',
)

assertEqual(
  dedupeReplyLines('D:\\work\\demo\nD:\\work\\demo\\result.txt'),
  'D:\\work\\demo\\result.txt',
  'dedupeReplyLines replaces path-only echo with more specific path',
)

assertEqual(
  dedupeReplyLines('已经保存到 sandbox/test.txt。\n已保存到 sandbox/test.txt'),
  '已经保存到 sandbox/test.txt。',
  'dedupeReplyLines removes highly similar adjacent lines',
)

assert(
  requiresToolForUserMessage('帮我创建 sandbox/test-1.txt 并写入 hello'),
  'requiresToolForUserMessage detects file write intent',
)

assert(
  requiresToolForUserMessage('执行命令 git status'),
  'requiresToolForUserMessage detects command intent',
)

assert(
  requiresToolForUserMessage('搜索最新 OpenAI API 文档'),
  'requiresToolForUserMessage detects web/search intent',
)

assert(
  !requiresToolForUserMessage('今天心情不错，闲聊两句'),
  'requiresToolForUserMessage ignores casual chat',
)

assertEqual(
  dedupeReplyLines(
    '\u6211\u6765\u770b\u770b\u4e0a\u9762\u8dd1\u7684\u662f\u4ec0\u4e48\u7f51\u7ad9\u3002\n' +
    '\u662f\u767d\u9f99\u9a6c\u7684\u5b98\u7f51\u3002\u4e00\u4e2a AI Agent \u7684\u4ea7\u54c1\u9875\u9762\uff0c\u8bb2\u7684\u662f\u5b83\u80fd\u8bb0\u4f4f\u3001\u80fd\u6309\u9700\u60f3\u8d77\u3001\u80fd\u6301\u7eed\u8fd0\u884c\u3002\u4e0a\u9762\u6709\u535a\u5ba2\u533a\u548c\u6587\u6863\u533a\uff0c\u8fd8\u6709 GitHub \u94fe\u63a5\u548c\u4e00\u4e2a\u4e0b\u8f7d\u5165\u53e3\u3002\u6574\u4f53\u5c31\u662f\u4f60\u81ea\u5df1\u7684\u9879\u76ee\u5b98\u7f51\u3002\n' +
    'BaiLongma \u7684\u5b98\u7f51\u3002\u4e00\u4e2a AI Agent \u4ea7\u54c1\u7ad9\uff0c\u6709\u535a\u5ba2\u3001\u6587\u6863\u3001\u4e0b\u8f7d\u5165\u53e3\uff0c\u8fd8\u6709\u4e2a\u201c\u8bb0\u5fc6\u56fe\u8c31\u201d\u7684\u53ef\u89c6\u5316\u52a8\u6548\u3002\u6574\u4f53\u8bbe\u8ba1\u7406\u5ff5\u662f\u201c\u4e00\u5207\u7686\u8bb0\u5fc6\uff0cAgent \u4f1a\u957f\u51fa\u81ea\u5df1\u7684\u5f62\u72b6\u201d\u3002\u5c31\u662f\u4f60\u73b0\u5728\u5728\u7528\u7684\u8fd9\u4e2a\u7cfb\u7edf\u672c\u8eab\u7684\u5b98\u7f51\u3002'
  ),
  '\u6211\u6765\u770b\u770b\u4e0a\u9762\u8dd1\u7684\u662f\u4ec0\u4e48\u7f51\u7ad9\u3002\n' +
  'BaiLongma \u7684\u5b98\u7f51\u3002\u4e00\u4e2a AI Agent \u4ea7\u54c1\u7ad9\uff0c\u6709\u535a\u5ba2\u3001\u6587\u6863\u3001\u4e0b\u8f7d\u5165\u53e3\uff0c\u8fd8\u6709\u4e2a\u201c\u8bb0\u5fc6\u56fe\u8c31\u201d\u7684\u53ef\u89c6\u5316\u52a8\u6548\u3002\u6574\u4f53\u8bbe\u8ba1\u7406\u5ff5\u662f\u201c\u4e00\u5207\u7686\u8bb0\u5fc6\uff0cAgent \u4f1a\u957f\u51fa\u81ea\u5df1\u7684\u5f62\u72b6\u201d\u3002\u5c31\u662f\u4f60\u73b0\u5728\u5728\u7528\u7684\u8fd9\u4e2a\u7cfb\u7edf\u672c\u8eab\u7684\u5b98\u7f51\u3002',
  'dedupeReplyLines collapses adjacent near-duplicate website summaries',
)

assertEqual(
  compactMeaningFirstReply(
    '47.106.176.212 这台阿里云服务器上跑着这些东西：\n\n**核心应用**\n- **Next.js 15.4.11** — 一个 Node.js 前端应用，由 PM2 守护\n- **Nginx** — 两个 worker 进程\n\n基本上就是一台标准的阿里云 ECS，跑着一个 Next.js 站点，nginx 反代 + PM2 守护。',
    { userMessage: '你看看我的服务器现在跑着什么？' },
  ),
  '上面跑着一个网站服务，Nginx 和 PM2 在守着；看起来是白龙马的对外入口。',
  'compactMeaningFirstReply turns server inventory into status and meaning',
)

assertEqual(
  compactMeaningFirstReply(
    'sandbox 里没有 BaiLongma 文件夹。\n\n你想看的应该是 C:\\Users\\xiaoy\\AppData\\Roaming\\Bailongma。当前沙箱开着，我看不到外面的东西。要关掉沙箱让我进去瞧瞧吗？',
    { userMessage: '你看看这个 BaiLongma 文件夹是什么？' },
  ),
  '我现在被沙箱挡在外面，不能直接打开；但 BaiLongma 这个名字指向的就是它自己的本体项目。',
  'compactMeaningFirstReply handles sandbox blocker without process chatter',
)

assertEqual(
  compactMeaningFirstReply(
    '服务器上也没找到 activation.html。sandbox 里也没有。这个文件大概率在你本地电脑上，但我的文件沙箱还开着，只能看 sandbox 子目录。',
    { userMessage: '这个 activation.html 页面对产品来说像什么？' },
  ),
  '我现在还够不到这个页面；从名字看，它像产品激活入口，是第一次把它接进系统的那道门。',
  'compactMeaningFirstReply preserves product meaning when evidence is blocked',
)

assertEqual(
  compactMeaningFirstReply(
    '博客上有三篇文章，全是产品思考类，目前都还是待发布状态：\n- 第一篇讲记忆系统\n- 第二篇讲 Agent 的身体\n- 第三篇讲持续运行',
    { userMessage: '那你看看上面的那些博客，他说了什么', channel: '语音识别' },
  ),
  '博客上有三篇文章，全是产品思考类，目前都还是待发布状态：\n- 第一篇讲记忆系统\n- 第二篇讲 Agent 的身体\n- 第三篇讲持续运行',
  'compactMeaningFirstReply does not strip requested article summaries',
)

if (failed === 0) {
  console.log('\nAll reply-cleanup checks complete.')
} else {
  console.log(`\n${failed} reply-cleanup check(s) failed.`)
}
