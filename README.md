# OpenTeam

OpenTeam 是一个 Manifest V3 Chrome 浏览器扩展，用来把你已经拥有的 AI 网页账号，组织成一个「0 API token 的智能专家团」。

如果你已经是 ChatGPT、Claude、Gemini、DeepSeek 等 AI 网站的会员，或者你本来就在浏览器里使用这些 AI 网站，OpenTeam 可以直接复用这些网页会话来组织多角色讨论。它不要求你额外接 OpenAI API、Claude API 或其他模型 API，也不需要为每次讨论单独消耗 API token。

更重要的是，OpenTeam 不只是提供一个空白群聊框。项目已经内置 38 位专家 / 思想风格顾问模板，覆盖产品、管理、投资、创业、科学思维、心理成长、职业选择、未来趋势等方向。用户打开后就可以把这些「专家」加入群聊，让他们围绕同一个问题给出不同视角。

第三个关键价值是多模型互补。不同 AI 模型的能力、表达风格和判断倾向并不一样：同一个问题交给 Gemini、Claude、ChatGPT，得到的侧重点往往不同。OpenTeam 可以把这些模型放进同一个群聊里，让用户同时看到多个模型的评价，也可以让它们在群讨论模式里相互回应、补充和反驳。

它解决的不是「再做一个聊天框」的问题，而是解决一个更实际的工作流问题：当用户需要同时调用多个 AI、多个角色、多个视角来讨论一个复杂问题时，传统方式会变成大量切窗口、复制粘贴、整理上下文和手动汇总。OpenTeam 把这些分散的 AI 网页对话收进一个群聊式工作台，让用户可以像开会一样组织 AI 角色参与讨论。

核心价值：

> 复用你已有的 AI 网页账号和会员权益，用 0 API token 调度一组开箱即用的智能专家团。

简单说：

- 不需要额外配置模型 API Key。
- 不额外消耗 API token。
- 直接调度浏览器里的 AI 网页会话。
- 内置 38 位专家 / 思想风格顾问模板，可以直接组团讨论。
- 综合不同模型的能力，让 Gemini、Claude、ChatGPT 等模型从各自优势出发评价同一个问题。
- 支持群讨论模式，让不同模型和不同专家之间相互讨论，而不是只给出彼此孤立的答案。
- 一个问题，可以同时发给多个人员。
- 每个人员可以绑定独立的 AI 网页会话。
- 用户可以通过 `@人员` 定向提问；不 @ 时仅记录到群聊，不触发人员回复。
- 不同人员的回复会汇总到同一个群聊消息流。
- 群聊、人员、消息、笔记和高亮会持久化到本地。
- 用户可以在多个群聊之间切换，让不同讨论保持独立上下文。

## 为什么需要 OpenTeam

单个 AI 很适合回答问题，但复杂问题往往不缺一个「完整答案」，而缺多个角度的交叉判断。

更现实的问题是：很多用户已经为不同 AI 网站付费，或者已经习惯在网页端使用它们，但这些能力分散在不同页面里。OpenTeam 的第一价值，是把这些现成能力重新组织起来，让已有会员和网页账号发挥更大价值，而不是再让用户从零接一套 API。

OpenTeam 的第二个价值，是把「找谁来讨论」这件事也提前准备好。你不需要每次从零写提示词，也不需要临时设计一堆角色。项目内置了弗兰克尔、加缪、尼采、王阳明、乔布斯、稻盛和夫、德鲁克、芒格、巴菲特、达里奥、纳瓦尔、张一鸣、任正非、费曼、卡尼曼、塔勒布、贝佐斯、马斯克等专家 / 思想风格模板。它们不是冒充真人，而是作为基于公开思想框架整理出的顾问人设，帮助用户从不同维度审视问题。

OpenTeam 的第三个价值，是把不同模型的能力差异用起来。比如：

- Gemini 常适合处理长上下文、多模态材料、Google 生态信息和研究型任务。
- Claude 常适合处理长文档、复杂推理、代码审查、结构化写作和更审慎的表达。
- ChatGPT 常适合综合任务处理、工具化工作流、数据分析、文件和图片处理、创意生成与快速迭代。

