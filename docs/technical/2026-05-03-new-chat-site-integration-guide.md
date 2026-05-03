# OpenTeam 新 AI 站点接入设计说明

本文基于当前仓库代码梳理“如果要接入一个新的聊天站点，需要改哪些地方”。这里的“站点”指 Gemini、ChatGPT、Claude 这一类可被 iframe 打开、能由 content script 填 prompt、监听回复并回传 OpenTeam 群聊的 AI 聊天页面。

## 1. 当前项目结构和站点链路

OpenTeam 当前是一个 Manifest V3 Chrome 扩展，核心由四层组成：

```text
team.html / team.js
  -> 创建每个角色的 iframe，选择角色使用哪个 AI 站点
  -> 通过 postMessage 给 iframe 分配 chatId + roleId

content.js
  -> 注入到 Gemini / ChatGPT / Claude 页面
  -> 选择当前站点 adapter
  -> 填入 prompt、点击发送、监听回复、上报会话 URL

background.js
  -> 维护 group store
  -> 记录 chatId + roleId 与 tabId + frameId 的绑定
  -> 路由群聊消息到对应 iframe
  -> 接收回复并写入群聊消息

group/
  -> 定义 ChatSite、Role、Store、URL 安全校验、prompt 构造和角色模板
```

新增站点会横跨这四层，不是只新增一个 DOM adapter。当前站点集合主要是硬编码的 union 和数组：

- `src/group/types.ts`：`ChatSite = 'gemini' | 'chatgpt' | 'claude'`
- `src/content/sites/index.ts`：根据 `location.hostname` 选择 adapter
- `src/group/conversationUrl.ts`：安全 URL、默认 URL、origin、conversationId 提取
- `public/manifest.json`：host permissions、content script matches、extension page CSP frame-src
- `public/rules.json`：DNR 规则，移除目标站点 iframe 响应头限制
- `src/teamPage/*` 和 `public/team.html`：人员库默认站点、添加人员站点选择、角色卡站点切换 UI
- `src/background/index.ts` / `src/background/roleHandlers.ts` / `src/group/store.ts` / `src/group/runtimeProtocol.ts`：运行时消息和 store normalize 时允许哪些站点

## 2. 新站点最小接入清单

假设新增站点 ID 为 `newsite`，域名为 `https://new.example.com/`，会话 URL 类似 `https://new.example.com/chat/<conversation-id>`。

### 2.1 新增 content site adapter

新增文件：

- `src/content/sites/newsite.ts`
- `src/content/sites/newsite.test.ts`

adapter 必须实现 `ChatSiteAdapter`：

- `id`：站点 ID，例如 `newsite`
- `getConversationSnapshot()`：返回 `{ conversationId, conversationUrl }`
- `getConversationId()`：无会话时返回 `__default__`
- `getResponseContainers()`：找到所有 assistant 回复容器
- `getAllAssistantReplies()`：提取历史 assistant 回复，用于去重和恢复
- `readResponseText(node)`：从 DOM 读取回复纯文本
- `readResponseTextFromCopy?(node)`：优先通过页面复制按钮拿 markdown，推荐实现
- `readResponseMarkdown?(node)`：复制失败时的 DOM markdown 兜底
- `findResponseContainer(element)`：从 MutationObserver 命中的节点回溯到完整回复容器
- `isGenerating()`：判断是否还在生成
- `stopGenerating()`：点击停止按钮
- `fillAndSend(content, autoSend)`：写入输入框并发送
- `collectPromptDiagnostics()`：失败时收集输入框、发送按钮、页面状态等诊断

可复用工具：

- `src/content/sites/contentEditable.ts`：安全写入 contenteditable
- `src/content/sites/waitForElement.ts`：等待输入框/按钮
- `src/content/sites/domText.ts`：DOM 文本清洗、按钮标签匹配
- `src/content/sites/domMarkdown.ts`：DOM 转 markdown
- `src/content/sites/clipboardCopy.ts`：通过复制按钮读取回复并恢复用户剪贴板

重点风险：

- 不要用 innerHTML 写 prompt，当前 adapter 都走 `setContentEditableText`，避免把用户文本当 HTML。
- response selector 要尽量指向“单条 assistant 回复”的最内层稳定容器，否则去重和 reply baseline 容易误判。
- copy button 要避开代码块内的复制按钮，优先找整条回复的复制按钮。

