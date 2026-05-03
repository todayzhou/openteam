import MarkdownIt from 'markdown-it'
import type { GroupChat, GroupMessage, GroupRole, MessageReference, OpenTeamStore } from '../group/types'
import type { TeamPageState } from './appState'
import { buildChatRenderItems, getChatStartupNotice, getVisibleThinkingRoles, THINKING_TIMEOUT_MS } from './chatExperience'

type MessageActionIcon = 'copy' | 'quote' | 'jump' | 'check'

const MAX_CACHED_MESSAGE_NODES = 400
const COPY_FEEDBACK_MS = 1200
const markdownRenderer = new MarkdownIt({ html: false, linkify: true, breaks: true })

export interface MessagesViewDependencies {
  state: TeamPageState
  getStore(): OpenTeamStore
  messagesEl: HTMLElement
  getCurrentChat(): GroupChat | undefined
  getCurrentRoles(): GroupRole[]
  getCurrentMessages(): GroupMessage[]
  emptyCard(title: string, body: string): HTMLElement
  openAddPersonDialog(): void
  roleToneClass(seed: string | undefined): string
  roleAvatarLabel(name: string | undefined): string
  messageTitle(message: GroupMessage): string
  focusRoleFrame(chatId: string, roleId: string | undefined): void
  setReference(message: GroupMessage): void
  interruptAndRetryRole(role: GroupRole): Promise<void>
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  render(): void
  showError(message: string): void
  log: {
    warn(event: string, details?: Record<string, unknown>): void
  }
}

export interface MessagesView {
  renderMessages(): void
}