这些不是固定排名，而是常见使用方向。不同模型的实际表现会随版本、会员权益、任务类型和输入材料变化。OpenTeam 的思路不是替用户判断哪个模型永远最好，而是把它们放到同一个讨论现场：让 Gemini 先从资料和上下文看问题，让 Claude 审查逻辑和风险，让 ChatGPT 给出综合方案和可执行步骤。用户看到的不是某一个模型的单点判断，而是一组模型共同形成的判断面。

例如：

- 做产品方案时，需要产品、工程、增长、反方同时评审。
- 做技术方案时，需要架构、实现、测试、风险一起审查。
- 做内容脚本时，需要策划、编辑、运营、读者视角共同打磨。
- 做个人决策时，需要长期主义、风险控制、职业发展、心理状态等不同视角。

如果手动完成这些事情，用户通常要：

1. 打开多个 AI 站点或多个会话。
2. 把同一个问题复制给不同 AI。
3. 等回复生成。
4. 把回复复制回一个文档或聊天框。
5. 再把某个角色的观点复制给另一个角色追问。

OpenTeam 的价值是把这套低效流程变成一个统一工作台：

- 用户负责提出问题和判断方向。
- OpenTeam 负责组织人员、分发 prompt、监听回复、汇总消息、保存上下文。
- AI 网站负责实际生成回复，用户复用自己已有的登录态、会员权益或网站可用额度。

## 适用场景

### 产品评审

创建一个「产品方案评审会」，加入产品经理、工程师、增长顾问、反方顾问。用户输入产品想法后，各人员从自己的职责出发并行分析。用户可以继续引用工程师的回复，让产品经理判断技术风险对产品路径的影响。

### 技术方案审查

创建一个「技术方案会」，加入架构师、前端工程师、后端工程师、测试和反方审查员。方案发出后，OpenTeam 可以收集可行性、边界条件、实现成本和潜在故障点。

### 内容创作

创建一个「选题策划会」，加入策划、编辑、运营、读者视角。用户输入主题后，不同人员分别产出角度、结构、标题、传播风险和理解障碍。

### 多模型对比

同一个群聊内的人员可以选择不同 AI 站点，例如 Gemini、ChatGPT、Claude、DeepSeek。用户可以把同一任务发给不同模型背后的人员，比较它们的回答质量和侧重点。

这个场景的关键优势是：OpenTeam 调度的是网页端 AI 会话，不是额外调用模型 API。用户可以复用已有 AI 网站会员和登录态，用 0 API token 完成多模型、多人员讨论。

例如，用户可以创建一个「产品上线评审会」：

- `Gemini 研究员`：负责根据长上下文资料、竞品信息和多模态材料梳理背景。
- `Claude 审查员`：负责审查方案逻辑、风险、边界条件和表达是否严谨。
- `ChatGPT 执行顾问`：负责把讨论结果整理成行动清单、里程碑、表格或汇报稿。

第一轮可以让它们各自独立评价，第二轮切到协作群聊模式，让 Claude 反驳 Gemini 的判断，让 ChatGPT 综合两边观点给出落地方案。这样用户看到的不只是三个答案，而是三个模型围绕同一个问题形成的讨论过程。

### 个人顾问团

人员库内置了一组思想风格模拟顾问，例如弗兰克尔、加缪、尼采、王阳明、乔布斯、德鲁克、芒格、巴菲特、达里奥、纳瓦尔、张一鸣等。它们不是冒充真人，而是作为固定提示词模板，为用户提供不同思想框架下的分析视角。

## 核心功能

### 1. 群聊工作台

OpenTeam 的主界面是 `team.html`，包含：

- 左侧群聊列表。
- 中间消息流。
- 下方输入框。
- 右侧人员面板。
- 背景层 AI iframe 工作区。
- 笔记面板和全部笔记入口。
- 设置入口和人员库弹窗。

用户可以创建多个群聊，并在左侧切换。每个群聊拥有独立的人员、消息、上下文和 iframe 组。

### 2. 两种讨论模式

