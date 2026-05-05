# OpenTeam 内测使用说明

这是一份给内测用户的快速安装说明。当前版本是 Chrome 浏览器扩展，需要手动加载本地扩展包。

## 内测码

```text
OT-OPEN-TEAM-2026
```

首次打开 OpenTeam 时输入上面的内测码即可激活。激活后本机可使用 30 天。

## 安装包

扩展安装包：

[openteam-beta-20260505.zip](./openteam-beta-20260505.zip)

使用前请先把这个 zip 解压成文件夹。Chrome 加载本地扩展时需要选择解压后的文件夹，不能直接选择 zip 文件。

## 安装步骤

1. 下载并解压 `openteam-beta-20260505.zip`。
2. 打开 Chrome 浏览器，在地址栏输入：

```text
chrome://extensions/
```

3. 打开右上角的「开发者模式」。
4. 点击「加载已解压的扩展程序」。
5. 选择刚才解压出来的 OpenTeam 文件夹。
6. 安装成功后，点击浏览器右上角扩展图标里的 OpenTeam。
7. 第一次打开时输入内测码：

```text
OT-OPEN-TEAM-2026
```

8. 进入 OpenTeam 后，可以创建群聊、添加人员，并为人员选择 ChatGPT、Claude、Gemini、DeepSeek 等 AI 站点。

## 使用前准备

OpenTeam 调用的是你浏览器里已经登录的 AI 网页账号，不需要配置 API Key。

建议先在 Chrome 里登录你要使用的 AI 网站：

- ChatGPT: `https://chatgpt.com/`
- Claude: `https://claude.ai/`
- Gemini: `https://gemini.google.com/`
- DeepSeek: `https://chat.deepseek.com/`

如果某个站点没有登录，OpenTeam 里的对应人员可能会停在登录页，需要你先完成登录。

## 常见问题

### 输入内测码后还是进不去

请检查是否完整输入：

```text
OT-OPEN-TEAM-2026
```

大小写不敏感，但建议直接复制粘贴。

### 安装时找不到文件

Chrome 需要加载「解压后的文件夹」，不是 zip 文件。请先解压 `openteam-beta-20260505.zip`，再选择解压后的目录。

### 为什么要开开发者模式

当前是内测版，还没有上架 Chrome Web Store，所以需要通过开发者模式手动加载。

### 有效期多久

输入内测码激活后，本机可使用 30 天。到期后会重新显示激活页面。

## 加入内测群

群二维码待补充。

后续可以把群二维码图片放在当前目录，例如：

```text
wechat-group-qr.png
```

然后把下面这一行取消注释或替换成实际图片：

```markdown
![OpenTeam 内测群](./wechat-group-qr.png)
```

## 反馈建议

欢迎在内测群里反馈：

- 安装是否顺利
- 哪个 AI 站点不可用
- 哪个页面卡住或没有回复
- 你希望内置哪些专家或角色
- 哪些工作流最适合用 OpenTeam
