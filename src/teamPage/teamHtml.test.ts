import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('team.html chat creation UI', () => {
  it('offers an explicit chat mode choice before creating a chat from the plus button', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/team.html'), 'utf8')

    expect(html).toContain('id="chat-create-popover"')
    expect(html).toContain('id="new-chat-mode-independent"')
    expect(html).toContain('id="new-chat-mode-collaborative"')
    expect(html).toContain('协作群聊')
  })

  it('includes the people-library workflows, right drawer, iframe host, and minimized launcher', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/team.html'), 'utf8')

    expect(html).toContain('id="settings-button"')
    expect(html).toContain('id="settings-menu"')
    expect(html).toContain('id="open-people-library"')
    expect(html).toContain('id="people-library-modal"')
    expect(html).toContain('id="people-library-list"')
    expect(html).toContain('id="add-person-modal"')
    expect(html).toContain('id="add-library-people-form"')
    expect(html).toContain('id="add-temporary-person-form"')
    expect(html).toContain('id="toggle-people-drawer"')
    expect(html).toContain('class="panel role-panel"')
    expect(html).toContain('id="close-people-drawer"')
    expect(html).toContain('id="window-launcher"')
    expect(html).toContain('id="iframe-host"')
    expect(html).toContain('人员库')
    expect(html).toContain('人设')
    expect(html).not.toContain('System Prompt')
  })

  it('uses a clean page background without decorative side panels', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/team.html'), 'utf8')

    expect(html).not.toContain('body::before')
    expect(html).not.toContain('body::after')
    expect(html).toContain('--bg: #000000;')
    expect(html).toMatch(/body\s*{[^}]*background:\s*var\(--bg\);/s)
  })

  it('styles iframe background groups with chat and role labels', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/team.html'), 'utf8')

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
    const html = readFileSync(resolve(process.cwd(), 'public/team.html'), 'utf8')
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
    const html = readFileSync(resolve(process.cwd(), 'public/team.html'), 'utf8')
    const activeGroupRule = html.match(/#iframe-host \.chat-frame-group\.active\s*{(?<body>[^}]*)}/)?.groups?.body ?? ''

    expect(activeGroupRule).toContain('outline: 2px solid rgba(47, 216, 204, 0.55);')
    expect(activeGroupRule).toContain('outline-offset: -2px;')
    expect(activeGroupRule).not.toContain('height')
    expect(activeGroupRule).not.toContain('grid-row')
    expect(activeGroupRule).not.toContain('transform')
  })

  it('does not render person settings inside the people drawer', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/team.html'), 'utf8')
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

  it('renders chat actions through a three-dot menu that updates chat names', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/team.html'), 'utf8')
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/index.ts'), 'utf8')

    expect(source).toContain("menuButton.className = 'icon-btn chat-menu-btn'")
    expect(source).toContain("menuButton.textContent = '⋯'")
    expect(source).toContain("menu.className = 'chat-action-menu'")
    expect(source).toContain("rename.textContent = '编辑名称'")
    expect(source).toContain("remove.textContent = '删除群聊'")
    expect(source).toContain("runCommand('GROUP_CHAT_UPDATE'")
    expect(source).toContain("sendRuntimeMessage('GROUP_CHAT_DELETE'")
    expect(source).toContain("response.error === 'Unknown OpenTeam message'")
    expect(source).toContain('deleteChatFromLocalStore(chatId)')
    expect(html).toMatch(/\.chat-action-menu\s*{[^}]*position:\s*absolute;/s)
    expect(html).toMatch(/\.chat-action-menu\s*{[^}]*right:\s*14px;/s)
    expect(html).not.toMatch(/\.chat-action-menu\s*{[^}]*grid-column:\s*2 \/ 4;/s)
  })

  it('switches chats from the whole chat row while keeping row menus isolated', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/index.ts'), 'utf8')

    expect(source).toContain("item.addEventListener('click', () => switchChat(chat.id))")
    expect(source).toContain("item.addEventListener('keydown'")
    expect(source).toContain("item.tabIndex = 0")
    expect(source).toContain("item.setAttribute('role', 'button')")
    expect(source).toContain("menu.addEventListener('click', event => event.stopPropagation())")
  })

  it('hides the reference draft until quoting and keeps quoted text to one line', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/team.html'), 'utf8')
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/index.ts'), 'utf8')

    expect(html).toMatch(/\.reference-draft\[hidden\]\s*{[^}]*display:\s*none;/s)
    expect(html).toMatch(/\.reference-draft-preview\s*{[^}]*white-space:\s*nowrap;/s)
    expect(html).toMatch(/\.reference-draft-preview\s*{[^}]*text-overflow:\s*ellipsis;/s)
    expect(source).toContain("preview.className = 'reference-draft-preview'")
    expect(source).not.toContain("title.textContent = `引用 ${selectedReference.roleName || '人员'} 的观点`")
  })

  it('positions the mention panel next to the composer input instead of the right action area', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/team.html'), 'utf8')

    expect(html).toMatch(/\.mention-panel\s*{[^}]*left:\s*12px;/s)
    expect(html).toMatch(/\.mention-panel\s*{[^}]*bottom:\s*calc\(100% \+ 8px\);/s)
    expect(html).toMatch(/\.mention-panel\s*{[^}]*width:\s*min\(280px,\s*calc\(100% - 24px\)\);/s)
    expect(html).not.toMatch(/\.mention-panel\s*{[^}]*right:\s*78px;/s)
  })

  it('makes the refresh control sync and recover the current chat', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/team.html'), 'utf8')
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/index.ts'), 'utf8')

    expect(html).toContain('aria-label="同步并恢复当前群聊"')
    expect(html).toContain('title="同步并恢复当前群聊"')
    expect(source).toContain('async function refreshCurrentChat()')
    expect(source).toContain("log.info('ui:refresh-recover-chat'")
    expect(source).toContain('refreshCurrentChat().catch')
  })

  it('uses a lighter composer and simplified chat header', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/team.html'), 'utf8')
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/index.ts'), 'utf8')

    expect(html).toContain('placeholder="输入消息，@成员可指定回复；不 @ 默认发给全部成员。"')
    expect(html).toMatch(/\.chat-header\s*{[^}]*min-height:\s*72px;/s)
    expect(html).toMatch(/\.chat-header\s*{[^}]*padding:\s*16px 132px 14px 22px;/s)
    expect(html).toMatch(/\.composer\s*{[^}]*margin:\s*0;/s)
    expect(html).toMatch(/\.composer\s*{[^}]*border-top:\s*1px solid rgba\(132,\s*153,\s*171,\s*0\.12\);/s)
    expect(html).toMatch(/\.drawer-summary\s*{[^}]*min-height:\s*30px;/s)
    expect(source).toContain("togglePeopleDrawerEl.textContent = '成员 0'")
    expect(source).toContain('togglePeopleDrawerEl.textContent = `成员 ${roles.length} ${peopleDrawerOpen ?')
    expect(source).not.toContain('人回复中')
  })

  it('places user messages on the right like a WeChat conversation', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/team.html'), 'utf8')

    expect(html).toMatch(/\.message-row\.user\s*{[^}]*justify-content:\s*flex-end;/s)
    expect(html).toMatch(/\.message-row\.user \.message-inner\s*{[^}]*flex-direction:\s*row-reverse;/s)
    expect(html).toMatch(/\.message-row\.user \.message-bubble\s*{[^}]*background:\s*#95ec69;/s)
    expect(html).toMatch(/\.message-row\.user \.message-bubble::before\s*{[^}]*border-left-color:\s*#95ec69;/s)
    expect(html).not.toContain('.message-content')
  })

  it('renders time dividers and system messages as centered pills', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/team.html'), 'utf8')
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/index.ts'), 'utf8')

    expect(source).toContain("divider.className = 'message-time-divider'")
    expect(source).toContain("pill.className = 'message-system-pill'")
    expect(html).toMatch(/\.message-time-divider\s*{[^}]*align-self:\s*center;/s)
    expect(html).toMatch(/\.message-system-pill\s*{[^}]*border-radius:\s*999px;/s)
  })

  it('renders explicit mentions inline inside user message bubbles', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/team.html'), 'utf8')
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/index.ts'), 'utf8')

    expect(source).toContain('renderMessageMentions(message)')
    expect(source).toContain('appendMentionsToBody(body, mentions)')
    expect(source).toContain('message.mentionedRoleIds')
    expect(source).toContain("mention.textContent = `@${name}`")
    expect(html).toMatch(/\.message-mentions\s*{[^}]*display:\s*inline-flex;/s)
    expect(html).toMatch(/\.message-mention\s*{[^}]*font-weight:\s*820;/s)
  })

  it('renders message content as plain text with original whitespace preserved', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/team.html'), 'utf8')
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/index.ts'), 'utf8')

    expect(source).toContain('body.append(document.createTextNode(message.content))')
    expect(source).toContain('pill.textContent = message.content')
    expect(source).not.toContain('renderMarkdown')
    expect(source).not.toContain('markdown-body')
    expect(html).toMatch(/\.message-body\s*{[^}]*white-space:\s*pre-wrap;/s)
    expect(html).not.toContain('.markdown-body')
    expect(html).not.toContain('markdown-it')
  })

  it('keeps chat titles as plain text and omits chat status from list rows', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/team.html'), 'utf8')
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/index.ts'), 'utf8')

    expect(source).toContain("name.className = 'chat-name'")
    expect(source).not.toContain("name.className = 'chat-name btn btn-ghost'")
    expect(source).not.toContain("meta.className = 'chat-meta tiny'")
    expect(source).not.toContain('statusPill(chat.status')
    expect(html).not.toContain('.chat-meta')
    expect(html).not.toContain('.chat-item .chat-name::before')
  })

  it('uses a WeChat-like chat list row with avatar, body, and right time column', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/team.html'), 'utf8')
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/index.ts'), 'utf8')

    expect(source).toContain("avatar.className = `chat-avatar ${roleToneClass(chat.name)}`")
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
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/index.ts'), 'utf8')

    expect(source).toContain("runCommand('GROUP_CHAT_SWITCH', { chatId })")
    expect(source).toContain('renderSelectedChat()')
    expect(source).toContain('window.requestAnimationFrame(() => {')
    expect(source).not.toContain("runCommand('GROUP_CHAT_MARK_READ', { chatId })")
    expect(source).toMatch(/if \(response\.store\) \{\s*applyStore\(response\.store\)\s*return\s*\}/s)
    expect(source).not.toMatch(/if \(response\.store\) applyStore\(response\.store\)\s*await refreshStore\(false\)/s)
  })

  it('avoids layout-changing iframe group transitions while switching chats', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/team.html'), 'utf8')
    const activeGroupRule = html.match(/#iframe-host \.chat-frame-group\.active\s*{(?<body>[^}]*)}/)?.groups?.body ?? ''
    const groupRule = html.match(/#iframe-host \.chat-frame-group\s*{(?<body>[^}]*)}/)?.groups?.body ?? ''

    expect(activeGroupRule).not.toContain('grid-row')
    expect(activeGroupRule).not.toContain('transform')
    expect(groupRule).not.toContain('transform: scale')
    expect(groupRule).not.toMatch(/transition:[^;]*transform/)
  })

  it('reuses rendered message nodes so returning to a chat is cheap', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/index.ts'), 'utf8')

    expect(source).toContain('messageNodeCache')
    expect(source).toContain('renderMessageNode(item.message, item.showName, item.showAvatar)')
    expect(source).toContain('messageSignature(message, showName, showAvatar)')
  })
})