OpenTeam 支持两种群聊模式：

- `independent`：独立专家模式。人员独立回答，不主动参考其他成员观点，适合初始评审和多视角对比。
- `collaborative`：协作群聊模式。人员会收到群聊成员列表和未同步上下文，可以参考、补充或反驳其他成员观点，适合连续讨论。

群讨论模式的价值在于：不同模型不只是并排输出答案，而是可以在共享上下文里形成接力讨论。比如 Gemini 提供资料分析，Claude 指出逻辑漏洞，ChatGPT 将分歧整理成下一步计划；下一轮用户可以继续追问其中一个模型，也可以让所有模型围绕新的分歧继续讨论。

对应 prompt 构建逻辑在 `src/group/promptBuilder.ts`。

### 3. 人员与人员库

OpenTeam 将「角色」在产品层表达为「人员」：

- 人员库人员：可复用的人设模板。
- 群聊内人员：加入某个群聊后的独立实例。

人员库模板加入群聊时会被复制为独立人员。后续人员库模板变更，不会自动影响已经加入群聊的人员。这能避免不同群聊之间的上下文和人设串联。

人员库支持：

- 查看内置人员和自定义人员。
- 搜索人员名称、描述或人设。
- 新建自定义人员。
- 编辑自定义人员。
- 删除未被群聊使用的自定义人员。
- 禁止编辑或删除系统内置人员。
- 为人员设置默认 AI 站点。
- 为 ChatGPT 人员配置可选 GPTs 链接前缀。

相关实现：

- `src/group/roleTemplates.ts`
- `src/group/builtinRoleTemplates.ts`
- `src/teamPage/peopleLibraryView.ts`
- `src/background/roleHandlers.ts`

### 4. 添加人员

当前群聊可以通过「添加人员」弹窗添加成员：

- 从人员库批量添加。
- 临时添加只属于当前群聊的人员。
- 为每个人员选择 AI 站点。
- 同名同站点人员在同一个群聊内不允许重复。

临时人员不会进入人员库，也不会保存为通用模板。

### 5. 多 AI 站点适配

当前代码支持以下 AI 站点类型：

- `gemini`：Gemini
- `chatgpt`：ChatGPT
- `claude`：Claude
- `deepseek`：DeepSeek

OpenTeam 的站点适配面向网页端会话：它把 prompt 填入对应 AI 网站页面，并监听网页回复。因此项目不需要用户配置模型 API Key，也不会额外消耗 API token。

站点适配器负责抽象不同 AI 网页的差异，包括：

- 定位输入框。
- 填入 prompt。
- 点击发送。
- 停止生成。
- 读取会话 URL 和会话 ID。
- 监听回复容器。
- 提取可上报的回复内容。

相关实现：

- `src/content/sites/index.ts`
- `src/content/sites/gemini.ts`
- `src/content/sites/chatgpt.ts`
- `src/content/sites/claude.ts`
- `src/content/sites/deepseek.ts`

### 6. @ 提及和消息路由

输入框支持三类消息：

```text
@工程师 请从实现角度看这个方案
```

发送给指定人员。

```text
@所有人 请分别指出这个方案最大的风险
```

发送给所有人员。

```text
这个方案两周内能上线吗？
```

不写 `@` 时，只作为群聊消息记录，不触发任何人员回复。

解析逻辑在 `src/group/mentionParser.ts`。为了支持同名但不同站点的人员，提及标签可以带站点信息，例如 `工程师（ChatGPT）`。

### 7. Prompt 构建和上下文同步

OpenTeam 不只是把用户输入原样转发给 AI，而是根据群聊模式、人员人设和上下文构造 prompt。

独立专家模式下，prompt 包含：

- 当前人员身份。
- 人员职责和人设。
- 用户消息。
- 可选引用消息。

协作群聊模式下，prompt 还会包含：

- 群聊成员列表。
- 该人员上次同步之后的新消息上下文。
- 引用消息。
- 补充或反驳其他成员观点的指令。

为了控制上下文长度，OpenTeam 会根据人员的 `contextCursor` 只同步该人员尚未看到的新消息，并使用 `settings.maxContextChars` 控制最大上下文字符数。

