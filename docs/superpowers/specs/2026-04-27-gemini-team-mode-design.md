# Gemini Team Mode Design

## 背景

OpenTeam 当前已经能在 Gemini 页面中注入 content script，通过 `MutationObserver` 监听页面输出变化，并在输出稳定后提取页面文本。同时，插件具备向 Gemini 输入框填入内容并自动发送的基础能力。

本设计在现有能力之上增加“团队模式”：在一个 Gemini 主页面中注入悬浮团队面板。用户可以添加多个角色 AI，每个角色对应一个后台静默打开的 Gemini 对话标签页。主页面面板负责发送群消息，background service worker 负责把消息路由到对应角色标签页，再把角色回复收集回主页面。

## 目标

- 在 Gemini 页面注入一个悬浮团队面板，作为群主控制台。
- 支持添加角色 AI，添加时后台静默打开新的 Gemini 对话标签页。
- 每个角色绑定一个 Gemini tab，插件监听该 tab 中 Gemini 的回复变化。
- 支持 `@角色` 向单个角色发送消息。
- 支持 `@all` 并行向所有在线角色发送消息。
- 将各角色的回复回传到主页面悬浮面板，形成群聊体验。
- 复用当前已有的 DOM 监听、文本提取、输入填充和自动发送能力。

## 非目标

- 第一版不做自动接力讨论。
- 第一版不做复杂角色 prompt 模板市场。
- 第一版不做云端多人协同。
- 第一版不做跨浏览器同步。
- 第一版不直接调用 Gemini 私有 API。
- 第一版不自动把无 `@` 的普通消息发给任何角色，避免误触。

## 用户体验

### 打开团队面板

用户访问 Gemini 页面时，插件在页面右侧或右下角注入一个悬浮入口。点击入口后展开团队面板。

团队面板包含：

- 角色列表：角色名、在线状态、生成状态、移除按钮。
- 添加角色按钮。
- 群消息区：显示用户消息和角色回复。
- 输入框：支持 `@角色` 和 `@all`。
- 发送按钮。

### 添加角色

用户点击“添加角色”，输入角色名，例如 `A`、`产品经理`、`反方`。

插件调用 background，background 使用 `chrome.tabs.create({ active: false })` 静默打开新的 Gemini 对话页。新标签页加载 content script 后向 background 注册。background 将该 tab 与角色绑定，并把角色状态推送回主页面面板。

### 发送消息

用户在群输入框输入：

```text
@A 帮我从技术实现角度分析这个方案
```

主页面 content script 将消息交给 background。background 找到 `A` 对应的 tab，并向该 tab 发送 `TEAM_SEND_PROMPT` 指令。角色 tab 收到后调用现有填充发送逻辑，把内容放入 Gemini 输入框并发送。

用户也可以输入：

```text
@all 请分别指出这个产品想法最大的风险
```

background 将同一条消息并行分发给所有在线角色 tab。

### 收集回复

角色 tab 中的 content script 继续通过 `MutationObserver` 监听页面变化。回复稳定后，提取最新回复文本，上报给 background。background 根据 tabId 找到角色，再把回复推送到主页面面板，显示为该角色的新消息。

## 架构

### 模块

#### 主页面 content script

职责：

- 判断当前 Gemini 页面是否为主页面。
- 注入团队悬浮面板。
- 展示角色列表、群消息和发送状态。
- 将用户输入的 `@角色` / `@all` 消息发送给 background。
- 接收 background 推送的角色状态和回复。

#### 角色页 content script

职责：

- 在 Gemini 标签页加载后向 background 注册自身。
- 接收 background 发来的发送指令。
- 调用现有 `fillAndSend` 完成填入和发送。
- 监听 Gemini 回复变化。
- 提取最新回复并上报给 background。

主页面和角色页运行同一份 content script，通过 background 下发的身份信息区分当前页面角色。

#### background service worker

职责：

- 维护团队房间状态。
- 创建后台 Gemini 标签页。
- 维护角色到 tab 的映射。
- 路由用户消息到目标角色 tab。
- 收集角色回复并推送回主页面 tab。
- 处理 tab 关闭、刷新、失联等状态变化。

### 数据结构

```ts
type TeamRoleStatus = 'opening' | 'online' | 'sending' | 'generating' | 'idle' | 'offline' | 'error';

interface TeamRole {
  id: string;
  name: string;
  tabId: number;
  conversationId: string;
  status: TeamRoleStatus;
  createdAt: number;
  lastMessageAt?: number;
  lastError?: string;
}

interface TeamMessage {
  id: string;
  roomId: string;
  roleId?: string;
  roleName?: string;
  from: 'user' | 'role' | 'system';
  target: 'role' | 'all' | 'none';
  targetRoleName?: string;
  content: string;
  createdAt: number;
  status?: 'pending' | 'sent' | 'received' | 'error';
}

interface TeamRoomState {
  roomId: string;
  hostTabId: number;
  roles: TeamRole[];
  messages: TeamMessage[];
}
```

第一版可以把状态保存在 background 内存中，并将必要 UI 状态镜像到 `chrome.storage.session` 或 `chrome.storage.local`。如果 service worker 被浏览器回收，主页面可以触发一次 `TEAM_SYNC_STATE` 重新同步。

## 消息协议

### 主页面到 background

