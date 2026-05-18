# OpenTeam Agent Control Design

## Goal

让外部 agent 可以通过一个稳定的本地 CLI 控制 OpenTeam 浏览器扩展，完成：

- 创建群聊。
- 添加或复用人员。
- 初始化网页 AI iframe。
- 发布任务到指定人员或所有人员。
- 等待回复、读取回复、导出结果。
- 在失败时执行可恢复操作，例如恢复 iframe、重试发送、停止生成。

核心目标不是让 agent 操作 OpenTeam UI，而是为 OpenTeam 增加一层本地控制平面，让 agent 调用结构化命令，OpenTeam 负责把这些命令转成现有群聊、人员、消息和编排能力。

## Background

OpenTeam 当前已经有成熟的内部能力：

- `GROUP_CHAT_CREATE` 创建群聊。
- `GROUP_ROLES_CREATE_BATCH` 批量添加人员。
- `GROUP_MESSAGE_SEND` 发布普通群聊消息。
- `GROUP_ROLE_RECOVER` 恢复人员 iframe。
- `GROUP_ORCHESTRATION_RUN` 运行编排流程。
- `GROUP_STORE_GET` 获取完整 store。

这些能力目前主要由 `team.html` 前端页面通过 `chrome.runtime.sendMessage` 调用。外部 agent 无法直接调用这些 runtime message，因为它们运行在浏览器扩展权限域内。

参考 OpenCLI 的实现后，推荐采用本地 daemon + 扩展主动 WebSocket 连接的模式，而不是要求用户用 `--remote-debugging-port` 启动 Chrome。

## Non-Goals

第一版不做以下事情：

- 不让 agent 直接点击 OpenTeam UI。
- 不暴露公网接口。
- 不支持远程未认证访问。
- 不把 OpenTeam 改成云服务。
- 不要求用户配置 OpenAI、Claude 或 Gemini API key。
- 不重写现有群聊、人员、iframe、消息投递架构。
- 不在第一版强制支持完整编排流程生成和编辑。
- 不替代现有手动 UI，CLI 只是新增控制入口。

## Recommended Architecture

```text
External Agent
  reads openteam-control skill
  runs openteamctl
        |
        | HTTP 127.0.0.1:<port>
        v
OpenTeam Local Daemon
  command routing
  pending request tracking
  timeout handling
  audit log
        |
        | WebSocket
        v
OpenTeam Extension Background
  control protocol client
  command handlers
  existing store/runtime command reuse
        |
        v
team.html / iframeHost / content scripts
  activates chat
  creates role iframes
  sends prompts to AI web sessions
  receives replies
```

The daemon is the local bridge. The extension initiates the WebSocket connection to the daemon. The CLI never needs Chrome DevTools Protocol, and the agent never needs direct access to `chrome.runtime`.

## Communication Model

### Daemon HTTP API

The CLI sends commands to the daemon:

```http
POST /command
X-OpenTeam: 1
Authorization: Bearer <local-token>
Content-Type: application/json
```

Request:

```ts
interface ControlHttpCommand {
  id: string
  action: string
  payload?: unknown
  timeoutMs?: number
  profileId?: string
}
```

Response:

```ts
interface ControlHttpResult {
  id: string
  ok: boolean
  data?: unknown
  error?: {
    code: string
    message: string
    hint?: string
    recoverable?: boolean
  }
}
```

### Extension WebSocket

The extension connects to:

```text
ws://127.0.0.1:<port>/ext
```

On connect, it sends:

```ts
interface ExtensionHello {
  type: 'hello'
  extensionVersion: string
  protocolVersion: 1
  profileId: string
  capabilities: string[]
}
```

Capabilities should include:

```text
store.get
chat.list
chat.create
roles.batchAdd
roles.recover
task.post
task.wait
task.read
run.createAndPost
```

The daemon keeps a `pending` map keyed by command id. It forwards command JSON to the extension. The extension returns a result with the same id. The daemon resolves the HTTP request.

## OpenTeam CLI

CLI name:

```text
openteamctl
```

Default output should be JSON. Human-friendly table output can come later.

### Core Commands

```bash
openteamctl doctor
openteamctl daemon status
openteamctl daemon start
openteamctl daemon stop
openteamctl daemon restart
openteamctl daemon logs
```