相关实现：

- `src/group/promptBuilder.ts`
- `src/group/contextSync.ts`
- `src/background/messageHandlers.ts`

### 8. iframe 背景工作区

OpenTeam 当前采用 iframe 团队页方案。

页面结构大致是：

```text
team.html
├── iframe-host       # 背景层，承载各群聊的 AI iframe
│   ├── chat A group
│   │   ├── role 1 iframe
│   │   └── role 2 iframe
│   └── chat B group
│       └── role 3 iframe
└── app-shell         # 前景层，承载群聊 UI
    ├── sidebar
    ├── messages
    ├── composer
    └── people drawer
```

这样做是为了解决早期「后台 inactive tab」方案的问题。后台 tab 容易被浏览器节流，AI 页面不一定持续渲染，content script 可能监听不到回复。iframe 方案把多个 AI 页面放在同一个可见扩展页面里，降低渲染被暂停的概率。

相关实现：

- `src/teamPage/iframeHost.ts`
- `src/content/frameHandshake.ts`
- `src/content/frameEnvironment.ts`
- `src/background/runtimeFrames.ts`

### 9. frame 绑定和运行时通信

每个群聊内人员需要绑定到一个具体 iframe。因为多个 iframe 可能处于同一个 `team.html` tab 中，只靠 `tabId` 不够，OpenTeam 使用：

```text
chatId + roleId           # 产品运行身份
tabId + frameId           # Chrome runtime 投递地址
```

绑定流程：

```text
team.html 创建 iframe
  -> postMessage(OPENTEAM_ASSIGN_FRAME_ROLE)
  -> iframe content script 收到 chatId / roleId
  -> content script 发送 TEAM_FRAME_ROLE_READY
  -> background 记录 tabId + frameId
  -> 群聊消息可以投递到该人员 iframe
```

主要协议定义在：

- `src/group/runtimeProtocol.ts`
- `src/teamPage/iframeHost.ts`
- `src/content/frameHandshake.ts`
- `src/background/runtimeFrames.ts`

### 10. 回复监听、去重和超时

content script 注入到 AI 网页后，会：

- 接收 background 下发的 `TEAM_SEND_PROMPT`。
- 等待短暂输入延迟，避免页面尚未 ready。
- 调用站点适配器填入并发送 prompt。
- 使用回复观察器监听 AI 输出。
- 在回复稳定后上报给 background。
- 记录会话 URL 和会话 ID。
- 支持停止生成和重新同步回复。

相关实现：

- `src/content/index.ts`
- `src/content/replyObserver.ts`
- `src/content/replyTracker.ts`
- `src/content/replyCompensation.ts`
- `src/content/replyTimeout.ts`
- `src/content/reportableReply.ts`
- `src/content/conversationMonitor.ts`

UI 层会展示人员「正在回复中」气泡；如果停止回复，会展示「已停止回复」并提供重新发送入口。

### 11. 消息体验

消息流支持：

- 用户消息。
- AI 人员回复。
- 系统消息。
- 时间分割。
- Markdown 渲染。
- 回复复制。
- 引用回复继续追问。
- 跳转到对应人员原始 iframe。
- 重新同步完整回复。
- 正在回复气泡。
- 停止回复和重新发送。
- 选中文本高亮。
- 选中文本加入笔记。

Markdown 渲染使用 `markdown-it`，并关闭 HTML 执行：

```ts
new MarkdownIt({ html: false, linkify: true, breaks: true })
```

相关实现：

- `src/teamPage/messagesView.ts`
- `src/teamPage/chatExperience.ts`
- `src/group/highlightColors.ts`

### 12. 笔记系统

OpenTeam 内置富文本笔记能力：

- 全局笔记。
- 当前群聊笔记。
- 全部笔记弹窗。
- 选中消息文本后加入笔记。
- 基础富文本工具栏：加粗、斜体、删除线、项目列表、编号列表、撤销、重做。
- 笔记内容持久化到 `chrome.storage.local`。

笔记编辑器基于 TipTap：

