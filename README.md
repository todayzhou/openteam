# OpenTeam

**🌐 Language:** English | [简体中文](README.zh-CN.md)

> A local-first AI team workspace that turns your existing ChatGPT, Claude, Gemini, and DeepSeek web sessions into a multi-agent discussion room.

OpenTeam is a Manifest V3 Chrome extension. It does not require model API keys and does not spend extra OpenAI, Claude, Gemini, or DeepSeek API tokens. Instead, it reuses the AI accounts you already have open in your browser, sends tasks to those web sessions, and gathers replies from different people and models into one shared team chat.

Use it for learning, research, and personal non-commercial experiments where one answer is not enough: product reviews, technical design reviews, content planning, personal decisions, multi-model comparison, and multi-step work that benefits from several AI roles thinking together.

![OpenTeam group chat preview](docs/assets/group-chat-ui-concept.png)

## ✨ Highlights

- 🚫 **0 API token workflow**: reuse AI website sessions instead of calling model APIs directly.
- 🧩 **Multi-model discussion**: coordinate Gemini, ChatGPT, Claude, DeepSeek, and other supported web sessions in one chat.
- 🧑‍🏫 **Built-in advisor library**: start with 38 expert and thinking-style advisor templates, or create your own people.
- 📣 **Mention-based routing**: use `@person` to ask one member, or `@everyone` to dispatch the same task to the whole team.
- 🔄 **Independent and collaborative modes**: compare isolated perspectives first, then let members reference, challenge, and build on each other.
- 💾 **Local-first storage**: chats, people, messages, notes, highlights, and settings are stored in browser storage.
- 🤖 **Agent control CLI**: optional `openteamcli` support lets local agents create chats, add roles, post tasks, and wait for replies.

## 🧭 How It Works

Each OpenTeam member is bound to an AI website session. When you send a message, OpenTeam builds a prompt from the chat mode, member persona, referenced messages, and shared context. The extension then delivers that prompt into the member's iframe-backed AI page and listens for the reply.

```text
team.html
  -> background service worker
  -> AI site iframe
  -> content script
  -> AI webpage reply
  -> OpenTeam message stream
```

Supported site types:

| Site | Common fit |
| --- | --- |
| Gemini | Long context, research, multimodal material |
| ChatGPT | General execution, tool-shaped workflows, fast iteration |
| Claude | Long documents, review, structured writing, careful reasoning |
| DeepSeek | Code, reasoning, Chinese-language work, cost-sensitive tasks |

These are practical defaults, not rankings. Actual quality depends on model versions, account plans, task type, and input material.

## ⚠️ Disclaimer

OpenTeam is an unofficial project for learning, research, and personal non-commercial use only. It is not affiliated with, endorsed by, or supported by OpenAI, Anthropic, Google, DeepSeek, or any supported AI website.

OpenTeam interacts with AI websites through user-authenticated browser sessions and DOM automation. Website changes, account rules, rate limits, anti-abuse systems, or terms of service may affect whether it works. You are responsible for reviewing and complying with the rules, policies, laws, and regulations that apply to your use.

Do not use OpenTeam for commercial products, hosted services, paid workflows, bulk automation, spam, scraping, bypassing access controls, bypassing paid access, or any activity that violates third-party terms or rights.

Use it at your own risk. The maintainers are not responsible for account restrictions, service interruptions, data loss, legal issues, or other consequences arising from your use. This notice is not legal advice.

## 🚀 Install From Source

Prerequisites:

- Node.js 20+
- npm
- Chrome or another Chromium-based browser

Build the extension:

```bash
npm install
npm run build
```

Load it in Chrome:

1. Open `chrome://extensions/`.
2. Turn on Developer mode.
3. Click **Load unpacked**.
4. Select the generated `dist/` directory.
5. Click the OpenTeam extension icon to open the team workspace.

If you change `public/manifest.json`, `public/openteam-frame-rules.json`, or content scripts, reload the extension from `chrome://extensions/`.

## 🛠️ Development

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm run typecheck
npm test
npm run test:e2e
npm run build
npm run verify
```

`npm run verify` runs type checking, unit tests, E2E harness tests, and a production build.

## 🤖 CLI

OpenTeam includes a local CLI package for agent-controlled group chats.

```bash
npm run openteamcli -- doctor
npm run openteamcli -- daemon start
npm run openteamcli -- chat list
```

See [packages/openteamcli/README.md](packages/openteamcli/README.md) for CLI install and publishing notes.

## 🔐 Permissions and Privacy

OpenTeam is local-first, but it needs browser-extension permissions that are worth reviewing before installation:

- `storage`: save chats, people, notes, settings, and local state.
- `tabs`: locate and communicate with extension and AI-site tabs/frames.
- `alarms`: schedule runtime maintenance tasks.
- `declarativeNetRequest`: adjust response headers so supported AI websites can be embedded in the extension iframe workspace.
- `clipboardRead` / `clipboardWrite`: support copy and clipboard-based interactions.
- Host permissions: allow OpenTeam to work with supported AI websites and embedded web sessions.

OpenTeam does not provide cloud sync. Your AI conversations are still processed by the AI websites you use, under their own account rules, usage limits, privacy policies, and terms of service.

## 🚧 Current Limits

- OpenTeam is Chrome / Chromium-first.
- AI-site adapters depend on page DOM structure, so website redesigns can break prompt sending or reply capture.
- The iframe workspace requires response-header changes through `declarativeNetRequest`, which makes the permission surface heavier than a normal popup extension.
- Built-in famous-person advisor templates are prompt templates inspired by public ideas. They are not real people and should not be presented as real participation.
- Medical, legal, financial, and other high-stakes outputs still require human judgment and qualified professional advice.

## 🗂️ Repository Layout

```text
public/                 Chrome extension manifest, team page, styles, DNR rules
src/background/         service worker, command handlers, runtime routing
src/content/            AI-site content scripts, adapters, reply observation
src/group/              group data model, store, roles, prompts, mention parsing
src/teamPage/           OpenTeam workspace UI
packages/openteamcli/   local CLI and daemon for agent control
docs/                   design documents and assets
```

## 🤝 Contributing

Issues and pull requests are welcome. Good starting areas include:

- AI-site adapter fixes when target websites change.
- Permission and privacy hardening.
- Test coverage for group routing, prompt construction, storage, and UI flows.
- Documentation, examples, and onboarding improvements.
- New advisor templates or orchestration patterns with clear boundaries.

Before opening a pull request, run:

```bash
npm run verify
```

## 📚 Documentation

- [Design document](docs/DESIGN.md)
- [OpenTeam CLI](packages/openteamcli/README.md)

## 📜 License

OpenTeam is released under the [PolyForm Noncommercial License 1.0.0](LICENSE), using the SPDX identifier `PolyForm-Noncommercial-1.0.0`.

You may use, study, modify, and redistribute the project for non-commercial purposes only. Commercial use, commercial redistribution, hosted commercial services, paid workflows, and productized commercial use are not permitted without separate written permission.
