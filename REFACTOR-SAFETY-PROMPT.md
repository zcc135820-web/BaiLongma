# BaiLongma 安全重构提示词

用途：后续每次让 AI 或人工代理执行模块拆分时，先使用这份提示词，确保目标是“拆结构，不改行为”。

## 通用提示词

```text
你正在 BaiLongma 项目的 `refactor/module-split` 分支上做代码模块拆分重构。

最高优先级目标：在不改变现有功能、运行行为、工具协议、API 响应结构、数据库语义、UI 交互和启动路径的前提下，把大文件拆成更细粒度的功能模块。

绝对约束：
1. 不要顺手改业务逻辑，除非当前步骤已经证明不修会导致拆分后无法运行，并且必须单独说明。
2. 不要修改用户体验、文案、视觉样式、模型提示词语义、工具返回格式、API JSON shape、数据库字段含义。
3. 不要删除现有导出。需要迁移时，先在旧文件保留 facade/re-export，保证旧 import 继续工作。
4. 不要做大规模格式化，不要把纯搬迁 diff 搅成全文重排。
5. 不要覆盖或回滚工作区里已有的未提交改动。动手前必须检查 `git status --short --branch`。
6. 不要使用破坏性 git 命令，例如 `git reset --hard`、`git checkout -- <file>`。
7. 不要把多个重构目标混在一次改动里。每次只拆一个清晰边界。
8. 不要改变 security/sandbox 行为。文件工具、命令工具、LAN/token 权限、敏感路径保护必须保持原样。
9. 不要改变数据库 migration 的幂等性。旧安装和新安装都必须能启动。
10. 不要改变 `send_message`、fallback reply、TTS 自动播放、消息写库、社交渠道投递的行为链路。

开始前必须做：
1. 运行并记录：
   - `git branch --show-current`
   - `git status --short --branch`
2. 阅读当前要拆的源文件和调用点。
3. 写出本步边界：
   - 要拆什么
   - 不拆什么
   - 哪些 public exports 必须保持
   - 哪些 smoke/test 要跑

执行方式：
1. 优先新增小模块，把同一工具域或同一职责的 handler 移过去。
2. 旧文件先保留入口函数、注册表或 re-export。
3. 保持函数签名、参数名、返回值格式、错误文本和事件名不变。
4. 每移动一组函数，就检查所有 import 路径。
5. 如果移动过程中发现循环依赖，先停下来分析依赖方向，不要硬拆。
6. 如果发现必须改变行为才能继续，停止并汇报，不要擅自改。

验证要求：
- 工具执行器改动：`node --check` + `npm run smoke:tools`
- 前端 brain UI 改动：`npm run smoke:brain-ui`
- 社交/微信/外部渠道改动：`npm run smoke:social`
- 后端启动路径改动：`npm run start:backend` 或等价短时启动检查
- DB/migration 改动：用临时数据库或备份数据库验证新安装和旧数据启动

验收标准：
1. 测试或 smoke 通过；如果不能运行，必须明确原因。
2. `git diff` 显示的是结构拆分，不包含无关格式化或业务改动。
3. 新模块职责单一，命名清晰。
4. 旧 API/exports/imports 兼容。
5. 出现行为差异时，本步不算完成。
```

## 单步重构任务模板

```text
请在 BaiLongma 的 `refactor/module-split` 分支上执行一次小步安全重构。

本次目标：[填写一个非常具体的目标，例如：从 `src/capabilities/executor.js` 抽出 reminders 工具域到 `src/capabilities/tools/reminders.js`]

边界：
- 只搬迁/整理该目标相关代码。
- 不改变任何功能行为。
- 不改变工具返回值、API 响应、数据库语义、UI 文案。
- 保持旧入口兼容。

请先检查 git 状态，阅读相关调用点，说明计划，然后修改。修改后运行相关 smoke/test，并汇报结果。
```

## 代码审查检查清单

- 是否有无关格式化？
- 是否有文案、提示词、错误文本变化？
- 是否有 API JSON 字段变化？
- 是否有工具返回值 shape 或文本语义变化？
- 是否有数据库 schema/migration 非幂等风险？
- 是否有事件名、DOM id、localStorage key、config key 改名？
- 是否有 import 循环？
- 是否有启动顺序变化？
- 是否有异步时序变化，尤其是 abort/watchdog/preemption？
- 是否运行了与影响范围匹配的 smoke/test？