- `@tiptap/core`
- `@tiptap/starter-kit`

相关实现：

- `src/teamPage/notesView.ts`
- `src/teamPage/allNotesView.ts`
- `src/teamPage/tiptapNoteEditor.ts`

## 实现原理

### 总体架构

OpenTeam 由三层组成：

```text
Chrome extension
├── background service worker
│   ├── store 读写
│   ├── 消息路由
│   ├── 人员和群聊命令
│   ├── frame binding
│   └── prompt delivery
├── team.html / team.js
│   ├── 群聊工作台 UI
│   ├── iframe-host
│   ├── 人员库
│   ├── 消息流
│   └── 笔记系统
└── content scripts
    ├── 注入 AI 站点
    ├── 接收 prompt
    ├── 操作网页输入和发送
    ├── 监听回复
    └── 上报会话与回复
```

### 关键消息链路

用户发送消息后的链路：

```text
team.html composer
  -> chrome.runtime.sendMessage(GROUP_MESSAGE_SEND)
  -> background 解析 @ 提及
  -> background 创建用户消息
  -> background 为每个目标人员构建 prompt
  -> background 标记人员 thinking
  -> chrome.tabs.sendMessage(tabId, TEAM_SEND_PROMPT, { frameId })
  -> content script 调用站点 adapter 填入并发送
  -> content script 监听回复
  -> chrome.runtime.sendMessage(TEAM_ROLE_REPLY)
  -> background 写入 assistant 消息
  -> background 广播 store 更新
  -> team.html 重新渲染消息流
```

### 数据持久化

数据保存在 `chrome.storage.local`。

为了避免单个 store 过大，当前 store 使用拆分结构：

- meta store：全局信息、设置、人员库、笔记、高亮、群聊顺序。
- chat document：单个群聊、群聊内人员、消息 chunk 索引。
- message chunk：按固定大小分片保存消息。

相关常量：

- `META_STORE_KEY = openteam.meta.v2`
- `CHAT_KEY_PREFIX = openteam.chat.`
- `MESSAGE_CHUNK_KEY_PREFIX = openteam.messages.`
- `MESSAGE_CHUNK_SIZE = 100`

相关实现：

- `src/group/store.ts`
- `src/background/storeAccess.ts`

### 为什么需要 declarativeNetRequest

许多 AI 网站默认禁止被 iframe 嵌入，会通过响应头设置：

- `X-Frame-Options`
- `Content-Security-Policy: frame-ancestors ...`

为了让 AI 网页可以嵌入到扩展页面的 iframe 工作区中，OpenTeam 使用 `declarativeNetRequest` 修改 frame 导航响应头，并在扩展页 CSP 中放开对应 `frame-src`。

相关文件：

- `public/manifest.json`
- `public/openteam-frame-rules.json`

这也是当前扩展权限相对较重的原因。

## 目录结构

```text
public/
  manifest.json        Chrome 扩展 manifest
  openteam-frame-rules.json DNR 响应头修改规则
  team.html            OpenTeam 团队页 HTML
  team.css             OpenTeam 团队页样式

src/background/
  index.ts             background service worker 入口
  messageRouter.ts     runtime 消息路由
  chatHandlers.ts      群聊命令
  roleHandlers.ts      人员和人员库命令
  messageHandlers.ts   消息发送、回复、笔记、高亮命令
  promptDelivery.ts    prompt 投递
  runtimeFrames.ts     tabId + frameId 绑定注册表

src/content/
  index.ts             content script 入口
  sites/               各 AI 站点适配器
  frameHandshake.ts    iframe 人员身份绑定
  replyObserver.ts     回复监听
  replyTracker.ts      回复去重
  conversationMonitor.ts 会话 URL 监听
  reportableReply.ts   可上报回复提取

src/group/
  types.ts             核心数据类型
  store.ts             本地持久化和迁移
  roleTemplates.ts     人员库和群聊人员逻辑
  builtinRoleTemplates.ts 内置人员模板
  mentionParser.ts     @ 提及解析
  promptBuilder.ts     prompt 构建
  contextSync.ts       上下文同步
  runtimeProtocol.ts   runtime 协议

src/teamPage/
  index.ts             team.html 入口
  appState.ts          前端运行态
  teamUiController.ts  UI 控制器
  iframeHost.ts        iframe 背景工作区
  messagesView.ts      消息流
  composerView.ts      输入框和 @ 面板
  peopleLibraryView.ts 人员库
  rolePanelView.ts     人员面板
  notesView.ts         当前笔记
  allNotesView.ts      全部笔记
```

