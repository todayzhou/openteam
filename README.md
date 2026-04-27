# OpenTeam

OpenTeam 是一个面向 Gemini 的浏览器插件项目，目标是在 Gemini 页面中注入团队面板，让多个后台 Gemini 对话作为不同角色 AI 加入同一个讨论组。

当前代码已经清理为团队模式的基础骨架：

- Manifest V3 浏览器插件配置
- Gemini 页面 content script
- Gemini 回复 DOM 变化监听与文本清洗
- 向 Gemini 输入框填入内容并发送的基础能力
- 团队模式设计文档

设计文档见：

```text
docs/superpowers/specs/2026-04-27-gemini-team-mode-design.md
```

## 安装依赖

```bash
npm install
```

## 开发

```bash
npm run dev
```

## 打包

```bash
npm run build
```

打包后的 Chrome 扩展文件在 `dist/` 目录。