## 下一会话接手提示词

```text
你正在 BaiLongma 项目的 `refactor/module-split` 分支继续做安全模块拆分重构。

当前状态：
- 已完成基础 helper 拆分：`tool-policy.js`、`tool-audit.js`、`tool-utils.js`、`abort-utils.js`、`sandbox.js`。
- 已完成文件工具域拆分：`src/capabilities/tools/filesystem.js`。
- 已完成 shell 工具域拆分：`src/capabilities/tools/shell.js`。
- 已完成 web 工具域拆分：`src/capabilities/tools/web.js`，包含 `web_search`、`fetch_url`、`browser_read`、URL/search 缓存、web config 短缓存、文章落盘、搜索 provider/fallback、Playwright/Chromium 读取逻辑。
- 已完成 memory 工具域拆分：`src/capabilities/tools/memory.js`，包含 `search_memory`、`upsert_memory`、`merge_memories`、`recall_memory`、`downgrade_memory`、`skip_consolidation`、`skip_recognition`、记忆参数 JSON 兼容解析、识别器/记忆写入辅助逻辑、`memory_consolidated` 事件和相关 `db.js` 记忆函数 import。
- `src/capabilities/executor.js` 仍保留对外入口 `executeTool`、`autoSpeakForVoiceReply`、`persistAppState`，并继续作为工具调度门面。
- 版本已升到 `2.1.187`，安装包 `dist/Bailongma-Setup-2.1.187.exe` 已验证。
- 最新推送 commit：`03ddaf8`，分支：`origin/refactor/module-split`。
- 当前本地有未提交改动：memory 工具域拆分、版本号 `2.1.187`、文档更新；不要覆盖或回滚。

已验证：
- `git diff --check` 通过。
- `node --check` 覆盖 `src` 下 119 个 JS/MJS，通过。
- `npm run smoke:tools` 6/6 passed。
- `npm run smoke:brain-ui` passed。
- 本地 mock `executeTool('fetch_url', ...)` 调用通过。
- Electron Node 路径下最小 memory 工具调用通过：`executeTool('search_memory', { keywords: '["BaiLongma"]' })` 和 `executeTool('skip_recognition', { reason: 'syntax check' })`。
- 标准 build 脚本成功，packaged/installed `better-sqlite3` 均为 Electron ABI 130。
- 安装版 `/status` HTTP 200。
- 安装版真实链路验证通过：`/message` + `/events`、`fetch_url`、`browser_read`、`web_search`、前台 shell、后台进程、list、kill、安全拦截均通过。

已知非回归：
- 本地 Node CLI 下 `better-sqlite3` ABI 130/127 mismatch 是已知非回归，不要当成本次重构问题。

本次任务：
继续拆 `src/capabilities/executor.js`，优先把 reminders 工具域拆到 `src/capabilities/tools/reminders.js`。

建议包含：
- `schedule_reminder`
- `manage_reminder`
- 一次性提醒创建/取消/查询逻辑
- 周期提醒时间解析与下一次触发时间计算
- 提醒目标用户解析、`buildSystemMessage` 相关 helper
- `reminder_created` 事件保持不变
- 与 `db.js` 提醒函数相关的 import 移动

硬约束：
- 只做结构拆分，不改行为。
- 不改变工具名、参数、返回 JSON/text shape、错误文案、安全策略、事件名。
- 保留 `executor.js` 对外入口兼容。
- 不覆盖或回滚已有改动；开始前先运行 `git status --short --branch`。
- 如果遇到循环依赖或必须改变行为才能继续，停止并说明，不要硬拆。

验证：
- 先跑相关 `node --check`。
- 必须跑 `npm run smoke:tools`。
- 建议手动用 `executeTool('manage_reminder' ...)` 或等价路径做最小 reminders 工具调用验证，尽量使用不会污染真实提醒队列的只读/错误路径；如果必须写入，说明原因并清理或取消测试提醒。
- 如果涉及打包/启动路径，再跑标准 build 并验证安装版 `/status`。
```
