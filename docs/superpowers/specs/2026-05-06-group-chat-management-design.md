# Group Chat Management Design

## Context

OpenTeam already supports multi-person group chats, per-chat role membership, role iframe recovery, chat action menus, and chunked local storage for chat messages. This design adds three user-facing management actions:

- Remove a person from the current group chat while keeping historical messages.
- Resize the floating OpenTeam window freely.
- Export the current group chat record.

The implementation should follow the existing split between `src/group`, `src/background`, and `src/teamPage`.

## Goals

- A user can kick a person out of a group chat.
- Kicking a person removes them from the active member list and closes that person's iframe window.
- Past messages from the removed person remain visible and exportable.
- A user can resize the floating window by dragging a resize affordance.
- A user can export the selected group chat as a readable Markdown file.

## Non-Goals

- Do not delete historical messages when a person is kicked.
- Do not create a separate removed-member archive view.
- Do not support multi-format exports in this pass.
- Do not persist floating window size across browser sessions unless the existing UI state pattern makes that trivial.

## Behavior

### Kick Person

The role card menu gains a destructive action named `踢出群聊`.

When clicked, the UI asks for confirmation:

`确定将「{role.name}」移出当前群聊吗？历史聊天记录会保留。`

If confirmed, the team page sends `GROUP_ROLE_DELETE` with the role id. The background handler removes the role id from `chat.roleIds`, deletes the live role record, updates chat timestamps/status, and calls `runtimeFrames.removeRole(chatId, roleId)` so the iframe is closed.

The handler must not remove any message id from `chat.messageIds` and must not delete any message from `messagesById`. Existing assistant messages keep their denormalized `roleName`, so old messages still render even when the role is no longer in `rolesById`.

After the updated store arrives:

- The removed person disappears from the member drawer.
- The removed person disappears from mention suggestions and default send targets.
- The removed person's iframe closes.
- Historical messages remain in the message list.

### Free Window Resize

The floating window adds a bottom-right resize affordance shown only when the shell is not fullscreen and not minimized.

Dragging the affordance updates inline width and height on the app shell. The resize operation uses viewport-aware constraints:

- Minimum width: 760 px.
- Minimum height: 520 px.
- Maximum width and height: viewport size minus the existing outer margin.

After resizing, the shell position is clamped so it remains visible inside the viewport. Fullscreen clears the floating dimensions visually, and leaving fullscreen returns to the previously sized floating window if the browser retained the inline styles.

### Export Chat Record

The chat action menu gains `导出记录`.

Selecting it exports the current chat as a Markdown file. The file name uses a safe chat name and current timestamp:

`openteam-{chat-name}-{YYYYMMDD-HHmmss}.md`

The exported content includes:

- Chat name.
- Chat mode.
- Export time.
- Current member snapshot.
- Message count.
- Messages in sequence order with timestamp, sender label, and content.

Sender labels:

- User messages: `我`.
- Assistant messages: `message.roleName`, falling back to the role name from `rolesById`, then `AI 人员`.
- System messages: `系统`.

The export should be generated locally in the team page from the current store. It should use `Blob` and an object URL download, with object URL cleanup after the click is triggered.

## Data Flow

Kick person:

1. Role panel renders the action in each role card menu.
2. User confirms.
3. Team page calls `runCommand('GROUP_ROLE_DELETE', { roleId })`.
4. Background mutates store and closes the runtime frame.
5. Background broadcasts the updated store.
6. Team page re-renders from store.

Export:

1. Chat menu action reads the selected chat, roles, and messages from the current store.
2. A formatter builds Markdown text.
3. The browser downloads the generated file.

Resize:

1. Pointer down on resize affordance records starting pointer and shell rectangle.
2. Pointer move computes constrained width and height.
3. Pointer up releases pointer capture.
4. Window resize events clamp size and position.

## Error Handling

- If a role no longer exists when kicking, show the runtime error through the existing `showError` path.
- If the browser blocks file download creation, show `导出群聊记录失败`.
- If no current chat exists, do not show export as an available action.
- If resizing is interrupted by pointer cancel, leave the last valid size in place and release capture.

## Testing

Unit tests should cover:

- `deleteGroupRole` keeps historical messages while removing the live role membership.
- `GROUP_ROLE_DELETE` closes the role runtime frame.
- Role panel renders the kick action and invokes `GROUP_ROLE_DELETE` after confirmation.
- Floating window resize updates shell width/height and clamps dimensions.
- Chat action menu contains `导出记录`.
- Export formatter preserves removed-member historical messages by using `message.roleName`.

Run focused tests first, then the existing typecheck and relevant team page/background tests.