`doctor` checks:

- daemon reachable.
- extension connected.
- extension version compatible.
- control setting enabled in OpenTeam.
- at least one OpenTeam team page can be opened or activated.
- optional: currently connected profile id.

### Chat Commands

```bash
openteamctl chat list
openteamctl chat get <chatId>
openteamctl chat create --name <name> --mode independent|collaborative
openteamctl chat delete <chatId>
openteamctl chat activate <chatId>
```

`chat activate` should make the target chat current and ask the team page to mount relevant iframes. It does not publish a task by itself.

### Role Commands

```bash
openteamctl role list --chat <chatId>
openteamctl role add --chat <chatId> --name <name> --site claude --prompt <text>
openteamctl role batch-add --chat <chatId> --file roles.json
openteamctl role recover --chat <chatId> --role <roleId>
openteamctl role wait-ready --chat <chatId> --timeout 120000
```

Role input supports two sources:

```ts
type AgentRoleInput =
  | {
      source?: 'temporary'
      name: string
      description?: string
      systemPrompt: string
      modelSource?: 'site'
      chatSite?: 'gemini' | 'chatgpt' | 'claude' | 'deepseek'
    }
  | {
      source: 'library'
      roleTemplateId: string
      modelSource?: 'site'
      chatSite?: 'gemini' | 'chatgpt' | 'claude' | 'deepseek'
    }
```

External API model roles can be added later. First version can focus on site-backed roles because the product premise is reusing browser AI accounts.

### Task Commands

```bash
openteamctl task post --chat <chatId> --target all --content <text>
openteamctl task post --chat <chatId> --target role:<roleId> --content <text>
openteamctl task status --chat <chatId> --message <messageId>
openteamctl task wait --chat <chatId> --message <messageId> --timeout 300000
openteamctl task read --chat <chatId> --message <messageId>
openteamctl task export --chat <chatId> --format md|json
openteamctl task stop --chat <chatId> --role <roleId>
openteamctl task retry --chat <chatId> --role <roleId> --message <messageId>
```

For `task post`, CLI can accept `--target all` and convert it to raw content:

```text
@所有人 <content>
```

For a specific role, the extension should prefer role id targeting internally instead of depending on mention text. If the current message handler only accepts raw mention syntax, first version can synthesize the correct mention label.

### One-Shot Run Command

This is the main command for agents:

```bash
openteamctl run create-and-post --file task.json --wait
```

Input:

```ts
interface CreateAndPostRequest {
  chat: {
    name: string
    description?: string
    mode?: 'independent' | 'collaborative'
    reuse?: {
      strategy: 'none' | 'by-name' | 'by-id'
      chatId?: string
    }
  }
  roles: AgentRoleInput[]
  task: {
    target: 'all' | { roleIds: string[] } | { roleNames: string[] }
    content: string
    referenceMessageId?: string
  }
  options?: {
    waitForReady?: boolean
    waitForReplies?: boolean
    timeoutMs?: number
    idempotencyKey?: string
    openTeamPage?: boolean
    activateChat?: boolean
  }
}
```

Output:

```ts
interface CreateAndPostResult {
  chat: {
    id: string
    name: string
    mode: 'independent' | 'collaborative'
  }
  roles: Array<{
    id: string
    name: string
    chatSite?: string
    status: string
  }>
  taskMessage: {
    id: string
    content: string
    status: string
  }
  replies?: Array<{
    messageId: string
    roleId: string
    roleName: string
    content: string
    status: string
    conversationUrl?: string
  }>
  warnings?: string[]
}
```

## Agent Skill

Skill name:

```text
openteam-control
```

Skill responsibility:

- Teach agents when to use OpenTeam.
- Provide the JSON schema for `create-and-post`.
- Instruct agents to run `openteamctl doctor` first.
- Instruct agents to prefer one-shot `run create-and-post` for new tasks.
- Instruct agents to use `task post` for follow-up questions in an existing chat.
- Define recovery behavior from structured error codes.

The skill should not contain business logic that belongs in the extension. It should be a thin operational guide and can include small helper scripts only for schema validation or JSON generation.

### Agent Workflow

Default workflow for a new task:

