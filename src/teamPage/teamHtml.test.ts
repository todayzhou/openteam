import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function readTeamHtml(): string {
  return readFileSync(resolve(process.cwd(), 'public/team.html'), 'utf8')
}

function readTeamCss(): string {
  return readFileSync(resolve(process.cwd(), 'public/team.css'), 'utf8')
}

function readTeamDocument(): string {
  return `${readTeamHtml()}\n${readTeamCss()}`
}

describe('team.html chat creation UI', () => {
  it('loads team styles from an external stylesheet', () => {
    const html = readTeamHtml()
    const css = readTeamCss()

    expect(html).toContain('<link rel="stylesheet" href="team.css" />')
    expect(html).not.toContain('<style>')
    expect(html).not.toContain('</style>')
    expect(css).toContain(':root')
    expect(css).toContain('body {')
  })

  it('offers an explicit chat mode choice before creating a chat from the plus button', () => {
    const html = readTeamDocument()

    expect(html).toContain('id="chat-create-popover"')
    expect(html).toContain('id="new-chat-mode-independent"')
    expect(html).toContain('id="new-chat-mode-collaborative"')
    expect(html).toContain('协作群聊')
  })

  it('includes the people-library workflows, right drawer, iframe host, and minimized launcher', () => {
    const html = readTeamDocument()

    expect(html).toContain('id="settings-button"')
    expect(html).toContain('id="settings-menu"')
    expect(html).toContain('id="open-people-library"')
    expect(html).not.toContain('id="default-site-gemini"')
    expect(html).not.toContain('id="default-site-chatgpt"')
    expect(html).not.toContain('id="default-site-claude"')
    expect(html).not.toContain('id="default-site-deepseek"')
    expect(html).not.toContain('id="default-site-kimi"')
    expect(html).not.toContain('id="default-site-qwen"')
    expect(html).toContain('id="people-library-modal"')
    expect(html).toContain('id="people-library-list"')
    expect(html).toContain('id="template-site-gemini"')
    expect(html).toContain('id="template-site-chatgpt"')
    expect(html).toContain('id="template-site-claude"')
    expect(html).toContain('id="template-site-deepseek"')
    expect(html).toContain('id="template-site-qwen"')
    expect(html).toContain('id="template-site-kimi"')
    expect(html).toContain('for="template-site-qwen" hidden')
    expect(html).toContain('for="template-site-kimi" hidden')
    expect(html).toMatch(/\.site-segment\[hidden\]\s*{[^}]*display:\s*none;/s)
    expect(html).toContain('id="add-person-modal"')
    expect(html).toContain('id="open-temporary-person"')
    expect(html).toContain('id="temporary-person-modal"')
    expect(html).toContain('id="add-library-people-form"')
    expect(html).toContain('id="add-temporary-person-form"')
    expect(html).toContain('id="toggle-people-drawer"')
    expect(html).toContain('class="panel role-panel"')
    expect(html).toContain('id="close-people-drawer"')
    expect(html).toContain('id="window-launcher"')
    expect(html).toContain('id="iframe-host"')
    expect(html).toContain('人员库')
    expect(html).toContain('人设')
    expect(html).toContain('站点')
    expect(html).not.toContain('System Prompt')
  })

  it('uses template default sites for library people and the add-person picker for temporary people', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/peopleLibraryView.ts'), 'utf8')

    expect(source).toContain('function addPersonSiteControl(itemKey: string, chatSite: ChatSite): HTMLElement')
    expect(source).toContain('const chatSite = deps.state.addPersonSiteByKey.get(item.key) ?? item.chatSite')
    expect(source).toContain("if (item.source === 'library') return { source: 'library', roleTemplateId: item.roleTemplateId, chatSite }")
    expect(source).toContain("source: 'temporary'")
    expect(source).toContain("if (deps.templateSiteClaudeEl.checked) return 'claude'")
    expect(source).toContain("if (deps.templateSiteDeepSeekEl.checked) return 'deepseek'")
    expect(source).toContain("const VISIBLE_CHAT_SITES = ['gemini', 'chatgpt', 'claude', 'deepseek'] as const")
    expect(source).not.toContain("if (deps.templateSiteKimiEl.checked) return 'kimi'")
    expect(source).not.toContain("if (deps.templateSiteQwenEl.checked) return 'qwen'")
  })

  it('stores a default target site on people-library entries instead of the settings menu', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/peopleLibraryView.ts'), 'utf8')
    const domRefsSource = readFileSync(resolve(process.cwd(), 'src/teamPage/domRefs.ts'), 'utf8')

    expect(source).not.toContain("'#default-site-gemini'")
    expect(source).not.toContain("'#default-site-chatgpt'")
    expect(source).not.toContain("'#default-site-claude'")
    expect(source).not.toContain("'#default-site-deepseek'")
    expect(source).not.toContain("'#default-site-kimi'")
    expect(source).not.toContain("'#default-site-qwen'")
    expect(domRefsSource).toContain('templateSiteGeminiEl')
    expect(source).toContain('function readTemplateChatSite(): ChatSite')
    expect(source).toContain('defaultChatSite: readTemplateChatSite()')
    expect(source).toContain('template.defaultChatSite ?? store.settings.defaultChatSite')
    expect(html).not.toContain('默认站点：Gemini')
    expect(html).not.toContain('默认站点：ChatGPT')
    expect(html).not.toContain('默认站点：Claude')
    expect(html).not.toContain('默认站点：DeepSeek')
    expect(html).not.toContain('默认站点：Kimi')
    expect(html).not.toContain('默认站点：千问')
  })

  it('keeps the people-library modal as a list and opens a separate editor for creating or editing people', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/peopleLibraryView.ts'), 'utf8')
    const domRefsSource = readFileSync(resolve(process.cwd(), 'src/teamPage/domRefs.ts'), 'utf8')
    const peopleLibraryModal = html.match(/<div id="people-library-modal"[\s\S]*?<div id="person-template-modal"/)?.[0] ?? ''
    const personTemplateModal = html.match(/<div id="person-template-modal"[\s\S]*?<div id="add-person-modal"/)?.[0] ?? ''

    expect(html).toContain('id="new-template"')
    expect(html).toContain('id="person-template-modal"')
    expect(html).toContain('id="close-person-template"')
    expect(peopleLibraryModal).not.toContain('id="people-library-form"')
    expect(peopleLibraryModal).not.toContain('id="template-name"')
    expect(personTemplateModal).not.toContain('id="delete-template"')
    expect(source).toContain('function openTemplateEditor(templateId?: string): void')
    expect(source).toContain("edit.className = 'btn btn-ghost template-edit'")
    expect(source).toContain("edit.textContent = '编辑'")
    expect(source).toContain("remove.className = 'btn btn-danger template-delete'")
    expect(source).toContain("remove.textContent = '删除'")
    expect(source).toContain('window.confirm(`确定删除「${template.name}」吗？删除后这个人员会从人员库移除。`)')
    expect(source).toContain('if (!isTemplateUsed(template.id)) actions.append(remove)')
    expect(domRefsSource).toContain("'#new-template'")
    expect(domRefsSource).toContain("'#close-person-template'")
  })

  it('keeps long people-library lists scrolling inside the left list pane', () => {
    const html = readTeamDocument()

    expect(html).toMatch(/#people-library-modal \.modal\s*{[^}]*overflow:\s*hidden;/s)
    expect(html).toMatch(/#people-library-list\s*{[^}]*overflow:\s*auto;/s)
    expect(html).toMatch(/#people-library-list\s*{[^}]*max-height:\s*calc\(100vh - 220px\);/s)
  })

  it('shows role sites as compact pills with a menu instead of always-visible switch buttons', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/rolePanelView.ts'), 'utf8')

    expect(source).toContain("sitePill.className = `site-pill site-pill-${role.chatSite ?? 'gemini'}`")
    expect(source).toContain("menu.className = 'role-site-menu'")
    expect(source).toContain("option.className = `role-site-option${role.chatSite === site ? ' active' : ''}`")
    expect(source).not.toContain("siteActions.className = 'chat-row tiny'")
    expect(html).toMatch(/\.site-pill\s*{[^}]*border-radius:\s*999px;/s)
    expect(html).toMatch(/\.role-site-menu\s*{[^}]*position:\s*absolute;/s)
  })

  it('does not keep a global add-person site picker', () => {
    const html = readTeamDocument()

    expect(html).not.toContain('name="add-person-chat-site"')
    expect(html).not.toContain('为这次加入群聊的人员统一指定 Gemini。')
    expect(html).not.toContain('为这次加入群聊的人员统一指定 ChatGPT。')
    expect(html).not.toContain('为这次加入群聊的人员统一指定 Claude。')
    expect(html).not.toContain('为这次加入群聊的人员统一指定千问。')
  })

  it('uses a clean page background without decorative side panels', () => {
    const html = readTeamDocument()

    expect(html).not.toContain('body::before')
    expect(html).not.toContain('body::after')
    expect(html).toContain('--bg: #000000;')
    expect(html).toMatch(/body\s*{[^}]*background:\s*var\(--bg\);/s)
  })

  it('styles iframe background groups with chat and role labels', () => {
    const html = readTeamDocument()

    expect(html).toContain('.chat-frame-group-title')
    expect(html).toContain('.role-frame-shell')
    expect(html).toContain('.role-frame-label')
    expect(html).toMatch(/\.chat-frame-group-title\s*{[^}]*grid-column:\s*1 \/ -1;/s)
    expect(html).toMatch(/\.chat-frame-group-title\s*{[^}]*position:\s*sticky;/s)
    expect(html).toMatch(/\.chat-frame-group-title\s*{[^}]*top:\s*0;/s)
    expect(html).toMatch(/\.chat-frame-group-title\s*{[^}]*z-index:\s*2;/s)
    expect(html).toMatch(/\.role-frame-shell\s*{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);/s)
  })

  it('lays iframe chat groups as one group per row with up to three role frames per group', () => {
    const html = readTeamDocument()
    const hostRule = html.match(/#iframe-host\s*{(?<body>[^}]*)}/)?.groups?.body ?? ''
    const groupRule = html.match(/#iframe-host \.chat-frame-group\s*{(?<body>[^}]*)}/)?.groups?.body ?? ''

    expect(hostRule).toContain('display: flex;')
    expect(hostRule).toContain('flex-direction: column;')
    expect(hostRule).toContain('background: #000000;')
    expect(hostRule).toContain('scroll-snap-type: y proximity;')
    expect(hostRule).not.toContain('grid-template-columns')
    expect(html).not.toContain('#iframe-host::after')
    expect(groupRule).toContain('grid-template-columns: repeat(3, minmax(0, 1fr));')
    expect(groupRule).toContain('grid-auto-rows: calc(100vh - 92px);')
    expect(groupRule).toContain('height: calc(100vh - 28px);')
    expect(groupRule).toContain('flex: 0 0 calc(100vh - 28px);')
    expect(groupRule).toContain('scroll-snap-align: start;')
    expect(groupRule).toContain('overflow: auto;')
    expect(groupRule).not.toContain('opacity:')
    expect(groupRule).not.toContain('auto-fit')
    expect(html).not.toMatch(/#iframe-host \.chat-frame-group\.background\s*{[^}]*opacity:/s)
  })

  it('makes the selected iframe chat group visibly highlighted without changing its layout', () => {
    const html = readTeamDocument()
    const activeGroupRule = html.match(/#iframe-host \.chat-frame-group\.active\s*{(?<body>[^}]*)}/)?.groups?.body ?? ''

    expect(activeGroupRule).toContain('outline: 2px solid rgba(47, 216, 204, 0.55);')
    expect(activeGroupRule).toContain('outline-offset: -2px;')
    expect(activeGroupRule).not.toContain('height')
    expect(activeGroupRule).not.toContain('grid-row')
    expect(activeGroupRule).not.toContain('transform')
  })

  it('does not render person settings inside the people drawer', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/index.ts'), 'utf8')

    expect(html).not.toContain('id="role-editor"')
    expect(html).not.toContain('人员设置')
    expect(html).not.toContain('id="edit-role-name"')
    expect(html).not.toContain('id="edit-role-description"')
    expect(html).not.toContain('id="edit-role-prompt"')
    expect(html).not.toContain('id="recover-role"')
    expect(html).not.toContain('id="initialize-role"')
    expect(html).not.toContain('id="new-role-name"')
    expect(source).not.toContain("'#role-editor'")
    expect(source).not.toContain("'#edit-role-name'")
    expect(source).not.toContain("'#recover-role'")
    expect(source).not.toContain("'#initialize-role'")
  })

  it('renders chat actions through a three-dot menu that updates, duplicates, and deletes chats', () => {
    const html = readTeamDocument()
    const chatListSource = readFileSync(resolve(process.cwd(), 'src/teamPage/chatListView.ts'), 'utf8')

    expect(chatListSource).toContain("menuButton.className = 'icon-btn chat-menu-btn'")
    expect(chatListSource).toContain("menuButton.textContent = '⋯'")
    expect(chatListSource).toContain("menu.className = 'chat-action-menu'")
    expect(chatListSource).toContain("rename.textContent = '编辑名称'")
    expect(chatListSource).toContain("duplicate.textContent = '复制群聊'")
    expect(chatListSource).toContain("clearMessages.textContent = '清空消息'")
    expect(chatListSource).toContain("closeFrames.textContent = '关闭群聊'")
    expect(chatListSource).toContain("remove.textContent = '删除群聊'")
    expect(chatListSource).toContain("runCommand('GROUP_CHAT_CLEAR_MESSAGES'")
    expect(chatListSource).toContain("runCommand('GROUP_CHAT_CLOSE'")
    expect(chatListSource).toContain("runCommand('GROUP_CHAT_UPDATE'")
    expect(chatListSource).toContain("runCommand('GROUP_CHAT_DUPLICATE'")
    expect(chatListSource).toContain("sendRuntimeMessage('GROUP_CHAT_DELETE'")
    expect(chatListSource).toContain("response.error === 'Unknown OpenTeam message'")
    expect(chatListSource).toContain('deleteChatFromLocalStore(chatId)')
    expect(html).toMatch(/\.chat-action-menu\s*{[^}]*position:\s*absolute;/s)
    expect(html).toMatch(/\.chat-action-menu\s*{[^}]*right:\s*14px;/s)
    expect(html).not.toMatch(/\.chat-action-menu\s*{[^}]*grid-column:\s*2 \/ 4;/s)
  })

  it('renders compact icon actions for assistant messages', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/messagesView.ts'), 'utf8')
    const recoverySource = readFileSync(resolve(process.cwd(), 'src/teamPage/roleRecoveryController.ts'), 'utf8')

    expect(source).toContain("createMessageIconButton('跳转到原始窗口'")
    expect(source).toContain("createMessageIconButton('引用回复'")
    expect(source).toContain("createMessageIconButton('复制回复'")
    expect(source).toContain('showCopyFeedback(button)')
    expect(source).toContain("button.setAttribute('aria-label', '已复制')")
    expect(source).toContain("setMessageButtonIcon(button, 'check')")
    expect(source).toContain("setMessageButtonIcon(button, 'copy')")
    expect(source).toContain('deps.focusRoleFrame(message.chatId, message.roleId)')
    expect(source).toContain('copyMessageContent(message)')
    expect(source).toContain('navigator.clipboard.writeText(message.content)')
    expect(source).not.toContain("jump.textContent = '跳转'")
    expect(source).not.toContain("quote.textContent = '引用'")
    expect(recoverySource).toContain('setWindowMinimized(true)')
    expect(html).toContain('.role-frame-shell.jump-highlight')
    expect(html).toContain('.message-tool-btn')
    expect(html).toContain('.message-tool-btn::after')
    expect(html).toContain('content: attr(aria-label);')
    expect(source).not.toContain('button.title = label')
    expect(html).not.toMatch(/\.message-row\.assistant:hover \.message-tools/)
    expect(html).toMatch(/\.message-row\.thinking \.message-tools,\s*\.message-row\.stopped \.message-tools\s*{[^}]*opacity:\s*0;/s)
    expect(html).toMatch(/\.message-row\.thinking:hover \.message-tools,/s)
    expect(source).toContain("createMessageIconButton('停止回复'")
    expect(source).toContain("createMessageIconButton('重新发送'")
    expect(source).not.toContain("打断重试")
    expect(recoverySource).toContain("runCommand('GROUP_ROLE_STOP_REPLY'")
    expect(recoverySource).toContain("runCommand('GROUP_ROLE_RETRY_REPLY'")
  })

  it('keeps add-person sites per person and moves temporary people into a separate draft flow', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/peopleLibraryView.ts'), 'utf8')
    const addPersonModal = html.match(/<div id="add-person-modal"[\s\S]*?<div id="temporary-person-modal"/)?.[0] ?? ''
    const temporaryModal = html.match(/<div id="temporary-person-modal"[\s\S]*?<div id="iframe-host"/)?.[0] ?? ''

    expect(addPersonModal).toContain('id="open-temporary-person"')
    expect(addPersonModal).not.toContain('id="add-person-site-gemini"')
    expect(addPersonModal).not.toContain('id="add-person-site-chatgpt"')
    expect(addPersonModal).not.toContain('id="add-person-site-claude"')
    expect(addPersonModal).not.toContain('id="add-person-site-deepseek"')
    expect(addPersonModal).not.toContain('id="add-person-site-kimi"')
    expect(addPersonModal).not.toContain('id="add-temporary-person-form"')
    expect(temporaryModal).toContain('id="add-temporary-person-form"')
    expect(temporaryModal).toContain('id="close-temporary-person"')
    expect(source).toContain('temporaryPersonDrafts')
    expect(source).toContain('addPersonSiteControl')
    expect(source).toContain('selectedAddPersonItems()')
  })

  it('shows an add-person call to action when the selected chat has no people', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/messagesView.ts'), 'utf8')

    expect(source).toContain("emptyChatPeopleCard('暂无人员'")
    expect(source).toContain("button.textContent = '添加人员'")
    expect(source).toContain('deps.openAddPersonDialog')
  })

  it('switches chats from the whole chat row while keeping row menus isolated', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/chatListView.ts'), 'utf8')

    expect(source).toContain("item.addEventListener('click', () => switchChat(chat.id))")
    expect(source).toContain("item.addEventListener('keydown'")
    expect(source).toContain("item.tabIndex = 0")
    expect(source).toContain("item.setAttribute('role', 'button')")
    expect(source).toContain("menu.addEventListener('click', event => event.stopPropagation())")
  })

  it('hides the reference draft until quoting and keeps quoted text to one line', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/composerView.ts'), 'utf8')

    expect(html).toMatch(/\.reference-draft\[hidden\]\s*{[^}]*display:\s*none;/s)
    expect(html).toMatch(/\.reference-draft-preview\s*{[^}]*white-space:\s*nowrap;/s)
    expect(html).toMatch(/\.reference-draft-preview\s*{[^}]*text-overflow:\s*ellipsis;/s)
    expect(source).toContain("preview.className = 'reference-draft-preview'")
    expect(source).not.toContain("title.textContent = `引用 ${selectedReference.roleName || '人员'} 的观点`")
  })

  it('positions the mention panel next to the composer input instead of the right action area', () => {
    const html = readTeamDocument()

    expect(html).toMatch(/\.mention-panel\s*{[^}]*left:\s*12px;/s)
    expect(html).toMatch(/\.mention-panel\s*{[^}]*bottom:\s*calc\(100% \+ 8px\);/s)
    expect(html).toMatch(/\.mention-panel\s*{[^}]*width:\s*min\(280px,\s*calc\(100% - 24px\)\);/s)
    expect(html).not.toMatch(/\.mention-panel\s*{[^}]*right:\s*78px;/s)
  })

  it('makes the refresh control sync and recover the current chat', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/roleRecoveryController.ts'), 'utf8')
    const uiSource = readFileSync(resolve(process.cwd(), 'src/teamPage/teamUiController.ts'), 'utf8')

    expect(html).toContain('aria-label="同步并恢复当前群聊"')
    expect(html).toContain('title="同步并恢复当前群聊"')
    expect(source).toContain('async function refreshCurrentChat()')
    expect(source).toContain("log.info('ui:refresh-recover-chat'")
    expect(uiSource).toContain('refreshCurrentChat().catch')
  })

  it('asks for confirmation before closing the OpenTeam window', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/teamUiController.ts'), 'utf8')

    expect(source).toContain("window.confirm('确定要关闭 OpenTeam 窗口吗？')")
    expect(source).toContain('window.close()')
  })

  it('uses a lighter composer and simplified chat header', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/chatHeaderView.ts'), 'utf8')
    const uiSource = readFileSync(resolve(process.cwd(), 'src/teamPage/teamUiController.ts'), 'utf8')

    expect(html).toContain('placeholder="输入消息，@成员可指定回复；不 @ 默认发给全部成员。"')
    expect(html).toMatch(/\.chat-header\s*{[^}]*min-height:\s*72px;/s)
    expect(html).toMatch(/\.chat-header\s*{[^}]*padding:\s*16px 132px 14px 22px;/s)
    expect(html).toMatch(/\.composer\s*{[^}]*margin:\s*0 22px 18px;/s)
    expect(html).toMatch(/\.composer\s*{[^}]*border:\s*1px solid rgba\(132,\s*153,\s*171,\s*0\.22\);/s)
    expect(html).toMatch(/\.drawer-summary\s*{[^}]*min-height:\s*30px;/s)
    expect(source).toContain("togglePeopleDrawerEl.textContent = '成员 0'")
    expect(source).toContain('deps.togglePeopleDrawerEl.textContent = `成员 ${roles.length}`')
    expect(source).toContain("deps.togglePeopleDrawerEl.setAttribute('aria-label', deps.state.peopleDrawerOpen ? '收起成员面板' : '打开成员面板')")
    expect(uiSource).toContain('deps.state.peopleDrawerOpen && target && !deps.rolePanelEl.contains(target) && !deps.togglePeopleDrawerEl.contains(target)')
    expect(uiSource).toContain('deps.state.peopleDrawerOpen = false')
    expect(source).not.toContain('人回复中')
  })

  it('places user messages on the right like a WeChat conversation', () => {
    const html = readTeamDocument()

    expect(html).toMatch(/\.message-row\.user\s*{[^}]*justify-content:\s*flex-end;/s)
    expect(html).toMatch(/\.message-row\.user \.message-inner\s*{[^}]*flex-direction:\s*row-reverse;/s)
    expect(html).toMatch(/\.message-row\.user \.message-bubble\s*{[^}]*background:\s*#35d18c;/s)
    expect(html).toMatch(/\.message-row\.user \.message-bubble::before\s*{[^}]*border-left-color:\s*#35d18c;/s)
    expect(html).not.toContain('.message-content')
  })

  it('renders time dividers and system messages as centered pills', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/messagesView.ts'), 'utf8')

    expect(source).toContain("divider.className = 'message-time-divider'")
    expect(source).toContain("pill.className = 'message-system-pill'")
    expect(html).toMatch(/\.message-time-divider\s*{[^}]*align-self:\s*center;/s)
    expect(html).toMatch(/\.message-system-pill\s*{[^}]*border-radius:\s*999px;/s)
  })

  it('renders explicit mentions inline inside user message bubbles', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/messagesView.ts'), 'utf8')

    expect(source).toContain('renderMessageMentions(message)')
    expect(source).toContain('appendMentionsToBody(body, mentions)')
    expect(source).toContain('message.mentionedRoleIds')
    expect(source).toContain("mention.textContent = `@${name}`")
    expect(html).toMatch(/\.message-mentions\s*{[^}]*display:\s*inline-flex;/s)
    expect(html).toMatch(/\.message-mention\s*{[^}]*font-weight:\s*820;/s)
  })

  it('renders copied markdown replies with markdown-it while keeping other messages on the plain-text renderer', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/messagesView.ts'), 'utf8')

    expect(source).toContain('shouldRenderMarkdownMessage(message)')
    expect(source).toContain("message.contentFormat === 'markdown' || message.type === 'assistant'")
    expect(source).toContain('renderMarkdownMessageBody(body, message.content)')
    expect(source).toContain('renderPlainMessageBody(body, message.content)')
    expect(source).toContain('pill.textContent = message.content')
    expect(source).toContain('MarkdownIt')
    expect(source).toContain('body.innerHTML = markdownRenderer.render(content)')
    expect(html).toMatch(/\.message-body\s*{[^}]*white-space:\s*pre-wrap;/s)
    expect(html).toContain('.message-body.markdown-body')
  })

  it('keeps chat titles as plain text and omits chat status from list rows', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/chatListView.ts'), 'utf8')

    expect(source).toContain("name.className = 'chat-name'")
    expect(source).not.toContain("name.className = 'chat-name btn btn-ghost'")
    expect(source).not.toContain("meta.className = 'chat-meta tiny'")
    expect(source).not.toContain('statusPill(chat.status')
    expect(html).not.toContain('.chat-meta')
    expect(html).not.toContain('.chat-item .chat-name::before')
  })

  it('uses a WeChat-like chat list row with avatar, body, and right time column', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/chatListView.ts'), 'utf8')

    expect(source).toContain("avatar.className = `chat-avatar ${deps.roleToneClass(chat.name)}`")
    expect(source).toContain("body.className = 'chat-item-body'")
    expect(source).toContain("side.className = 'chat-item-side'")
    expect(source).toContain("time.className = 'chat-time'")
    expect(source).toContain("time.textContent = formatChatListTime(chat.updatedAt)")
    expect(source).not.toContain("textNode(`${chat.roleIds.length} 人员 · ${formatTime(chat.updatedAt)}`)")
    expect(html).toMatch(/\.chat-item\s*{[^}]*grid-template-columns:\s*44px minmax\(0, 1fr\) auto;/s)
    expect(html).toContain('.chat-avatar')
    expect(html).toContain('.chat-time')
    expect(html).toMatch(/\.chat-time\s*{[^}]*font-size:\s*10px;/s)
    expect(html).toMatch(/\.summary-line\s*{[^}]*white-space:\s*nowrap;/s)
    expect(html).toMatch(/\.summary-line\s*{[^}]*text-overflow:\s*ellipsis;/s)
  })

  it('keeps chat switching to one store write and one store application', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/chatListView.ts'), 'utf8')
    const runtimeSource = readFileSync(resolve(process.cwd(), 'src/teamPage/runtimeClient.ts'), 'utf8')

    expect(source).toContain("runCommand('GROUP_CHAT_SWITCH', { chatId })")
    expect(source).toContain('deps.renderSelectedChat()')
    expect(source).toContain('window.requestAnimationFrame(() => {')
    expect(source).not.toContain("runCommand('GROUP_CHAT_MARK_READ', { chatId })")
    expect(runtimeSource).toMatch(/if \(response\.store\) \{\s*deps\.applyStore\(response\.store\)\s*return\s*\}/s)
    expect(runtimeSource).not.toMatch(/if \(response\.store\) deps\.applyStore\(response\.store\)\s*await deps\.refreshStore\(false\)/s)
  })

  it('avoids layout-changing iframe group transitions while switching chats', () => {
    const html = readTeamDocument()
    const activeGroupRule = html.match(/#iframe-host \.chat-frame-group\.active\s*{(?<body>[^}]*)}/)?.groups?.body ?? ''
    const groupRule = html.match(/#iframe-host \.chat-frame-group\s*{(?<body>[^}]*)}/)?.groups?.body ?? ''

    expect(activeGroupRule).not.toContain('grid-row')
    expect(activeGroupRule).not.toContain('transform')
    expect(groupRule).not.toContain('transform: scale')
    expect(groupRule).not.toMatch(/transition:[^;]*transform/)
  })

  it('reuses rendered message nodes so returning to a chat is cheap', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/messagesView.ts'), 'utf8')

    expect(source).toContain('messageNodeCache')
    expect(source).toContain('renderMessageNode(item.message, item.showName, item.showAvatar)')
    expect(source).toContain('messageSignature(message, showName, showAvatar)')
  })
})