## 开发环境

安装依赖：

```bash
npm install
```

开发监听构建：

```bash
npm run dev
```

生产构建：

```bash
npm run build
```

完整验证：

```bash
npm run verify
```

`verify` 会依次执行：

1. TypeScript 类型检查。
2. 单元测试。
3. E2E harness。
4. 生产构建。

## 本地安装扩展

1. 执行构建：

   ```bash
   npm run build
   ```

2. 打开 Chrome 扩展管理页：

   ```text
   chrome://extensions/
   ```

3. 打开「开发者模式」。
4. 点击「加载已解压的扩展程序」。
5. 选择本项目的 `dist/` 目录。
6. 点击扩展图标，打开 OpenTeam 团队页。

如果修改了 `manifest.json`、`openteam-frame-rules.json` 或 content script，需要在扩展管理页重新加载扩展。

## E2E smoke test

验证已安装的浏览器插件，并用 Chrome 打开 `team.html` 做 smoke test：

```bash
OPENTEAM_EXTENSION_ID="<extension-id>" \
CHROME_USER_DATA_DIR="$HOME/Library/Application Support/Google/Chrome" \
npm run e2e:extension
```

如果 Chrome 已经以 remote debugging 方式启动，也可以直接连接现有浏览器：

```bash
OPENTEAM_EXTENSION_ID="<extension-id>" \
OPENTEAM_CDP_URL="http://127.0.0.1:9222" \
npm run e2e:extension
```

如果 Chrome 不在默认路径，可以指定：

```bash
CHROME_PATH="/path/to/chrome" \
OPENTEAM_EXTENSION_ID="<extension-id>" \
CHROME_USER_DATA_DIR="/path/to/chrome-profile-root" \
npm run e2e:extension
```

开发调试时也可以临时加载构建后的 unpacked extension：

```bash
OPENTEAM_LOAD_UNPACKED=1 npm run e2e:extension
```

## NPM scripts

```json
{
  "dev": "vite build --watch --mode development",
  "build": "vite build",
  "test": "vitest run",
  "test:e2e": "vitest run --config vitest.e2e.config.ts",
  "e2e:extension": "npm run build && node scripts/e2e-extension-smoke.mjs",
  "e2e": "npm run test:e2e && npm run e2e:extension",
  "typecheck": "tsc --noEmit",
  "verify": "npm run typecheck && npm test && npm run test:e2e && npm run build"
}
```

## 当前边界和注意事项

- OpenTeam 当前是本地 Chrome 扩展项目，不提供云端同步。
- 群聊、人员、消息、笔记和高亮保存到本地 `chrome.storage.local`。
- 「0 API token」指 OpenTeam 不额外调用模型 API、不消耗 API token；目标 AI 网站自身的会员权益、使用次数、限流和服务条款仍然以各网站规则为准。
- 多 AI 站点适配依赖网页 DOM，目标站点改版可能导致输入、发送或回复监听失效。
- iframe 嵌入依赖 DNR 修改响应头，因此扩展权限较重。
- 内置名人风格人员是提示词模板，不代表真人，也不应声称真人参与对话。
- 医疗、法律、投资等高风险建议仍应由用户自行判断，并咨询专业人士。
- 当前项目主要面向 Chrome / Chromium 系浏览器，暂不做跨浏览器适配。

## 项目定位

OpenTeam 的核心定位是：

> 把 AI 从单个聊天工具，组织成可调度的个人思考团队。

它最适合处理那些需要多视角、多轮次、可沉淀讨论过程的问题。用户不再把精力浪费在复制粘贴和窗口管理上，而是把注意力放在判断、追问和决策本身。