### 2.2 注册 adapter 选择逻辑

修改：

- `src/content/sites/index.ts`

新增：

```ts
import { createNewSiteAdapter } from './newsite'

export function getActiveChatSiteAdapter(): ChatSiteAdapter {
  if (location.hostname === 'new.example.com') return createNewSiteAdapter()
  // existing adapters...
}
```

建议将来把这里改成站点注册表，避免每接一个站点都复制多处判断。

### 2.3 扩展权限、注入范围和 iframe 规则

修改：

- `public/manifest.json`
- `public/rules.json`
- `src/extensionConfig.test.ts`

`manifest.json` 需要加入三处：

- `host_permissions`
- `content_security_policy.extension_pages` 的 `frame-src`
- `content_scripts[0].matches`

示例：

```json
"host_permissions": [
  "https://new.example.com/*"
],
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'; frame-src https://new.example.com ..."
},
"content_scripts": [
  {
    "matches": ["*://new.example.com/*"],
    "all_frames": true
  }
]
```

`rules.json` 需要新增一条 `sub_frame` 规则，移除目标站点的 `content-security-policy` 和 `x-frame-options`。当前规则还会重写部分 `Sec-Fetch-*` 请求头，这块要按新站点实际 iframe 行为验证。

注意：

- `src/extensionConfig.test.ts` 会断言 host permissions 和 DNR urlFilter，需要同步更新。
- 如果新站点不允许 iframe 或登录态被浏览器隔离，DNR 只是第一关，还要做真实扩展 smoke test。

### 2.4 扩展 ChatSite 类型和运行时校验

修改：

- `src/group/types.ts`
- `src/group/runtimeProtocol.ts`
- `src/group/store.ts`
- `src/background/index.ts`
- `src/background/roleHandlers.ts`

需要把 `newsite` 加入所有“允许站点”判断：

- `ChatSite` union
- `isRuntimeChatSite`
- `normalizeSettings` 里的 `defaultChatSite`
- `GROUP_SETTINGS_UPDATE` 对 `defaultChatSite` 的校验
- `readChatSite`

这几处漏任何一处，表现会不一样：

- UI 能传 `newsite`，background 可能丢弃。
- store 能保存旧值，load 后可能被 normalize 回 `gemini`。
- 角色模板能选，但批量添加人员时可能掉回默认站点。

### 2.5 URL 安全校验、默认首页和会话 ID 提取

修改：

- `src/group/conversationUrl.ts`
- `src/group/groupUtilities.test.ts`

需要新增：

- 站点 origin，例如 `NEWSITE_ORIGIN`
- 默认首页，例如 `NEWSITE_HOME_URL`
- `isSafeNewSiteUrl(value)`
- `extractNewSiteConversationId(value)`
- 在 `isSafeSupportedChatUrl` 中纳入新站点
- 在 `getDefaultChatSiteUrl(site)` 中返回新站点默认首页
- 在 `getSupportedChatOriginForSite(value, site)` 中返回新站点 origin
- 在 `extractSupportedConversationId(value)` 中纳入新站点会话 ID 解析

安全原则：

- 必须用 `new URL(value)` 后检查 `protocol === 'https:'` 和精确 hostname。
- 不能只用 `startsWith('https://new.example.com')`，否则 `https://new.example.com.evil.test/` 这类 URL 会绕过。
- 默认 fallback 当前是 Gemini 首页；如果新增站点后产品希望按角色站点 fallback，需要优先使用 `getDefaultChatSiteUrl(role.chatSite)`。

当前字段名仍叫 `geminiConversationUrl` / `geminiConversationId`，但实际已经存 ChatGPT 和 Claude 的会话。新增站点时可以继续沿用，改动最小；长期建议迁移为 `conversationUrl` / `conversationId`，避免后续维护误解。

### 2.6 团队页 UI 的站点选择

修改：

- `public/team.html`
- `public/team.css`
- `src/teamPage/domRefs.ts`
- `src/teamPage/peopleLibraryView.ts`
- `src/teamPage/rolePanelView.ts`
- `src/teamPage/messagesView.ts`
- `src/teamPage/teamUiController.ts`
- 对应测试：`src/teamPage/teamHtml.test.ts`、`src/teamPage/domRefs.test.ts`、`src/teamPage/rolePanelView.test.ts`