export function createMessagesView(deps: MessagesViewDependencies): MessagesView {
  function renderMessages(): void {
    const chat = deps.getCurrentChat()
    const messages = deps.getCurrentMessages()
    deps.messagesEl.replaceChildren()

    if (!chat) {
      deps.messagesEl.append(deps.emptyCard('选择一个群聊', '左侧群聊列表会显示最近摘要、状态和更新时间。'))
      return
    }

    if (messages.length === 0) {
      const roles = deps.getCurrentRoles()
      const startupNotice = getChatStartupNotice(chat, roles)
      if (roles.length === 0) {
        deps.messagesEl.append(emptyChatPeopleCard('暂无人员', '先添加人员，再开始群聊协作。'))
      } else {
        deps.messagesEl.append(startupNotice ? deps.emptyCard(startupNotice.title, startupNotice.body) : deps.emptyCard('等待第一条消息', '唤醒人员后，在下方输入任务；无 @ 默认发送给全部人员。'))
      }
    }

    for (const item of buildChatRenderItems(messages, deps.getCurrentRoles())) {
      if (item.type === 'time') {
        const divider = document.createElement('div')
        divider.className = 'message-time-divider'
        divider.textContent = item.label
        deps.messagesEl.append(divider)
        continue
      }
      deps.messagesEl.append(renderMessageNode(item.message, item.showName, item.showAvatar))
    }

    for (const role of getVisibleThinkingRoles(deps.getCurrentRoles())) {
      deps.messagesEl.append(thinkingBubble(role))
    }
    scheduleThinkingTimeouts()
    deps.messagesEl.scrollTop = deps.messagesEl.scrollHeight
  }

  function renderMessageNode(message: GroupMessage, showName = true, showAvatar = true): HTMLElement {
    const signature = messageSignature(message, showName, showAvatar)
    const cached = deps.state.messageNodeCache.get(message.id)
    if (cached?.signature === signature) return cached.node

    const article = document.createElement('article')
    article.className = `message-row message ${message.type}${showName ? '' : ' compact'}${showAvatar ? '' : ' no-avatar'}`

    if (message.type === 'system') {
      const pill = document.createElement('div')
      pill.className = 'message-system-pill'
      pill.textContent = message.content
      article.append(pill)
      cacheMessageNode(message.id, signature, article)
      return article
    }

    const inner = document.createElement('div')
    inner.className = 'message-inner'

    const avatar = document.createElement('div')
    avatar.className = `message-avatar ${messageToneClass(message)}`
    avatar.textContent = messageAvatarLabel(message)
    avatar.hidden = !showAvatar

    const stack = document.createElement('div')
    stack.className = 'message-stack'

    if (message.type === 'assistant' && showName) {
      const name = document.createElement('div')
      name.className = 'message-name'
      name.textContent = deps.messageTitle(message)
      stack.append(name)
    }

    const bubble = document.createElement('div')
    bubble.className = 'message-bubble'
    const body = document.createElement('div')
    body.className = 'message-body'
    if (message.type === 'user') {
      const mentions = renderMessageMentions(message)
      if (mentions) appendMentionsToBody(body, mentions)
    }
    if (message.contentFormat === 'markdown') {
      renderMarkdownMessageBody(body, message.content)
    } else {
      renderPlainMessageBody(body, message.content)
    }
    bubble.append(body)
    if (message.references?.length) bubble.append(referenceBox(message.references[0]))

    if (message.type === 'assistant') {
      const tools = document.createElement('div')
      tools.className = 'message-tools'
      if (message.roleId) {
        tools.append(createMessageIconButton('跳转到原始窗口', 'jump', () => deps.focusRoleFrame(message.chatId, message.roleId)))
      }
      tools.append(createMessageIconButton('引用回复', 'quote', () => deps.setReference(message)))
      tools.append(createMessageIconButton('复制回复', 'copy', button => handleCopyMessage(button, message)))
      bubble.append(tools)
    }

    stack.append(bubble)
    inner.append(avatar, stack)
    article.append(inner)
    cacheMessageNode(message.id, signature, article)
    return article
  }

  function cacheMessageNode(messageId: string, signature: string, node: HTMLElement): void {
    deps.state.messageNodeCache.set(messageId, { signature, node })
    while (deps.state.messageNodeCache.size > MAX_CACHED_MESSAGE_NODES) {
      const oldestMessageId = deps.state.messageNodeCache.keys().next().value
      if (!oldestMessageId) return
      deps.state.messageNodeCache.delete(oldestMessageId)
    }
  }

  function renderMarkdownMessageBody(body: HTMLElement, content: string): void {
    body.classList.add('markdown-body')
    body.innerHTML = markdownRenderer.render(content)
    for (const link of body.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      link.target = '_blank'
      link.rel = 'noreferrer'
    }
  }

  function renderPlainMessageBody(body: HTMLElement, content: string): void {
    body.append(document.createTextNode(content))
  }

  function createMessageIconButton(label: string, icon: MessageActionIcon, onClick: (button: HTMLButtonElement) => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'message-tool-btn'
    button.setAttribute('aria-label', label)
    setMessageButtonIcon(button, icon)
    button.addEventListener('click', () => onClick(button))
    return button
  }

  function setMessageButtonIcon(button: HTMLButtonElement, icon: MessageActionIcon): void {
    button.replaceChildren(messageActionIcon(icon))
  }

  function messageActionIcon(icon: MessageActionIcon): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('focusable', 'false')

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', messageActionIconPath(icon))
    svg.append(path)
    return svg
  }

  function messageActionIconPath(icon: MessageActionIcon): string {
    if (icon === 'copy') return 'M8 7.5A2.5 2.5 0 0 1 10.5 5h6A2.5 2.5 0 0 1 19 7.5v6A2.5 2.5 0 0 1 16.5 16h-6A2.5 2.5 0 0 1 8 13.5v-6Zm-3 3A2.5 2.5 0 0 1 7.5 8H8v5.5a2.5 2.5 0 0 0 2.5 2.5H16v.5a2.5 2.5 0 0 1-2.5 2.5h-6A2.5 2.5 0 0 1 5 16.5v-6Z'
    if (icon === 'quote') return 'M7.2 6.5c-1.7 1.4-2.7 3-2.7 5.1 0 1.9 1.1 3.2 2.8 3.2 1.3 0 2.3-.9 2.3-2.2 0-1.2-.8-2-2-2.1.2-1.1.9-2 2.1-3l-1.1-1.4c-.5.1-1 .2-1.4.4Zm8 0c-1.7 1.4-2.7 3-2.7 5.1 0 1.9 1.1 3.2 2.8 3.2 1.3 0 2.3-.9 2.3-2.2 0-1.2-.8-2-2-2.1.2-1.1.9-2 2.1-3l-1.1-1.4c-.5.1-1 .2-1.4.4Z'
    if (icon === 'check') return 'M9.2 16.4 4.8 12l1.4-1.4 3 3 8.6-8.6 1.4 1.4-10 10Z'
    return 'M14 5h5v5h-1.6V7.7l-7.1 7.1-1.1-1.1 7.1-7.1H14V5ZM6.5 6h4v1.6h-4a.9.9 0 0 0-.9.9v9a.9.9 0 0 0 .9.9h9a.9.9 0 0 0 .9-.9v-4H18v4A2.5 2.5 0 0 1 15.5 20h-9A2.5 2.5 0 0 1 4 17.5v-9A2.5 2.5 0 0 1 6.5 6Z'
  }

  async function handleCopyMessage(button: HTMLButtonElement, message: GroupMessage): Promise<void> {
    try {
      await copyMessageContent(message)
      showCopyFeedback(button)
    } catch (error) {
      deps.showError(error instanceof Error ? error.message : String(error))
    }
  }

  function showCopyFeedback(button: HTMLButtonElement): void {
    button.classList.add('copied')
    button.setAttribute('aria-label', '已复制')
    setMessageButtonIcon(button, 'check')
    window.setTimeout(() => {
      button.classList.remove('copied')
      button.setAttribute('aria-label', '复制回复')
      setMessageButtonIcon(button, 'copy')
    }, COPY_FEEDBACK_MS)
  }

  async function copyMessageContent(message: GroupMessage): Promise<void> {
    if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持复制')
    await navigator.clipboard.writeText(message.content)
  }

  function messageSignature(message: GroupMessage, showName = true, showAvatar = true): string {
    return JSON.stringify({
      type: message.type,
      roleId: message.roleId,
      roleName: message.roleName,
      content: message.content,
      contentFormat: message.contentFormat,
      createdAt: message.createdAt,
      status: message.status,
      references: message.references,
      targetRoleIds: message.targetRoleIds,
      mentionedRoleIds: message.mentionedRoleIds,
      showName,
      showAvatar,
    })
  }

  function renderMessageMentions(message: GroupMessage): HTMLElement | undefined {
    if (!message.mentionedRoleIds?.length) return undefined
    const store = deps.getStore()
    const names = message.mentionedRoleIds.map(roleId => store.rolesById[roleId]?.name).filter((name): name is string => Boolean(name))
    if (names.length === 0) return undefined

    const mentions = document.createElement('div')
    mentions.className = 'message-mentions'
    for (const name of names) {
      const mention = document.createElement('span')
      mention.className = 'message-mention'
      mention.textContent = `@${name}`
      mentions.append(mention)
    }
    return mentions
  }

  function appendMentionsToBody(body: HTMLElement, mentions: HTMLElement): void {
    body.append(mentions)
  }

  function scheduleThinkingTimeouts(): void {
    for (const timer of deps.state.thinkingTimeoutTimers) window.clearTimeout(timer)
    deps.state.thinkingTimeoutTimers = []

    const now = Date.now()
    for (const role of deps.getCurrentRoles()) {
      if (role.status !== 'thinking') continue
      const remaining = THINKING_TIMEOUT_MS - (now - role.updatedAt)
      if (remaining <= 0) {
        if (!deps.state.loggedThinkingTimeoutRoleIds.has(role.id)) {
          deps.state.loggedThinkingTimeoutRoleIds.add(role.id)
          deps.log.warn('ui:thinking-bubble:timeout', { chatId: role.chatId, roleId: role.id, timeoutMs: THINKING_TIMEOUT_MS })
          deps.runCommand('TEAM_ROLE_ERROR', {
            chatId: role.chatId,
            roleId: role.id,
            messageId: role.lastPromptMessageId,
            reason: `等待 ${role.name} 回复超时（${Math.round(THINKING_TIMEOUT_MS / 1000)} 秒）`,
          }).catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
        }
        continue
      }
      deps.state.loggedThinkingTimeoutRoleIds.delete(role.id)
      deps.state.thinkingTimeoutTimers.push(window.setTimeout(deps.render, remaining + 1))
    }
  }

  function thinkingBubble(role: GroupRole, showName = true, showAvatar = true): HTMLElement {
    const article = document.createElement('article')
    article.className = `message-row message assistant thinking${showName ? '' : ' compact'}${showAvatar ? '' : ' no-avatar'}`
    const inner = document.createElement('div')
    inner.className = 'message-inner'
    const avatar = document.createElement('div')
    avatar.className = `message-avatar ${deps.roleToneClass(role.name)}`
    avatar.textContent = deps.roleAvatarLabel(role.name)
    avatar.hidden = !showAvatar
    const stack = document.createElement('div')
    stack.className = 'message-stack'
    if (showName) {
      const name = document.createElement('div')
      name.className = 'message-name'
      name.textContent = role.name
      stack.append(name)
    }
    const bubble = document.createElement('div')
    bubble.className = 'message-bubble'
    const body = document.createElement('div')
    body.className = 'message-body thinking-dots'
    body.textContent = `${role.name} 正在回复中 `
    bubble.append(body)
    const tools = document.createElement('div')
    tools.className = 'message-tools'
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'btn btn-ghost'
    retry.textContent = '打断重试'
    retry.addEventListener('click', () => deps.interruptAndRetryRole(role).catch(error => deps.showError(error instanceof Error ? error.message : String(error))))
    tools.append(retry)
    bubble.append(tools)
    stack.append(bubble)
    inner.append(avatar, stack)
    article.append(inner)
    return article
  }

  function referenceBox(reference: MessageReference): HTMLElement {
    const box = document.createElement('div')
    box.className = 'reference-box'
    box.textContent = `引用 ${reference.roleName || '人员'}：${truncate(reference.contentSnapshot, 160)}`
    return box
  }

  function emptyChatPeopleCard(title: string, body: string): HTMLElement {
    const wrapper = deps.emptyCard(title, body)
    const card = wrapper.querySelector('.empty-card')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'btn btn-primary'
    button.textContent = '添加人员'
    button.addEventListener('click', deps.openAddPersonDialog)
    card?.append(button)
    return wrapper
  }

  function messageAvatarLabel(message: GroupMessage): string {
    if (message.type === 'user') return '你'
    return deps.roleAvatarLabel(message.roleName)
  }

  function messageToneClass(message: GroupMessage): string {
    if (message.type === 'user') return 'role-tone-5'
    return deps.roleToneClass(message.roleName)
  }

  function truncate(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value
  }

  return { renderMessages }
}