1. Run `openteamctl doctor`.
2. Build `task.json`.
3. Run `openteamctl run create-and-post --file task.json --wait`.
4. If replies are returned, summarize them for the user.
5. If timeout occurs, run `openteamctl task read --chat <chatId>` and report partial results.
6. If a role is unavailable, recover or retry according to the error code.

Follow-up workflow:

1. Use the previous `chatId`.
2. Run `openteamctl task post --chat <chatId> --target all --content ... --wait`.
3. Read replies and summarize.

### Agent Capabilities

The agent should be able to:

- Create an expert panel from natural language.
- Select built-in role templates when the user asks for known scenarios.
- Create temporary roles with clear responsibilities.
- Choose chat sites per role when specified.
- Post tasks to all members.
- Post targeted follow-ups to selected members.
- Wait for and collect replies.
- Export or summarize the group discussion.
- Retry failed role replies.
- Recover stale role iframes.

## Extension Changes

### New Modules

Recommended files:

```text
src/control/protocol.ts
src/background/controlClient.ts
src/background/controlHandlers.ts
src/background/controlRunHandlers.ts
src/background/controlReadModels.ts
src/background/controlErrors.ts
```

`protocol.ts` defines shared TypeScript types.

`controlClient.ts` owns:

- daemon URL config.
- WebSocket connection.
- reconnect backoff.
- hello handshake.
- command dispatch.
- result sending.

`controlHandlers.ts` maps external actions to existing background operations.

`controlRunHandlers.ts` implements `run.createAndPost`, because it is a multi-step workflow rather than a single store mutation.

`controlReadModels.ts` converts internal store objects into smaller, agent-safe JSON outputs.

`controlErrors.ts` normalizes errors into stable error codes.

### Background Integration

`src/background/index.ts` should initialize the control client only if the setting is enabled:

```ts
initializeControlClient({
  enabled: store.settings.agentControlEnabled,
  handlers,
  log,
})
```

Because service workers can restart, initialization must be idempotent.

### Settings

Add to `OpenTeamSettings`:

```ts
interface OpenTeamSettings {
  agentControlEnabled?: boolean
  agentControlPort?: number
}
```

Defaults:

```ts
agentControlEnabled: false
agentControlPort: 19826
```

The UI should expose a settings toggle:

```text
允许本机 Agent 控制 OpenTeam
```

Copy should make the risk explicit: enabling this lets local tools create chats and send prompts through logged-in AI web sessions.

### Team Page Activation

Some operations require `team.html` to be open because iframeHost lives in the team page, not the service worker.

The extension needs a background-to-team-page command:

```text
CONTROL_TEAM_ACTIVATE_CHAT
```

Flow:

1. Control handler receives `chat.activate` or `run.createAndPost`.
2. Background ensures a team page exists.
3. If no team page exists, background opens `team.html`.
4. Background sends a runtime message to the team page to activate the chat.
5. Team page calls `iframeHost.activateChat`.
6. Team page returns role frame states.

This avoids putting iframe DOM work into the service worker.

### Role Initialization

Site-backed roles need iframe readiness before prompt delivery.

Initialization should:

1. Activate the chat in the team page.
2. Recover missing role frames with `GROUP_ROLE_RECOVER`.
3. Wait until all target site roles are `ready`, or until timeout.
4. Treat external model roles as ready if their model config exists.
5. Return partial readiness with specific failed roles if timeout occurs.

Suggested result:

```ts
interface InitializeChatResult {
  chatId: string
  readyRoleIds: string[]
  pendingRoleIds: string[]
  failedRoleIds: string[]
  timedOut: boolean
}
```

### Posting Tasks

The best long-term shape is to add an internal message command that accepts explicit target role IDs:

```text
GROUP_MESSAGE_SEND_TARGETED
```

Payload:

```ts
{
  chatId: string
  content: string
  targetRoleIds: string[]
  reference?: MessageReference
}
```

Reason:

- External control should not depend on localized mention syntax.
- Role names can duplicate across sites.
- Agent should be able to target by role id.

For first implementation, if we want lower change risk, `task.post` can synthesize raw mention text and call existing `GROUP_MESSAGE_SEND`. The explicit targeted command is cleaner and should be the preferred design.