当前 UI 有三类站点入口：

- 人员库模板默认站点：`template-site-gemini/chatgpt/claude`
- 添加人员弹窗里的每个人站点 pill
- 角色卡上的站点 pill 和切换菜单

新增站点时需要：

- 在人员模板表单里新增 radio input。
- 在 `createTeamPageDomRefs()` 中读取新 input。
- `readTemplateChatSite()` 支持新站点。
- `peopleLibraryView` 和 `rolePanelView` 的 `for (const site of ['gemini', 'chatgpt', 'claude'] as const)` 加入新站点。
- `siteLabel()` 支持新站点显示名。
- `public/team.css` 增加 `.site-pill-newsite` 样式。
- `messagesView` 的角色站点 badge 支持新站点显示名。
- `teamUiController` 打开“AI 站点登录”时会调用 `getDefaultChatSiteUrl()`，只要 2.5 做完就能打开新站点首页。

建议改造：

当前站点选项分散在多个 view 文件里。最好新增一个共享定义，例如：

```ts
export const CHAT_SITE_OPTIONS = [
  { id: 'gemini', label: 'Gemini' },
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'claude', label: 'Claude' },
  { id: 'newsite', label: 'NewSite' },
] as const
```

UI、background 校验、runtimeProtocol、store normalize 都从这里派生，可以明显降低遗漏风险。

### 2.7 iframe host 和会话恢复

主要相关文件：

- `src/teamPage/iframeHost.ts`
- `src/background/roleHandlers.ts`
- `src/background/messageHandlers.ts`
- `src/background/chatHandlers.ts`

`IframeHost` 已经按 `role.chatSite` 调用：

- `getSafeSupportedChatIframeSrcForSite(role.geminiConversationUrl, role.chatSite)`
- `getSupportedChatOrigin(record.src)`

因此只要 `conversationUrl.ts` 支持新站点，iframe src 和 postMessage target origin 通常会跟着可用。

需要重点验证：

- 新站点首页是否能作为 iframe src。
- 新站点会话 URL 是否能作为 iframe src。
- content script 是否能在 iframe 中收到 `OPENTEAM_ASSIGN_FRAME_ROLE`。
- content script ready 后 background 是否正确记录 `tabId + frameId`。
- `TEAM_ROLE_CONVERSATION_UPDATED` 是否能把新站点 URL 持久化到角色。
- 角色切换站点时，旧 runtime frame 是否被清掉，旧会话 URL 是否被删除。

### 2.8 测试需要补哪些

新增或更新：

- `src/content/sites/newsite.test.ts`
  - 安全 URL 与 conversationId 提取
  - 非本站 URL 不上报
  - `fillAndSend` 能写入输入框
  - 等待发送按钮并点击
  - 提取 assistant 回复文本
  - 复制按钮读取 markdown，且恢复剪贴板
  - DOM markdown 兜底

- `src/group/groupUtilities.test.ts`
  - `isSafeSupportedChatUrl`
  - `getSafeSupportedChatUrl`
  - `extractSupportedConversationId`
  - 恶意相似域名拒绝

- `src/extensionConfig.test.ts`
  - host permissions 新增站点
  - DNR rule 数量和 `urlFilter`

- `src/teamPage/teamHtml.test.ts`
  - 人员模板表单包含新站点
  - 人员库、添加人员、角色卡站点菜单包含新站点
  - 新站点 badge / pill 样式存在

- `src/teamPage/iframeHost.test.ts`
  - 新站点默认 iframe src
  - 新站点 conversation URL 恢复
  - postMessage target origin 正确

- `src/background/groupExperience.test.ts` 或 `src/e2e/groupRuntime.e2e.ts`
  - 新站点角色 ready
  - 新站点会话 URL 更新
  - 群聊消息投递到新站点角色

最后跑：

```bash
npm run verify
```

如果涉及真实页面 selector 和 iframe 行为，还需要跑扩展 smoke test：

```bash
OPENTEAM_EXTENSION_ID="<extension-id>" npm run e2e:extension
```

## 3. 建议先做的设计改造

如果只是快速验证第四个站点，可以按上面的最小清单直接改。但如果后续会持续接入更多站点，建议先做三个小型抽象，否则每个站点都会复制修改十几处。

