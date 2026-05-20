# OpenTeam CLI

**Language:** English | [简体中文](README.zh-CN.md)

OpenTeam CLI lets local agents control an OpenTeam browser extension through a local daemon.

## Install

`@openteam/cli` has not been published to npm yet. For now, install from the OpenTeam repository root:

```bash
git clone https://github.com/afumu/openteam.git
cd openteam
npm install -g ./packages/openteamcli
openteamcli doctor
```

## Install the Agent Skill

The package also ships an `openteam-control` skill for local agents. The skill teaches an agent how to start the daemon, check the browser extension connection, create OpenTeam chats, add temporary roles, post tasks, wait for replies, and recover from common local-control errors.

Install from GitHub with the standard skills installer:

```bash
npx skills add afumu/openteam --skill openteam-control
```

For a local checkout or unzipped source package, install from the repository root:

```bash
npx skills add . --skill openteam-control
```

The skills installer will ask which agent, scope, and install method to use.

Restart the agent session after installing the skill, then verify the local bridge:

```bash
openteamcli daemon start
openteamcli doctor
```

If you want an agent to install everything for you, copy this prompt into Codex, Claude Code, or another local coding agent:

```text
Please install OpenTeam local agent control for me.

1. Install the CLI:
   git clone https://github.com/afumu/openteam.git
   cd openteam
   npm install -g ./packages/openteamcli

2. Install the OpenTeam agent skill:
   npx skills add afumu/openteam --skill openteam-control

   If you are working from a local OpenTeam checkout or unzipped source package, run this from the repository root instead:
   npx skills add . --skill openteam-control

3. Start and verify the local bridge:
   openteamcli daemon start
   openteamcli doctor

If the skills installer asks which agent, scope, or install method to use, let me choose. If doctor says the extension is not connected, ask me to open the OpenTeam extension page and enable local agent control in settings.
```

## Development Install

Run from the repository root:

```bash
npm install -g ./packages/openteamcli
# or
npm link ./packages/openteamcli
```

For development, install the local skill from the repository root:

```bash
npx skills add . --skill openteam-control
```

## Publish Checklist

```bash
cd packages/openteamcli
npm pack --dry-run
npm publish --dry-run --access public
npm pack
npm login
npm whoami
npm publish --access public
```

For a beta release:

```bash
npm publish --tag beta --access public
```
