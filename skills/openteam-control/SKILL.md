---
name: openteam-control
description: Use when an agent needs OpenTeam to create AI group chats, add people, post tasks, wait for replies, read results, or continue work in an existing OpenTeam chat from the local machine.
---

# OpenTeam Control

## Overview

OpenTeam is controlled through the local `openteamctl` command. Do not click the browser UI or call Chrome extension APIs directly.

Use this skill when you need multiple AI roles to discuss, review, critique, brainstorm, compare options, or produce independent replies inside OpenTeam.

## Before Any Action

Run:

```bash
npm run openteamctl -- doctor
```

If `extension.connected` is false, tell the user to open the OpenTeam page and enable `本机智能体控制` in settings. Then run `doctor` again.

## Preferred New Task Flow

Create a JSON file with the desired group, people, and task:

```json
{
  "chat": {
    "name": "方案评审",
    "mode": "independent"
  },
  "roles": [
    {
      "source": "temporary",
      "name": "工程师",
      "systemPrompt": "从工程实现、复杂度、风险和测试角度评估。"
    },
    {
      "source": "temporary",
      "name": "产品经理",
      "systemPrompt": "从用户价值、范围控制和交付节奏角度评估。"
    }
  ],
  "task": {
    "target": "all",
    "content": "请评估这个方案，给出风险、建议和最终判断。"
  },
  "options": {
    "waitForReplies": true,
    "activateChat": true,
    "openTeamPage": true
  }
}
```

Then run:

```bash
npm run openteamctl -- run create-and-post --file task.json --wait
```

Summarize the returned `replies` for the user. Preserve each role's viewpoint instead of flattening all replies into one generic answer.

## Existing Chat Follow-Up

Use this when the user gives a known `chatId` or wants to continue a previous OpenTeam chat:

```bash
npm run openteamctl -- task post --chat <chatId> --target all --content "继续追问的问题"
npm run openteamctl -- task wait --chat <chatId> --message <messageId> --timeout 300000
npm run openteamctl -- task read --chat <chatId> --message <messageId>
```

## Useful Commands

```bash
npm run openteamctl -- daemon status
npm run openteamctl -- chat list
npm run openteamctl -- chat get <chatId>
npm run openteamctl -- chat create --name "群聊名" --mode independent
npm run openteamctl -- role batch-add --chat <chatId> --file roles.json
npm run openteamctl -- task post --chat <chatId> --target all --content "任务"
```

`roles.json` may be an array:

```json
[
  {
    "source": "temporary",
    "name": "研究员",
    "systemPrompt": "负责查漏补缺和事实核对。"
  }
]
```

## Error Recovery

Use the machine-readable `error.code`.

| code | What to do |
| --- | --- |
| `extension_not_connected` | Ask the user to open OpenTeam and enable local agent control, then rerun `doctor`. |
| `control_disabled` | Ask the user to enable `本机智能体控制` in OpenTeam settings. |
| `role_not_ready` | Run `chat initialize --chat <chatId>` or ask the user to wait for the role iframe. |
| `task_timeout` | Run `task read` and report partial replies plus pending roles. |
| `idempotency_conflict` | Create a new request file or change the idempotency key. |
| `permission_denied` | Do not retry blindly; the local token or daemon state is wrong. Run `daemon restart`. |

## Rules

- Prefer `run create-and-post --file ... --wait` for new tasks.
- Use JSON files for multi-role or long task input.
- Do not embed secrets in task prompts.
- Do not expose the daemon outside `127.0.0.1`.
- Do not ask OpenTeam to send prompts unless the user clearly wants browser-session AI agents to act.