### 3.1 建立统一站点注册表

新增 `src/group/chatSites.ts`，集中维护：

- `id`
- `label`
- `hosts`
- `origin`
- `homeUrl`
- `contentScriptMatches`
- `dnrUrlFilters`
- `conversationPathPattern` 或 `extractConversationId`

然后派生：

- `ChatSite` 类型
- `isRuntimeChatSite`
- `readChatSite`
- `getDefaultChatSiteUrl`
- UI 站点菜单
- manifest/rules 测试期望

受 Chrome manifest 必须是静态 JSON 的限制，`public/manifest.json` 和 `public/rules.json` 仍要写死或改成构建生成，但至少测试和业务逻辑可以统一来源。

### 3.2 迁移 conversation 字段命名

当前 `GroupRole` 里仍是：

```ts
geminiConversationId?: string
geminiConversationUrl?: string
```

但 ChatGPT 和 Claude 已经共用这两个字段。建议新增版本迁移：

```ts
conversationId?: string
conversationUrl?: string
```

兼容策略：

1. 读取 store 时，如果新字段不存在但旧字段存在，就复制到新字段。
2. 写入时优先写新字段，短期可同步写旧字段。
3. 所有 UI 和 iframe host 改读 `conversationUrl`。
4. 一个版本后删除旧字段。

这能减少“新增站点为什么还在改 geminiConversationUrl”的认知成本。

### 3.3 把站点 selector 验证独立成手动诊断脚本

新站点最大风险不是 TypeScript，而是页面 DOM 改版、登录态、iframe 限制、复制按钮权限。建议为每个 adapter 准备一份手动验证清单或 Playwright/扩展 smoke 场景：

- 页面已登录时能 iframe 打开。
- content script 在 iframe 中启动。
- role assignment 成功，状态变 ready。
- 发送 prompt 后输入框内容正确。
- 发送按钮确实是当前 composer 的发送按钮。
- 生成中状态能识别。
- 停止按钮能点击。
- 回复稳定后只上报一次。
- markdown 复制优先于 DOM fallback。
- 会话 URL 变更能保存，刷新团队页后能恢复。

## 4. 推荐实施顺序

1. 先做 `conversationUrl.ts`、`ChatSite` 类型和 adapter 单测，让站点身份、URL 和会话 ID 先稳定。
2. 再接 `manifest.json` / `rules.json`，确认扩展能注入并能 iframe 打开。
3. 然后做 `src/content/sites/newsite.ts`，用 jsdom 测 selector、输入、回复读取和复制。
4. 接 UI 站点选项，让人员库、添加人员、角色卡都能选择新站点。
5. 跑 `npm run verify`。
6. 最后用真实 Chrome 扩展做 smoke test，重点看登录、iframe、content script ready、prompt 投递和回复回收。

## 5. 当前仓库里容易漏的点

- `src/group/store.ts` 的 `normalizeSettings` 会丢弃未知 `defaultChatSite`。
- `src/background/index.ts` 的 `GROUP_SETTINGS_UPDATE` 会丢弃未知站点。
- `src/background/roleHandlers.ts` 的 `readChatSite` 会丢弃未知站点。
- `src/group/runtimeProtocol.ts` 的 `isRuntimeChatSite` 会把未知站点判掉。
- `src/teamPage/peopleLibraryView.ts` 和 `src/teamPage/rolePanelView.ts` 都各自写了 `['gemini', 'chatgpt', 'claude']`。
- `public/team.html` 的模板默认站点 radio 是静态 HTML。
- `public/team.css` 每个站点 pill 都有单独 class。
- `src/extensionConfig.test.ts` 会严格断言 host permissions 和 DNR 规则数量。
- 字段名 `geminiConversationUrl` 实际已经是通用会话 URL，新增站点时不要被名字误导。

## 6. 粗略改动面评估

快速接入一个站点通常会影响：

- 新增 1 个 adapter 文件和 1 个 adapter 测试文件。
- 修改 5 个 group/background 层文件。
- 修改 4 个扩展配置/安全测试文件。
- 修改 5 到 7 个 teamPage/UI 文件。
- 补 5 到 8 组测试。

如果先做统一站点注册表，第一次改动会更大，但第五个、第六个站点的成本会明显降低。