### Waiting For Replies

`task.wait` should poll store state, not watch DOM.

Completion rule for a user message:

- If all target roles have delivery status `received`, complete.
- If any target role has delivery status `error`, return partial result with error.
- If timeout occurs, return partial result.
- If user stopped generation, return stopped state.

The response should include assistant messages associated with the target user message.

If current store does not directly link assistant messages to source user message, add an optional field:

```ts
interface GroupMessage {
  sourceMessageId?: string
}
```

This improves `task.wait` and `task.read`. If we want a no-migration first version, infer by `role.lastPromptMessageId` and message order, but explicit linkage is more robust.

## Daemon Design

The daemon should be a small Node process packaged with `openteamctl`.

Responsibilities:

- Listen on `127.0.0.1`.
- Serve `/ping`, `/status`, `/command`, `/logs`, `/shutdown`.
- Accept WebSocket connections from the OpenTeam extension on `/ext`.
- Maintain connected extension profiles.
- Route CLI commands to the selected profile.
- Track pending command ids and timeouts.
- Normalize transport failures.
- Store audit logs.

It should not:

- Access Chrome directly.
- Know OpenTeam store internals beyond command payload/result schemas.
- Parse or modify prompts.
- Run LLM calls.

### Ports

Default port:

```text
19826
```

OpenCLI uses `19825`, so OpenTeam should avoid collision.

Environment variable:

```text
OPENTEAM_DAEMON_PORT
```

### Daemon Status

`GET /status` returns:

```ts
interface DaemonStatus {
  ok: boolean
  pid: number
  uptime: number
  daemonVersion: string
  extensionConnected: boolean
  extensionVersion?: string
  protocolVersion?: number
  profiles: Array<{
    profileId: string
    connected: boolean
    lastSeenAt: number
    capabilities: string[]
  }>
  pending: number
  port: number
}
```

## Idempotency

Agent commands often retry after timeout. Without idempotency, retries can create duplicate chats or post duplicate tasks.

Support `idempotencyKey` for write commands:

- `chat.create`
- `roles.batchAdd`
- `task.post`
- `run.createAndPost`

Store idempotency records in extension storage:

```ts
interface AgentControlIdempotencyRecord {
  key: string
  action: string
  requestHash: string
  result: unknown
  createdAt: number
  expiresAt: number
}
```

TTL can be 24 hours.

If the same key and same request hash repeats, return the previous result.

If the same key but different request hash appears, return:

```text
idempotency_conflict
```

## Security

This feature can send prompts through logged-in AI websites, so it must be treated as local privileged automation.

Required controls:

- Control setting disabled by default.
- Daemon binds only to `127.0.0.1`.
- HTTP commands require `X-OpenTeam: 1`.
- HTTP commands require a local bearer token.
- Token generated by `openteamctl daemon start` and stored in `~/.openteam/control-token`.
- WebSocket accepts only Chrome extension origins.
- Optional strict check for known extension id in production builds.
- No CORS headers on command endpoints.
- 1 MB request body limit.
- Audit logs for write commands.

Audit entry:

```ts
interface AgentControlAuditEntry {
  id: string
  action: string
  chatId?: string
  roleIds?: string[]
  messageId?: string
  promptPreview?: string
  promptLength?: number
  createdAt: number
  ok: boolean
  errorCode?: string
}
```

The audit log should not store full prompt content by default. Store preview and length.

## Error Codes

Stable error codes are important because agents should branch on codes, not localized messages.

Suggested codes:

```text
daemon_not_running
extension_not_connected
profile_required
profile_disconnected
control_disabled
unsupported_protocol
chat_not_found
role_not_found
role_not_ready
role_recovery_failed
team_page_not_available
team_page_timeout
message_send_failed
task_timeout
partial_replies
idempotency_conflict
invalid_request
permission_denied
internal_error
```

Each error should include a human hint. Example:

```json
{
  "code": "extension_not_connected",
  "message": "OpenTeam extension is not connected to the local daemon.",
  "hint": "Open Chrome with the OpenTeam extension enabled, then run openteamctl doctor again.",
  "recoverable": true
}
```

## MVP Scope

MVP should support:

