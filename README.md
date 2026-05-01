# OpenTeam

OpenTeam 是一个面向 Gemini 的 Chrome 浏览器插件实验项目。它的目标是把多个 Gemini 对话组织成一个“AI 团队”：用户在一个统一的团队页面里添加多个角色，把消息发给某个角色或所有角色，然后在同一个群聊面板中收集这些角色的回复。

简单说，OpenTeam 想做的是：

- 一个问题，同时让多个 Gemini 角色参与讨论。
- 每个角色对应一个独立 Gemini 会话。
- 用户通过 `@角色名` 或 `@all` 路由消息。
- 插件自动把 prompt 填进对应 Gemini 页面并发送。
- 插件监听 Gemini 回复，把结果汇总回团队群聊。

## 当前实现方式

项目最初使用“后台静默打开多个 Gemini tab”的方案：每个角色对应一个 inactive Chrome tab。这个方案的问题是后台 tab 容易被浏览器节流，Gemini 页面不一定持续渲染，导致 content script 监听不到回复。

当前版本已经切换到 iframe 团队页方案：

```text
OpenTeam team.html
├── Gemini iframe: 角色 A
├── Gemini iframe: 角色 B
├── Gemini iframe: 角色 C
└── 群聊面板
```

点击扩展图标会打开插件自己的 `team.html` 页面。用户在这个页面添加角色时，页面会创建一个 Gemini iframe。Gemini iframe 内部仍会注入 OpenTeam 的 content script，用于接收角色身份、填入 prompt、监听回复并上报结果。

这种方案的好处是：所有角色 iframe 都在同一个可见的插件页面里，避免了 inactive tab 不渲染的问题，也不需要反复切换浏览器 tab 来唤醒页面。

## 核心功能

### 添加角色

在 OpenTeam 页面右上角输入角色名，例如：

```text
A
产品经理
反方
技术负责人
```

每个角色会创建一个独立的 Gemini iframe。角色加载完成后，iframe 内的 content script 会向 background 注册自己的 `tabId + frameId`，background 再把这个 iframe 绑定到对应角色。

### 发送消息

群聊输入框支持三种消息：

```text
@A 帮我从技术角度分析这个方案
```

发送给角色 A。

```text
@all 请分别指出这个产品最大的风险
```

发送给所有可投递角色。

```text
这是一条备注
```

只记录在群聊里，不发送给任何角色。

### 收集回复

Gemini iframe 里的 content script 使用 DOM 监听来观察 Gemini 输出区域。回复稳定后，插件会提取文本并发给 background。background 根据 `tabId + frameId` 找到对应角色，再把消息推送到 `team.html` 的群聊面板。

## 技术架构

### Manifest V3 扩展

项目是一个 Manifest V3 Chrome 扩展，主要由三部分组成：

- `background.js`：维护团队状态、路由消息、打开团队页。
- `content.js`：注入 Gemini 页面，负责填 prompt、点击发送、监听回复。
- `team.html` / `team.js`：插件前台团队页，负责展示角色 iframe 和群聊 UI。

### 团队状态

团队状态由 `src/team/teamRoom.ts` 维护，包含：

- 房间 ID
- host tab ID
- 角色列表
- 消息列表
- 角色状态
- 角色对应的 `tabId` / `frameId`

iframe 方案里，同一个 `team.html` tab 内会有多个 Gemini iframe，因此只靠 `tabId` 不够。OpenTeam 使用 `tabId + frameId` 精确区分不同角色。

### 消息路由

大致链路如下：

```text
team.html 群聊输入
  -> chrome.runtime.sendMessage(TEAM_SEND_MESSAGE)
  -> background 解析 @A / @all
  -> chrome.tabs.sendMessage(tabId, TEAM_SEND_PROMPT, { frameId })
  -> Gemini iframe content script 填入并发送
  -> MutationObserver 监听回复
  -> chrome.runtime.sendMessage(TEAM_ROLE_REPLY)
  -> background 写入团队状态
  -> team.html 更新群聊面板
```

### iframe 通信

`team.html` 创建 iframe 后，会通过 `postMessage` 把角色 ID 发给 Gemini iframe：

```text
OPENTEAM_ASSIGN_FRAME_ROLE
```

iframe 内的 content script 收到后，会向 background 发送：

```text
TEAM_FRAME_ROLE_READY
```

background 使用 Chrome 提供的 `sender.frameId` 记录这个角色所在的 frame。

### iframe 兼容处理

很多网站默认禁止被 iframe 嵌入，会通过响应头设置：

- `X-Frame-Options`
- `Content-Security-Policy: frame-ancestors ...`

为了验证 iframe 方案，当前项目使用 `declarativeNetRequest` 移除 frame 导航中的相关响应头，并放开扩展页的 `frame-src`。

相关文件：

- `public/manifest.json`
- `public/rules.json`

这也是当前项目权限比较重的原因。

## 目录结构

```text
public/
  manifest.json        Chrome 扩展 manifest
  rules.json           DNR header 修改规则
  team.html            OpenTeam 团队页

src/background/
  index.ts             background service worker
  renderWake.ts        旧 tab 方案的渲染唤醒调度器

src/content/
  index.ts             Gemini content script 主入口
  geminiInput.ts       Gemini 输入框写入工具
  replyTracker.ts      回复去重
  replyTimeout.ts      回复超时处理
  responseContainers.ts 回复容器过滤

src/team/
  teamRoom.ts          团队房间状态和消息路由
  messageParser.ts     @角色 / @all 解析
  types.ts             团队模式消息和状态类型

src/teamPage/
  index.ts             team.html 的前端逻辑
```

## 开发

安装依赖：

```bash
npm install
```

监听构建：

```bash
npm run dev
```

生产构建：

```bash
npm run build
```

构建产物在 `dist/`：

```text
dist/
  manifest.json
  rules.json
  background.js
  content.js
  team.html
  team.js
```

## 本地安装扩展

1. 执行 `npm run build`。
2. 打开 Chrome 扩展管理页：`chrome://extensions/`。
3. 打开“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择本项目的 `dist/` 目录。
6. 点击扩展图标，打开 OpenTeam 团队页。

如果修改了 manifest、DNR 规则或 content script，需要在扩展管理页重新加载扩展。

## 测试

运行所有测试：

```bash
npm test
```

当前测试覆盖：

- `@角色` / `@all` 解析
- 团队状态和消息路由
- iframe 角色的 `frameId` 路由
- 回复去重
- 回复超时
- Gemini 输入写入工具
- 旧 tab 唤醒调度器

## 当前限制

OpenTeam 仍处于实验阶段，当前版本主要用于验证 iframe 技术路线。

已知限制：

- Gemini iframe 是否能稳定加载，取决于浏览器、登录态、Google 页面策略和 DNR 规则是否生效。
- 当前为了验证方案，DNR 权限较宽，会移除 frame 导航中的 `CSP` 和 `X-Frame-Options`。
- UI 还比较基础，主要服务于功能验证。
- 旧的 Gemini 页面悬浮面板和后台 tab 方案仍保留在代码里，后续可以逐步清理。
- 没有做云端同步、多用户协作或持久化会话恢复。

## 设计方向

后续可以继续完善：

- 收窄 DNR 规则范围，减少权限风险。
- 增加 iframe 加载失败诊断 UI。
- 支持角色 prompt 模板。
- 支持自动多轮讨论。
- 优化团队页布局和角色管理。
- 清理旧后台 tab 方案。
- 增加端到端浏览器测试。