```ts
type HostToBackgroundMessage =
  | { type: 'TEAM_HOST_READY' }
  | { type: 'TEAM_CREATE_ROLE'; name: string }
  | { type: 'TEAM_REMOVE_ROLE'; roleId: string }
  | { type: 'TEAM_SEND_MESSAGE'; raw: string };
```

### background 到主页面

```ts
type BackgroundToHostMessage =
  | { type: 'TEAM_STATE_UPDATED'; state: TeamRoomState }
  | { type: 'TEAM_ROLE_REPLY'; message: TeamMessage }
  | { type: 'TEAM_ERROR'; message: string };
```

### background 到角色页

```ts
type BackgroundToRoleMessage =
  | { type: 'TEAM_ASSIGN_ROLE'; roleId: string; roleName: string; roomId: string }
  | { type: 'TEAM_SEND_PROMPT'; messageId: string; content: string };
```

### 角色页到 background

```ts
type RoleToBackgroundMessage =
  | { type: 'TEAM_ROLE_READY'; conversationId: string }
  | { type: 'TEAM_ROLE_STATUS'; status: TeamRoleStatus }
  | { type: 'TEAM_ROLE_REPLY'; messageId?: string; content: string };
```

## 文本提取策略

当前 `startDOMObserver` 已经实现了稳定等待和文本清洗。团队模式需要把它拆成更通用的能力：

- `extractCleanText(element)`：从 Gemini 回复容器提取干净文本。
- `observeResponseContainers(onStableText)`：监听回复容器变化，稳定后回调。
- `getLatestAssistantReply()`：从当前页面找到最新 Gemini 回复。

为了避免重复上报，同一个角色页需要维护最近一次上报的回复 hash：

```ts
lastReplyHash = hashStr(conversationId + latestReplyText)
```

只有 hash 变化时才上报。

## 发送策略

角色页收到 `TEAM_SEND_PROMPT` 后：

1. 设置状态为 `sending`。
2. 调用现有 `fillAndSend(content, true)`。
3. 发送成功后设置状态为 `generating`。
4. DOM observer 监听到新回复稳定后，上报回复并设置状态为 `idle`。

如果找不到输入框或发送按钮，角色页上报 `error` 状态。

## @ 解析规则

第一版只支持消息开头的 mention：

```text
@A 消息内容
@all 消息内容
```

解析规则：

- `@all`：目标为所有在线角色。
- `@角色名`：目标为匹配角色名的单个角色。
- 不带 `@`：消息只显示在群面板，目标为 `none`。
- 找不到角色：显示错误，不发送。
- 内容为空：不发送。

## 权限

当前 manifest 已有：

- `tabs`
- `activeTab`
- `storage`
- Gemini / AI Studio content script matches

团队模式需要继续使用 `tabs` 来后台创建和管理角色标签页。若后续需要更稳定地控制跨标签通信，可以评估是否增加 `scripting` 权限，但第一版优先不增加新权限。

## 异常处理

- 角色 tab 关闭：background 将角色标记为 `offline`，主面板显示离线。
- 角色 tab 刷新：content script 重新注册，background 尝试恢复绑定。
- Gemini DOM 变化导致提取失败：角色状态标记为 `error`，并显示错误消息。
- Gemini 输入框未就绪：重试一段时间，失败后显示错误。
- service worker 被回收：主页面重新发送 `TEAM_HOST_READY`，background 从 storage 恢复可恢复状态，并重新探测角色 tab。

## 测试计划

- 添加一个角色时，确认后台静默打开 Gemini 新标签页，当前主页面不失焦。
- 添加多个角色时，确认角色列表展示正确。
- 输入 `@A hello` 时，只向 A 标签页发送。
- 输入 `@all hello` 时，向所有在线角色发送。
- 角色回复后，主面板显示对应角色名称和回复内容。
- 关闭角色 tab 后，主面板将角色显示为离线。
- Gemini 页面刷新后，角色能重新注册或提示需要恢复。
- 无 `@` 消息不会发送到角色。
- 找不到角色名时显示错误，不误发。

## 实施顺序

1. 抽取现有 content script 中的文本提取和发送函数。
2. 在 background 中增加团队房间状态和消息路由。
3. 在 content script 中增加角色注册、角色指令处理和回复上报。
4. 在 Gemini 主页面注入悬浮团队面板。
5. 接入 `@角色` / `@all` 解析和发送。
6. 增加角色关闭、刷新、错误状态处理。
7. 运行构建并在真实 Gemini 页面手动验证。

## 风险

- Gemini DOM 结构可能变化，导致选择器失效。
- 后台标签页是否完整加载和保持活跃受浏览器策略影响。
- 自动发送过快可能影响稳定性，因此沿用当前随机延迟和手动取消能力。
- Manifest V3 service worker 会被回收，团队状态需要可恢复。
- Gemini 页面本身可能对后台标签或自动输入有交互限制，需要在真实浏览器中验证。

## 第一版验收标准

- 用户能在 Gemini 主页面打开悬浮团队面板。
- 用户能添加至少两个后台角色 AI。
- 用户能通过 `@角色名` 单独发送消息。
- 用户能通过 `@all` 并行发送消息。
- 每个角色的 Gemini 回复能回显到主页面群面板。
- 关闭角色标签页后，主面板能反映离线状态。
- `npm run build` 通过。