- `openteamctl doctor`
- daemon start/stop/status
- extension WebSocket hello
- control setting toggle
- `chat.list`
- `chat.create`
- `roles.batchAdd`
- `chat.initialize`
- `task.post`
- `task.wait`
- `task.read`
- `run.createAndPost`
- `openteam-control` skill draft

MVP should not support:

- Remote access.
- Full orchestration editing.
- Template marketplace.
- Streaming replies to CLI.
- Concurrent runs across the same chat.
- Rich UI for audit log.

## Future Scope

Later phases can add:

- `template.use` for built-in group templates.
- `orchestration.autoGenerate`.
- `orchestration.run`.
- streaming task updates over daemon events.
- Markdown report generation.
- multi-profile aliasing.
- remote tunnel guidance with explicit auth.
- richer audit log UI in OpenTeam.

## Implementation Plan

### Phase 1: Transport and Health

Add daemon package and CLI skeleton:

- `openteamctl daemon start|stop|status`.
- `openteamctl doctor`.
- local token management.
- HTTP `/ping`, `/status`, `/command`, `/shutdown`.
- WebSocket `/ext`.

Add extension control client:

- setting flag.
- WebSocket connect/reconnect.
- hello handshake.
- command dispatch skeleton.

Verification:

```bash
openteamctl doctor
```

Expected result: daemon and extension connected, no write command support yet.

### Phase 2: Read Commands

Add:

- `store.get`
- `chat.list`
- `chat.get`
- `role.list`

These validate command routing without modifying user data.

### Phase 3: Write Commands

Add:

- `chat.create`
- `roles.batchAdd`
- idempotency records.
- audit log for writes.

Implementation should reuse existing store mutation helpers rather than duplicating create logic.

### Phase 4: Team Page Activation and Initialization

Add:

- ensure/open `team.html`.
- activate chat from background.
- team page runtime handler for control activation.
- wait for role readiness.
- recover stale iframe roles.

This is the highest-risk phase because it crosses background and page DOM boundaries.

### Phase 5: Task Posting and Waiting

Add:

- explicit targeted send or mention-synthesis fallback.
- assistant reply linkage if needed.
- `task.wait`.
- `task.read`.
- timeout and partial reply behavior.

### Phase 6: One-Shot Agent Flow

Add:

- `run.createAndPost`.
- CLI `--file` input.
- `--wait` option.
- structured output for agent consumption.

### Phase 7: Skill

Add local skill:

```text
openteam-control/
  SKILL.md
  references/request-schema.md
```

The skill should include examples for:

- product review panel.
- code review panel.
- content planning panel.
- targeted follow-up.

## Testing

Unit tests:

- protocol validation.
- daemon command routing.
- idempotency conflict behavior.
- error normalization.
- control handlers for chat/role/task commands.
- `task.wait` completion and timeout cases.

Extension tests:

- WebSocket reconnect behavior.
- control disabled blocks command execution.
- hello includes version/profile/capabilities.
- team page activation message opens or reuses team page.

Integration tests:

- daemon + mocked extension round trip.
- `run.createAndPost` with mocked store and mocked role readiness.
- task wait returns replies after simulated `TEAM_ROLE_REPLY`.

E2E smoke:

- build extension.
- load unpacked extension.
- start daemon.
- verify `openteamctl doctor`.
- create a chat with temporary roles.
- confirm chat and roles appear in store.

Focused verification commands will depend on the final package layout, but should include:

```bash
npm run typecheck
npm test
npm run build
```

## Open Questions

- Should `openteamctl` live in the OpenTeam repo or a separate package?
- Should first version add `GROUP_MESSAGE_SEND_TARGETED`, or use mention synthesis first?
- Should `task.wait` add `sourceMessageId` to assistant messages immediately?
- Should control port be fixed at `19826`, or configured in UI?
- Should CLI auto-start daemon, like OpenCLI, or require explicit `daemon start`?
- Should the first public skill live inside this repo or in the user's Codex skills directory?

## Recommendation

Use the OpenCLI-inspired daemon bridge as the foundation.

For MVP, implement only ordinary group chat automation:

```text
create chat -> add roles -> activate/initialize -> post @all task -> wait/read replies
```

Defer full orchestration control until the transport, safety, idempotency, and ordinary task flow are solid.

