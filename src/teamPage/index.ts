import MarkdownIt from 'markdown-it'
import { getDefaultChatSiteUrl } from '../group/conversationUrl'
import type { ChatSite, GroupChat, GroupMessage, GroupRole, MessageReference, OpenTeamStore, RoleStatus, RoleTemplate, RoomMode } from '../group/types'
import { createDefaultStore, loadStore, saveStore } from '../group/store'
import { parseGroupMentions } from '../group/mentionParser'
import { createIframeHost } from './iframeHost'
import { buildChatRenderItems, formatChatListTime, getAvatarInitial, getChatStartupNotice, getVisibleThinkingRoles, isUnavailableRolesError, shouldAutoReconnectRole, shouldConfirmMentionWithEnter, shouldSendMessageWithEnter, THINKING_TIMEOUT_MS } from './chatExperience'

interface RuntimeResponse<T = unknown> {
  ok?: boolean
  error?: string
  store?: OpenTeamStore
  data?: T
}

type StorePushMessage =
  | { type: 'GROUP_STORE_UPDATED'; store: OpenTeamStore }
  | { type: 'GROUP_ROLE_STATUS_UPDATED'; store?: OpenTeamStore }
  | { type: 'GROUP_MESSAGE_DELIVERED'; store?: OpenTeamStore }
  | { type: 'GROUP_MESSAGE_RECEIVED'; store?: OpenTeamStore }
  | { type: 'GROUP_DELIVERY_ERROR'; store?: OpenTeamStore; error?: string }
  | { type: 'TEAM_FRAME_ROLE_READY'; chatId: string; roleId: string; store?: OpenTeamStore }

type TemplateDraft = Pick<RoleTemplate, 'name' | 'description' | 'systemPrompt' | 'defaultChatSite'>
type CachedMessageNode = { signature: string; node: HTMLElement }
type TemporaryPersonDraft = Pick<RoleTemplate, 'name' | 'description' | 'systemPrompt'> & { id: string; chatSite: ChatSite }
type AddPersonItem =
  | { key: string; source: 'library'; roleTemplateId: string; name: string; description?: string; chatSite: ChatSite }
  | { key: string; source: 'temporary'; draftId: string; name: string; description?: string; systemPrompt: string; chatSite: ChatSite }
type MessageActionIcon = 'copy' | 'quote' | 'jump' | 'check'

const MAX_CACHED_MESSAGE_NODES = 400
const AUTO_RECONNECT_TIMEOUT_MS = 20_000
const COPY_FEEDBACK_MS = 1200
const markdownRenderer = new MarkdownIt({ html: false, linkify: true, breaks: true })

interface RoleReadyWaiter {
  chatId: string
  roleIds: Set<string>
  resolve: () => void
  reject: (error: Error) => void
  timeoutId: number
}

let store: OpenTeamStore = createDefaultStore()
let selectedChatId: string | undefined
let selectedRoleId: string | undefined
let selectedTemplateId: string | undefined
let selectedReference: MessageReference | undefined
let hostTabId: number | undefined
let mentionIndex = 0
let peopleDrawerOpen = false
let chatMenuChatId: string | undefined
let roleSiteMenuRoleId: string | undefined
let addPersonSiteMenuId: string | undefined
let pendingSwitchAnimationFrame: number | undefined
let thinkingTimeoutTimers: number[] = []
const loggedThinkingTimeoutRoleIds = new Set<string>()
const messageNodeCache = new Map<string, CachedMessageNode>()
const reconnectingRoleKeys = new Set<string>()
const roleReadyWaiters = new Set<RoleReadyWaiter>()
const temporaryPersonDrafts: TemporaryPersonDraft[] = []
const addPersonSiteByKey = new Map<string, ChatSite>()

const appShellEl = requireElement<HTMLElement>('#app')
const floatingDragHandleEl = requireElement<HTMLElement>('#floating-drag-handle')
const toggleWindowSizeEl = requireElement<HTMLButtonElement>('#toggle-window-size')
const storeSummaryEl = requireElement<HTMLElement>('#store-summary')
const chatListEl = requireElement<HTMLElement>('#chat-list')
const chatTitleEl = requireElement<HTMLElement>('#chat-title')
const chatSubtitleEl = requireElement<HTMLElement>('#chat-subtitle')
const chatStatusEl = requireElement<HTMLElement>('#chat-status')
const messagesEl = requireElement<HTMLElement>('#messages')
const roleSummaryEl = requireElement<HTMLElement>('#role-summary')
const roleListEl = requireElement<HTMLElement>('#role-list')
const roleTemplateSelectEl = requireElement<HTMLSelectElement>('#role-template-select')
const templateListEl = requireElement<HTMLElement>('#template-list')
const targetPreviewEl = requireElement<HTMLElement>('#target-preview')
const busyPreviewEl = requireElement<HTMLElement>('#busy-preview')
const sendButtonEl = requireElement<HTMLButtonElement>('#send-message')
const messageInputEl = requireElement<HTMLTextAreaElement>('#message-input')
const referenceDraftEl = requireElement<HTMLElement>('#reference-draft')
const mentionPanelEl = requireElement<HTMLElement>('#mention-panel')
const errorEl = requireElement<HTMLElement>('#error')
const newChatNameEl = requireElement<HTMLInputElement>('#new-chat-name')
const createChatFormEl = requireElement<HTMLFormElement>('#create-chat-form')
const quickCreateChatEl = requireElement<HTMLButtonElement>('#quick-create-chat')
const templateNameEl = requireElement<HTMLInputElement>('#template-name')
const templateDescriptionEl = requireElement<HTMLTextAreaElement>('#template-description')
const templatePromptEl = requireElement<HTMLTextAreaElement>('#template-prompt')
const templateFormTitleEl = requireElement<HTMLElement>('#template-form-title')
const settingsButtonEl = requireElement<HTMLButtonElement>('#settings-button')
const settingsMenuEl = requireElement<HTMLElement>('#settings-menu')
const peopleLibraryModalEl = requireElement<HTMLElement>('#people-library-modal')
const personTemplateModalEl = requireElement<HTMLElement>('#person-template-modal')
const addPersonModalEl = requireElement<HTMLElement>('#add-person-modal')
const temporaryPersonModalEl = requireElement<HTMLElement>('#temporary-person-modal')
const peopleLibrarySummaryEl = requireElement<HTMLElement>('#people-library-summary')
const peopleLibraryListEl = requireElement<HTMLElement>('#people-library-list')
const addLibraryPeopleListEl = requireElement<HTMLElement>('#add-library-people-list')
const templateSiteGeminiEl = requireElement<HTMLInputElement>('#template-site-gemini')
const templateSiteChatGptEl = requireElement<HTMLInputElement>('#template-site-chatgpt')
const templateSiteClaudeEl = requireElement<HTMLInputElement>('#template-site-claude')
const temporaryPersonNameEl = requireElement<HTMLInputElement>('#temporary-person-name')
const temporaryPersonDescriptionEl = requireElement<HTMLTextAreaElement>('#temporary-person-description')
const temporaryPersonPromptEl = requireElement<HTMLTextAreaElement>('#temporary-person-prompt')
const togglePeopleDrawerEl = requireElement<HTMLButtonElement>('#toggle-people-drawer')
const rolePanelEl = requireElement<HTMLElement>('.role-panel')
const windowLauncherEl = requireElement<HTMLButtonElement>('#window-launcher')
const log = {
  debug(event: string, details?: Record<string, unknown>): void {
    console.debug('[OpenTeam][team-page]', event, details || {})
  },
  info(event: string, details?: Record<string, unknown>): void {
    console.info('[OpenTeam][team-page]', event, details || {})
  },
  warn(event: string, details?: Record<string, unknown>): void {
    console.warn('[OpenTeam][team-page]', event, details || {})
  },
}

const iframeHost = createIframeHost({
  visibleHost: requireElement<HTMLElement>('#iframe-host'),
  onEvent(event) {
    log.debug(`iframe-host:${event.type}`, event)
  },
})

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing element: ${selector}`)
  return element
}

function sendRuntimeMessage<T>(type: string, payload: Record<string, unknown> = {}): Promise<RuntimeResponse<T>> {
  return new Promise((resolve, reject) => {
    const message: Record<string, unknown> = { type, ...payload }
    if (hostTabId !== undefined && typeof message.hostTabId !== 'number') message.hostTabId = hostTabId
    log.debug('runtime-send:start', { type, hostTabId: message.hostTabId })

    chrome.runtime.sendMessage(message, response => {
      const lastError = chrome.runtime.lastError
      if (lastError) {
        log.warn('runtime-send:failed', { type, error: lastError.message })
        reject(new Error(lastError.message))
        return
      }

      log.debug('runtime-send:response', { type, ok: response?.ok, error: response?.error })
      resolve((response ?? {}) as RuntimeResponse<T>)
    })
  })
}

async function runCommand(type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const response = await sendRuntimeMessage(type, payload)
  if (response.ok === false) throw new Error(response.error || `${type} failed`)
  if (response.store) {
    applyStore(response.store)
    return
  }
  await refreshStore(false)
}

async function resolveHostTabId(): Promise<void> {
  const tab = await chrome.tabs.getCurrent()
  hostTabId = tab?.id
  log.info('host-tab:resolved', { hostTabId, url: tab?.url })
  iframeHost.setHostTabId(hostTabId)
}

async function refreshStore(showFailure = true): Promise<void> {
  try {
    const response = await sendRuntimeMessage('GROUP_STORE_GET')
    if (response.ok === false) throw new Error(response.error || '读取群聊数据失败')
    applyStore(response.store ?? createDefaultStore())
  } catch (error) {
    applyStore(createDefaultStore())
    if (showFailure) showError(error instanceof Error ? error.message : String(error))
  }
}

async function refreshCurrentChat(): Promise<void> {
  await refreshStore()
  const chat = getCurrentChat()
  if (!chat) return

  const reconnectableRoles = getCurrentRoles().filter(role => role.status !== 'ready' && shouldAutoReconnectRole(role))
  if (reconnectableRoles.length === 0) return

  log.info('ui:refresh-recover-chat', { chatId: chat.id, roleIds: reconnectableRoles.map(role => role.id) })
  await reconnectRolesForSend(chat, reconnectableRoles)
  await refreshStore(false)
}

function applyStore(nextStore: OpenTeamStore): void {
  store = nextStore
  selectedChatId = pickCurrentChatId()
  const roles = getCurrentRoles()
  if (!selectedRoleId || !roles.some(role => role.id === selectedRoleId)) selectedRoleId = roles[0]?.id
  if (selectedReference && selectedReference.messageId && !getCurrentMessages().some(message => message.id === selectedReference?.messageId)) {
    selectedReference = undefined
  }
  syncIframeHost()
  render()
  notifyRoleReadyWaiters()
}

function pickCurrentChatId(): string | undefined {
  if (selectedChatId && store.chatsById[selectedChatId]) return selectedChatId
  if (store.currentChatId && store.chatsById[store.currentChatId]) return store.currentChatId
  return [...store.chatOrder]
    .sort((left, right) => (store.chatsById[right]?.updatedAt ?? 0) - (store.chatsById[left]?.updatedAt ?? 0))
    .find(chatId => Boolean(store.chatsById[chatId]))
}

function getCurrentChat(): GroupChat | undefined {
  return selectedChatId ? store.chatsById[selectedChatId] : undefined
}

function getCurrentRoles(): GroupRole[] {
  const chat = getCurrentChat()
  if (!chat) return []
  return chat.roleIds.map(roleId => store.rolesById[roleId]).filter((role): role is GroupRole => Boolean(role))
}

function getCurrentMessages(): GroupMessage[] {
  const chat = getCurrentChat()
  if (!chat) return []
  return chat.messageIds.map(messageId => store.messagesById[messageId]).filter((message): message is GroupMessage => Boolean(message))
}

function getTemplates(): RoleTemplate[] {
  return store.roleTemplateOrder.map(templateId => store.roleTemplatesById[templateId]).filter((template): template is RoleTemplate => Boolean(template))
}

function teamRoleKey(chatId: string, roleId: string): string {
  return `${chatId}:${roleId}`
}

function resolveMessageTargets(raw: string, roles: GroupRole[]): { ok: true; roles: GroupRole[] } | { ok: false; error: string } {
  const parsed = parseGroupMentions(raw, roles)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const targets = roles.filter(role => parsed.targetRoleIds.includes(role.id))
  if (targets.length === 0) return { ok: false, error: '当前群聊没有可投递人员' }
  return { ok: true, roles: targets }
}

function areRolesReady(chatId: string, roleIds: string[]): boolean {
  return roleIds.every(roleId => {
    const role = store.rolesById[roleId]
    return role?.chatId === chatId && role.status === 'ready'
  })
}

function notifyRoleReadyWaiters(): void {
  for (const waiter of [...roleReadyWaiters]) {
    if (!areRolesReady(waiter.chatId, [...waiter.roleIds])) continue
    window.clearTimeout(waiter.timeoutId)
    roleReadyWaiters.delete(waiter)
    waiter.resolve()
  }
}

function waitForRolesReady(chatId: string, roleIds: string[], timeoutMs = AUTO_RECONNECT_TIMEOUT_MS): Promise<void> {
  const uniqueRoleIds = [...new Set(roleIds)]
  if (areRolesReady(chatId, uniqueRoleIds)) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const waiter: RoleReadyWaiter = {
      chatId,
      roleIds: new Set(uniqueRoleIds),
      resolve,
      reject,
      timeoutId: window.setTimeout(() => {
        roleReadyWaiters.delete(waiter)
        reject(new Error('自动连接人员超时，请稍后重试或手动恢复会话'))
      }, timeoutMs),
    }
    roleReadyWaiters.add(waiter)
  })
}

function syncIframeHost(): void {
  const chat = getCurrentChat()
  if (!chat) return
  const roles = getCurrentRoles()
  log.debug('iframe-sync:activate-chat', {
    chatId: chat.id,
    roleIds: roles.map(role => role.id),
    roleStatuses: roles.map(role => ({ id: role.id, name: role.name, status: role.status, conversationUrl: role.geminiConversationUrl })),
  })
  iframeHost.activateChat(chat, roles)
}

function render(): void {
  renderSelectedChat()
  renderTemplates()
  renderAddPersonDialog()
}

function renderSelectedChat(): void {
  renderChatList()
  renderChatHeader()
  renderMessages()
  renderComposerState()
  renderRolePanel()
}

function renderChatList(): void {
  const chats = store.chatOrder.map(chatId => store.chatsById[chatId]).filter((chat): chat is GroupChat => Boolean(chat))
  storeSummaryEl.textContent = `${chats.length} 个群聊 · ${getTemplates().length} 个人员库人员`
  chatListEl.replaceChildren()

  if (chats.length === 0) {
    chatListEl.append(emptyCard('还没有群聊', '在上方创建一个群聊，然后从人员库添加人员。'))
    return
  }

  for (const chat of chats) {
    const item = document.createElement('section')
    const hasActivity = chat.id !== selectedChatId && Boolean(store.viewState?.chatHasNewMessageById?.[chat.id])
    item.className = `chat-item${chat.id === selectedChatId ? ' active' : ''}${hasActivity ? ' has-activity' : ''}`
    item.tabIndex = 0
    item.setAttribute('role', 'button')
    item.setAttribute('aria-label', `切换到 ${chat.name}`)
    item.addEventListener('click', () => switchChat(chat.id))
    item.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      switchChat(chat.id)
    })

    const avatar = document.createElement('div')
    avatar.className = `chat-avatar ${roleToneClass(chat.name)}`
    avatar.textContent = roleAvatarLabel(chat.name)

    const body = document.createElement('div')
    body.className = 'chat-item-body'

    const row = document.createElement('div')
    row.className = 'chat-row chat-item-title'
    const name = document.createElement('button')
    name.type = 'button'
    name.className = 'chat-name'
    name.textContent = chat.name
    const menuButton = document.createElement('button')
    menuButton.type = 'button'
    menuButton.className = 'icon-btn chat-menu-btn'
    menuButton.setAttribute('aria-label', `打开 ${chat.name} 的群聊菜单`)
    menuButton.textContent = '⋯'
    menuButton.addEventListener('click', event => {
      event.stopPropagation()
      chatMenuChatId = chatMenuChatId === chat.id ? undefined : chat.id
      renderChatList()
    })
    row.append(name)

    const summary = document.createElement('div')
    summary.className = 'summary-line'
    summary.textContent = getChatRecentSummary(chat)

    body.append(row, summary)

    const side = document.createElement('div')
    side.className = 'chat-item-side'
    const time = document.createElement('span')
    time.className = 'chat-time'
    time.textContent = formatChatListTime(chat.updatedAt)
    side.append(time, menuButton)

    item.append(avatar, body, side)
    if (chatMenuChatId === chat.id) item.append(chatActionMenu(chat))
    chatListEl.append(item)
  }
}

function chatActionMenu(chat: GroupChat): HTMLElement {
  const menu = document.createElement('div')
  menu.className = 'chat-action-menu'
  menu.addEventListener('click', event => event.stopPropagation())
  const rename = document.createElement('button')
  rename.type = 'button'
  rename.className = 'btn btn-ghost'
  rename.textContent = '编辑名称'
  rename.addEventListener('click', () => {
    const nextName = window.prompt('编辑群聊名称', chat.name)?.trim()
    chatMenuChatId = undefined
    if (!nextName) {
      renderChatList()
      return
    }
    runCommand('GROUP_CHAT_UPDATE', { chatId: chat.id, patch: { name: nextName } }).catch(error => showError(error.message))
  })
  const duplicate = document.createElement('button')
  duplicate.type = 'button'
  duplicate.className = 'btn btn-ghost'
  duplicate.textContent = '复制群聊'
  duplicate.addEventListener('click', () => {
    chatMenuChatId = undefined
    renderChatList()
    runCommand('GROUP_CHAT_DUPLICATE', { chatId: chat.id }).catch(error => showError(error.message))
  })
  const clearMessages = document.createElement('button')
  clearMessages.type = 'button'
  clearMessages.className = 'btn btn-ghost'
  clearMessages.textContent = '清空消息'
  clearMessages.addEventListener('click', () => {
    chatMenuChatId = undefined
    renderChatList()
    if (!window.confirm(`确定清空「${chat.name}」的聊天消息吗？人员会保留，但所有 iframe 会重新创建。`)) return
    clearChatMessages(chat.id).catch(error => showError(error.message))
  })
  const closeFrames = document.createElement('button')
  closeFrames.type = 'button'
  closeFrames.className = 'btn btn-ghost'
  closeFrames.textContent = '关闭群聊'
  closeFrames.addEventListener('click', () => {
    chatMenuChatId = undefined
    renderChatList()
    closeChatFrames(chat.id).catch(error => showError(error.message))
  })
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'btn btn-ghost btn-danger'
  remove.textContent = '删除群聊'
  remove.addEventListener('click', () => {
    chatMenuChatId = undefined
    renderChatList()
    if (!window.confirm(`确定删除「${chat.name}」吗？删除后这个群聊的消息和角色都会移除。`)) return
    deleteChat(chat.id).catch(error => showError(error.message))
  })
  menu.append(rename, duplicate, clearMessages, closeFrames, remove)
  return menu
}

async function clearChatMessages(chatId: string): Promise<void> {
  await runCommand('GROUP_CHAT_CLEAR_MESSAGES', { chatId })
  messageNodeCache.clear()
  iframeHost.removeChat(chatId)
  const chat = store.chatsById[chatId]
  if (chat && selectedChatId === chatId) iframeHost.restoreChat(chat, chat.roleIds.map(roleId => store.rolesById[roleId]).filter((role): role is GroupRole => Boolean(role)))
}

async function closeChatFrames(chatId: string): Promise<void> {
  await runCommand('GROUP_CHAT_CLOSE', { chatId })
  iframeHost.removeChat(chatId)
}

async function deleteChat(chatId: string): Promise<void> {
  const response = await sendRuntimeMessage('GROUP_CHAT_DELETE', { chatId })
  if (response.ok === false) {
    if (response.error === 'Unknown OpenTeam message') {
      log.warn('chat-delete:fallback-local-store', { chatId, error: response.error })
      await deleteChatFromLocalStore(chatId)
      return
    }
    throw new Error(response.error || '删除群聊失败')
  }
  iframeHost.removeChat(chatId)
  applyStore(response.store ?? createDefaultStore())
}

async function deleteChatFromLocalStore(chatId: string): Promise<void> {
  const nextStore = await loadStore()
  const chat = nextStore.chatsById[chatId]
  if (!chat) throw new Error(`找不到群聊：${chatId}`)

  for (const roleId of chat.roleIds) delete nextStore.rolesById[roleId]
  for (const messageId of chat.messageIds) delete nextStore.messagesById[messageId]
  nextStore.chatOrder = nextStore.chatOrder.filter(id => id !== chat.id)
  delete nextStore.chatsById[chat.id]
  if (nextStore.currentChatId === chat.id) nextStore.currentChatId = nextStore.chatOrder[0]
  if (nextStore.viewState?.chatReadSeqById) delete nextStore.viewState.chatReadSeqById[chat.id]
  if (nextStore.viewState?.chatHasNewMessageById) delete nextStore.viewState.chatHasNewMessageById[chat.id]

  await saveStore(nextStore)
  iframeHost.removeChat(chatId)
  applyStore(nextStore)
}

function renderChatHeader(): void {
  const chat = getCurrentChat()
  const roles = getCurrentRoles()
  const messages = getCurrentMessages()
  if (!chat) {
    chatTitleEl.textContent = '未选择群聊'
    chatSubtitleEl.textContent = '创建或选择一个群聊开始协作'
    chatStatusEl.className = 'status-pill'
    chatStatusEl.textContent = '空'
    togglePeopleDrawerEl.textContent = '成员 0'
    togglePeopleDrawerEl.disabled = true
    return
  }

  chatTitleEl.textContent = chat.name
  chatSubtitleEl.textContent = roles.length ? `${modeLabel(chat.mode)} · ${roles.length} 位成员 · ${messages.length} 条消息` : '暂无成员'
  chatStatusEl.className = `status-pill status-${chat.status}`
  chatStatusEl.textContent = chatStatusLabel(chat.status)
  togglePeopleDrawerEl.disabled = false
  togglePeopleDrawerEl.textContent = `成员 ${roles.length} ${peopleDrawerOpen ? '▴' : '▾'}`
  togglePeopleDrawerEl.setAttribute('aria-expanded', String(peopleDrawerOpen))
}

function renderMessages(): void {
  const chat = getCurrentChat()
  const messages = getCurrentMessages()
  messagesEl.replaceChildren()

  if (!chat) {
    messagesEl.append(emptyCard('选择一个群聊', '左侧群聊列表会显示最近摘要、状态和更新时间。'))
    return
  }

  if (messages.length === 0) {
    const roles = getCurrentRoles()
    const startupNotice = getChatStartupNotice(chat, roles)
    if (roles.length === 0) {
      messagesEl.append(emptyChatPeopleCard('暂无人员', '先添加人员，再开始群聊协作。'))
    } else {
      messagesEl.append(startupNotice ? emptyCard(startupNotice.title, startupNotice.body) : emptyCard('等待第一条消息', '唤醒人员后，在下方输入任务；无 @ 默认发送给全部人员。'))
    }
  }

  for (const item of buildChatRenderItems(messages, getCurrentRoles())) {
    if (item.type === 'time') {
      const divider = document.createElement('div')
      divider.className = 'message-time-divider'
      divider.textContent = item.label
      messagesEl.append(divider)
      continue
    }
    messagesEl.append(renderMessageNode(item.message, item.showName, item.showAvatar))
  }

  for (const role of getVisibleThinkingRoles(getCurrentRoles())) {
    messagesEl.append(thinkingBubble(role))
  }
  scheduleThinkingTimeouts()
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function renderMessageNode(message: GroupMessage, showName = true, showAvatar = true): HTMLElement {
  const signature = messageSignature(message, showName, showAvatar)
  const cached = messageNodeCache.get(message.id)
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
    name.textContent = messageTitle(message)
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
      tools.append(createMessageIconButton('跳转到原始窗口', 'jump', () => focusRoleFrame(message.chatId, message.roleId)))
    }
    tools.append(createMessageIconButton('引用回复', 'quote', () => setReference(message)))
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
  messageNodeCache.set(messageId, { signature, node })
  while (messageNodeCache.size > MAX_CACHED_MESSAGE_NODES) {
    const oldestMessageId = messageNodeCache.keys().next().value
    if (!oldestMessageId) return
    messageNodeCache.delete(oldestMessageId)
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
    showError(error instanceof Error ? error.message : String(error))
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
  for (const timer of thinkingTimeoutTimers) window.clearTimeout(timer)
  thinkingTimeoutTimers = []

  const now = Date.now()
  for (const role of getCurrentRoles()) {
    if (role.status !== 'thinking') continue
    const remaining = THINKING_TIMEOUT_MS - (now - role.updatedAt)
    if (remaining <= 0) {
      if (!loggedThinkingTimeoutRoleIds.has(role.id)) {
        loggedThinkingTimeoutRoleIds.add(role.id)
        log.warn('ui:thinking-bubble:timeout', { chatId: role.chatId, roleId: role.id, timeoutMs: THINKING_TIMEOUT_MS })
        runCommand('TEAM_ROLE_ERROR', {
          chatId: role.chatId,
          roleId: role.id,
          messageId: role.lastPromptMessageId,
          reason: `等待 ${role.name} 回复超时（${Math.round(THINKING_TIMEOUT_MS / 1000)} 秒）`,
        }).catch(error => showError(error instanceof Error ? error.message : String(error)))
      }
      continue
    }
    loggedThinkingTimeoutRoleIds.delete(role.id)
    thinkingTimeoutTimers.push(window.setTimeout(render, remaining + 1))
  }
}

function thinkingBubble(role: GroupRole, showName = true, showAvatar = true): HTMLElement {
  const article = document.createElement('article')
  article.className = `message-row message assistant thinking${showName ? '' : ' compact'}${showAvatar ? '' : ' no-avatar'}`
  const inner = document.createElement('div')
  inner.className = 'message-inner'
  const avatar = document.createElement('div')
  avatar.className = `message-avatar ${roleToneClass(role.name)}`
  avatar.textContent = roleAvatarLabel(role.name)
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
  retry.addEventListener('click', () => interruptAndRetryRole(role).catch(error => showError(error instanceof Error ? error.message : String(error))))
  tools.append(retry)
  bubble.append(tools)
  stack.append(bubble)
  inner.append(avatar, stack)
  article.append(inner)
  return article
}

function renderComposerState(): void {
  renderReferenceDraft()
  renderMentionPanel()

  const chat = getCurrentChat()
  const roles = getCurrentRoles()
  const raw = messageInputEl.value.trim()
  const parsed = parseGroupMentions(raw || 'x', roles)
  const targetRoleIds = raw && parsed.ok ? parsed.targetRoleIds : roles.map(role => role.id)
  const targets = roles.filter(role => targetRoleIds.includes(role.id))
  const unavailable = targets.filter(role => role.status !== 'ready')
  const reconnecting = targets.filter(role => reconnectingRoleKeys.has(teamRoleKey(role.chatId, role.id)))
  const thinking = getVisibleThinkingRoles(roles)

  if (!chat) {
    targetPreviewEl.textContent = '选择群聊后可发送'
    sendButtonEl.disabled = true
  } else if (roles.length === 0) {
    targetPreviewEl.textContent = '当前群聊还没有人员'
    sendButtonEl.disabled = true
  } else if (!raw) {
    targetPreviewEl.textContent = '输入消息后可发送；无 @ 默认全员'
    sendButtonEl.disabled = true
  } else if (!parsed.ok) {
    targetPreviewEl.textContent = parsed.error
    sendButtonEl.disabled = true
  } else if (reconnecting.length > 0) {
    targetPreviewEl.textContent = `正在自动连接：${reconnecting.map(role => role.name).join('、')}`
    sendButtonEl.disabled = true
  } else if (unavailable.length > 0) {
    const waiting = unavailable.filter(role => !shouldAutoReconnectRole(role))
    if (waiting.length > 0) {
      targetPreviewEl.textContent = `请稍等：${waiting.map(role => role.name).join('、')} 正在回复`
      sendButtonEl.disabled = true
    } else {
      targetPreviewEl.textContent = `将先自动连接：${unavailable.map(role => role.name).join('、')}`
      sendButtonEl.disabled = false
    }
  } else {
    targetPreviewEl.textContent = `将发送给：${targets.map(role => role.name).join('、') || '全部人员'}`
    sendButtonEl.disabled = false
  }

  busyPreviewEl.textContent = thinking.length > 0 ? `正在回复：${thinking.map(role => role.name).join('、')}` : ''
}

function renderReferenceDraft(): void {
  referenceDraftEl.replaceChildren()
  if (!selectedReference) {
    referenceDraftEl.hidden = true
    return
  }

  referenceDraftEl.hidden = false
  const preview = document.createElement('div')
  preview.className = 'reference-draft-preview'
  preview.textContent = `引用 ${selectedReference.roleName || '人员'}：${selectedReference.contentSnapshot}`

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'btn btn-ghost'
  cancel.setAttribute('aria-label', '取消引用')
  cancel.textContent = '×'
  cancel.addEventListener('click', () => {
    selectedReference = undefined
    renderComposerState()
  })
  referenceDraftEl.append(preview, cancel)
}

function renderMentionPanel(): void {
  const roles = getCurrentRoles()
  const show = shouldShowMentionPanel(messageInputEl.value) && roles.length > 0
  mentionPanelEl.hidden = !show
  mentionPanelEl.replaceChildren()
  if (!show) return

  roles.forEach((role, index) => {
    const option = document.createElement('button')
    option.type = 'button'
    option.className = `mention-option${index === mentionIndex ? ' active' : ''}`
    const avatar = document.createElement('span')
    avatar.className = `mention-avatar ${roleToneClass(role.name)}`
    avatar.textContent = roleAvatarLabel(role.name)
    const name = document.createElement('span')
    name.textContent = role.name
    option.addEventListener('click', () => insertMention(role))
    option.append(avatar, name)
    mentionPanelEl.append(option)
  })
}

function renderRolePanel(): void {
  const roles = getCurrentRoles()
  const selectedRole = selectedRoleId ? store.rolesById[selectedRoleId] : undefined
  rolePanelEl.classList.toggle('open', peopleDrawerOpen)
  roleSummaryEl.textContent = `${roles.length} 人员${selectedRole ? ` · 当前：${selectedRole.name}` : ''}`
  roleListEl.replaceChildren()

  if (!getCurrentChat()) {
    roleListEl.append(emptyCard('未选择群聊', '选择群聊后可添加、查看、恢复和唤醒人员。'))
  } else if (roles.length === 0) {
    roleListEl.append(emptyCard('暂无人员', '点击添加人员，可从人员库批量加入或临时添加。'))
  } else {
    for (const role of roles) roleListEl.append(roleCard(role))
  }
}

function renderTemplates(): void {
  const templates = getTemplates()
  peopleLibrarySummaryEl.textContent = `${templates.length} 人`
  roleTemplateSelectEl.replaceChildren(new Option('不使用人员库，手动创建', ''))
  for (const template of templates) roleTemplateSelectEl.append(new Option(template.name, template.id))

  templateListEl.replaceChildren()
  peopleLibraryListEl.replaceChildren()
  if (templates.length === 0) {
    peopleLibraryListEl.append(emptyCard('暂无人员', '新建人员后，可在添加人员时复用。'))
  } else {
    for (const template of templates) {
      const card = templateCard(template)
      templateListEl.append(card.cloneNode(true))
      peopleLibraryListEl.append(card)
    }
  }
  if (!personTemplateModalEl.hidden) renderTemplateEditor()
}

function renderTemplateEditor(): void {
  const selectedTemplate = selectedTemplateId ? store.roleTemplatesById[selectedTemplateId] : undefined
  templateFormTitleEl.textContent = selectedTemplate ? `编辑人员：${selectedTemplate.name}` : '新建人员'
  if (selectedTemplate) {
    const defaultChatSite = selectedTemplate.defaultChatSite ?? store.settings.defaultChatSite
    templateNameEl.value = selectedTemplate.name
    templateDescriptionEl.value = selectedTemplate.description ?? ''
    templatePromptEl.value = selectedTemplate.systemPrompt
    templateSiteGeminiEl.checked = defaultChatSite === 'gemini'
    templateSiteChatGptEl.checked = defaultChatSite === 'chatgpt'
    templateSiteClaudeEl.checked = defaultChatSite === 'claude'
  } else {
    templateNameEl.value = ''
    templateDescriptionEl.value = ''
    templatePromptEl.value = ''
    templateSiteGeminiEl.checked = store.settings.defaultChatSite === 'gemini'
    templateSiteChatGptEl.checked = store.settings.defaultChatSite === 'chatgpt'
    templateSiteClaudeEl.checked = store.settings.defaultChatSite === 'claude'
  }
}

function openTemplateEditor(templateId?: string): void {
  selectedTemplateId = templateId
  renderTemplateEditor()
  personTemplateModalEl.hidden = false
  templateNameEl.focus()
}

function closeTemplateEditor(): void {
  personTemplateModalEl.hidden = true
  selectedTemplateId = undefined
}

function openAddPersonDialog(): void {
  if (!getCurrentChat()) return
  addPersonModalEl.hidden = false
  addPersonSiteMenuId = undefined
  log.info('ui:person-add-dialog:open', { chatId: getCurrentChat()?.id, source: 'mixed' })
  renderAddPersonDialog()
}

function openTemporaryPersonDialog(): void {
  temporaryPersonNameEl.value = ''
  temporaryPersonDescriptionEl.value = ''
  temporaryPersonPromptEl.value = ''
  temporaryPersonModalEl.hidden = false
  temporaryPersonNameEl.focus()
}

function closeTemporaryPersonDialog(): void {
  temporaryPersonModalEl.hidden = true
}

function roleCard(role: GroupRole): HTMLElement {
  const card = document.createElement('section')
  card.className = `role-card${role.id === selectedRoleId ? ' active' : ''}`
  card.addEventListener('click', () => {
    selectedRoleId = role.id
    roleSiteMenuRoleId = undefined
    renderRolePanel()
  })

  const avatar = document.createElement('div')
  avatar.className = `role-avatar ${roleToneClass(role.name)}`
  avatar.textContent = roleAvatarLabel(role.name)

  const main = document.createElement('div')
  main.className = 'role-card-main'

  const row = document.createElement('div')
  row.className = 'role-row'
  const name = document.createElement('div')
  name.className = 'role-name'
  name.textContent = role.name
  row.append(name, statusPill(role.status, roleStatusLabel(role.status)))

  const description = document.createElement('div')
  description.className = 'role-description'
  description.textContent = role.description || '未填写人员描述'

  const meta = document.createElement('div')
  meta.className = 'chat-row tiny role-meta'
  meta.append(roleSiteControl(role), textNode(`cursor ${role.contextCursor}`), textNode(role.geminiConversationUrl ? '已有会话' : '未绑定会话'))
  main.append(row, description, meta)

  const more = document.createElement('button')
  more.type = 'button'
  more.className = 'role-more'
  more.setAttribute('aria-label', `切换 ${role.name} 的站点`)
  more.textContent = '···'
  more.addEventListener('click', event => {
    event.stopPropagation()
    roleSiteMenuRoleId = roleSiteMenuRoleId === role.id ? undefined : role.id
    renderRolePanel()
  })
  card.append(avatar, main, more)

  if (role.status === 'error') {
    const error = document.createElement('div')
    error.className = 'reference-box'
    error.textContent = '人员异常。若目标站点未登录，请打开登录页后点击恢复人员。'
    main.append(error)
  }
  return card
}

function roleSiteControl(role: GroupRole): HTMLElement {
  const control = document.createElement('div')
  control.className = 'role-site-control'
  const sitePill = document.createElement('button')
  sitePill.type = 'button'
  sitePill.className = `site-pill site-pill-${role.chatSite ?? 'gemini'}`
  sitePill.setAttribute('aria-expanded', String(roleSiteMenuRoleId === role.id))
  sitePill.textContent = siteLabel(role.chatSite)
  sitePill.addEventListener('click', event => {
    event.stopPropagation()
    roleSiteMenuRoleId = roleSiteMenuRoleId === role.id ? undefined : role.id
    renderRolePanel()
  })
  control.append(sitePill)
  if (roleSiteMenuRoleId === role.id) control.append(roleSiteMenu(role))
  return control
}

function roleSiteMenu(role: GroupRole): HTMLElement {
  const menu = document.createElement('div')
  menu.className = 'role-site-menu'
  menu.addEventListener('click', event => event.stopPropagation())
  for (const site of ['gemini', 'chatgpt', 'claude'] as const) {
    const option = document.createElement('button')
    option.type = 'button'
    option.className = `role-site-option${role.chatSite === site ? ' active' : ''}`
    option.textContent = role.chatSite === site ? `✓ ${siteLabel(site)}` : siteLabel(site)
    option.addEventListener('click', () => {
      roleSiteMenuRoleId = undefined
      if (role.chatSite === site) {
        renderRolePanel()
        return
      }
      switchRoleSite(role, site).catch(error => showError(error instanceof Error ? error.message : String(error)))
    })
    menu.append(option)
  }
  return menu
}

function isTemplateUsed(templateId: string): boolean {
  return Object.values(store.rolesById).some(role => role.templateId === templateId)
}

function siteLabel(site: ChatSite | undefined): string {
  if (site === 'chatgpt') return 'ChatGPT'
  if (site === 'claude') return 'Claude'
  return 'Gemini'
}

async function switchRoleSite(role: GroupRole, chatSite: ChatSite): Promise<void> {
  if (role.chatSite === chatSite) return
  await runCommand('GROUP_ROLE_UPDATE', { roleId: role.id, patch: { chatSite } })
  const updatedRole = store.rolesById[role.id]
  if (!updatedRole) return
  iframeHost.recoverRole(updatedRole)
  await runCommand('GROUP_ROLE_RECOVER', { chatId: updatedRole.chatId, roleId: updatedRole.id })
}

function templateCard(template: RoleTemplate): HTMLElement {
  const card = document.createElement('section')
  card.className = 'template-card'

  const body = document.createElement('div')
  body.className = 'template-card-body'
  const row = document.createElement('div')
  row.className = 'role-row'
  const name = document.createElement('div')
  name.className = 'role-name'
  name.textContent = template.name
  const used = document.createElement('span')
  used.className = 'tiny'
  used.textContent = isTemplateUsed(template.id) ? '已被群聊使用' : '可删除'
  row.append(name, used)

  const description = document.createElement('div')
  description.className = 'template-description'
  description.textContent = template.description || '未填写人员库描述'
  const site = document.createElement('div')
  site.className = 'template-description'
  site.textContent = `默认站点：${siteLabel(template.defaultChatSite ?? store.settings.defaultChatSite)}`
  body.append(row, description, site)

  const edit = document.createElement('button')
  edit.type = 'button'
  edit.className = 'btn btn-ghost template-edit'
  edit.textContent = '编辑'
  edit.addEventListener('click', event => {
    event.stopPropagation()
    openTemplateEditor(template.id)
  })

  const actions = document.createElement('div')
  actions.className = 'template-card-actions'
  actions.append(edit)

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'btn btn-danger template-delete'
  remove.textContent = '删除'
  remove.addEventListener('click', event => {
    event.stopPropagation()
    deleteTemplate(template)
  })
  if (!isTemplateUsed(template.id)) actions.append(remove)

  card.append(body, actions)
  return card
}

function renderAddPersonDialog(): void {
  const items = addPersonItems()
  addLibraryPeopleListEl.replaceChildren()
  if (items.length === 0) {
    addLibraryPeopleListEl.append(emptyCard('暂无可选人员', '先在人员库中新建人员，或点击右上角临时添加。'))
    return
  }

  for (const item of items) {
    const label = document.createElement('label')
    label.className = 'select-row'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.value = item.key
    const content = document.createElement('span')
    content.className = 'select-row-content'
    const name = document.createElement('strong')
    name.textContent = item.name
    const description = document.createElement('div')
    description.className = 'template-description'
    description.textContent = item.description || '未填写描述'
    const site = document.createElement('div')
    site.className = 'template-description'
    site.textContent = item.source === 'temporary' ? '临时人员' : '人员库'
    content.append(name, description, site)
    label.append(checkbox, content, addPersonSiteControl(item.key, item.chatSite))
    addLibraryPeopleListEl.append(label)
  }
}

function addPersonItems(): AddPersonItem[] {
  const libraryItems = getTemplates().map(template => {
    const key = `library:${template.id}`
    const chatSite = addPersonSiteByKey.get(key) ?? template.defaultChatSite ?? store.settings.defaultChatSite
    addPersonSiteByKey.set(key, chatSite)
    return {
      key,
      source: 'library' as const,
      roleTemplateId: template.id,
      name: template.name,
      description: template.description,
      chatSite,
    }
  })
  const temporaryItems = temporaryPersonDrafts.map(draft => {
    const key = `temporary:${draft.id}`
    const chatSite = addPersonSiteByKey.get(key) ?? draft.chatSite
    addPersonSiteByKey.set(key, chatSite)
    return {
      key,
      source: 'temporary' as const,
      draftId: draft.id,
      name: draft.name,
      description: draft.description,
      systemPrompt: draft.systemPrompt,
      chatSite,
    }
  })
  return [...libraryItems, ...temporaryItems]
}

function addPersonSiteControl(itemKey: string, chatSite: ChatSite): HTMLElement {
  const control = document.createElement('div')
  control.className = 'role-site-control'
  const sitePill = document.createElement('button')
  sitePill.type = 'button'
  sitePill.className = `site-pill site-pill-${chatSite}`
  sitePill.setAttribute('aria-expanded', String(addPersonSiteMenuId === itemKey))
  sitePill.textContent = siteLabel(chatSite)
  sitePill.addEventListener('click', event => {
    event.preventDefault()
    event.stopPropagation()
    addPersonSiteMenuId = addPersonSiteMenuId === itemKey ? undefined : itemKey
    renderAddPersonDialog()
  })
  control.append(sitePill)
  if (addPersonSiteMenuId === itemKey) control.append(addPersonSiteMenu(itemKey, chatSite))
  return control
}

function addPersonSiteMenu(itemKey: string, currentSite: ChatSite): HTMLElement {
  const menu = document.createElement('div')
  menu.className = 'role-site-menu'
  menu.addEventListener('click', event => event.stopPropagation())
  for (const site of ['gemini', 'chatgpt', 'claude'] as const) {
    const option = document.createElement('button')
    option.type = 'button'
    option.className = `role-site-option${currentSite === site ? ' active' : ''}`
    option.textContent = currentSite === site ? `✓ ${siteLabel(site)}` : siteLabel(site)
    option.addEventListener('click', event => {
      event.preventDefault()
      addPersonSiteByKey.set(itemKey, site)
      addPersonSiteMenuId = undefined
      renderAddPersonDialog()
    })
    menu.append(option)
  }
  return menu
}

function referenceBox(reference: MessageReference): HTMLElement {
  const box = document.createElement('div')
  box.className = 'reference-box'
  box.textContent = `引用 ${reference.roleName || '人员'}：${truncate(reference.contentSnapshot, 160)}`
  return box
}

function emptyCard(title: string, body: string): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'empty-state'
  const card = document.createElement('div')
  card.className = 'empty-card'
  const heading = document.createElement('h3')
  heading.textContent = title
  const paragraph = document.createElement('p')
  paragraph.className = 'muted'
  paragraph.textContent = body
  card.append(heading, paragraph)
  wrapper.append(card)
  return wrapper
}

function emptyChatPeopleCard(title: string, body: string): HTMLElement {
  const wrapper = emptyCard(title, body)
  const card = wrapper.querySelector('.empty-card')
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'btn btn-primary'
  button.textContent = '添加人员'
  button.addEventListener('click', openAddPersonDialog)
  card?.append(button)
  return wrapper
}

function statusPill(status: string, label: string): HTMLElement {
  const pill = document.createElement('span')
  pill.className = `status-pill status-${status}`
  pill.textContent = label
  return pill
}

function roleToneClass(seed: string | undefined): string {
  const source = seed || 'OpenTeam'
  let hash = 0
  for (let index = 0; index < source.length; index += 1) hash = (hash + source.charCodeAt(index) * (index + 1)) % 6
  return `role-tone-${hash}`
}

function roleAvatarLabel(name: string | undefined): string {
  return getAvatarInitial(name)
}

function messageAvatarLabel(message: GroupMessage): string {
  if (message.type === 'user') return '你'
  return roleAvatarLabel(message.roleName)
}

function messageToneClass(message: GroupMessage): string {
  if (message.type === 'user') return 'role-tone-5'
  return roleToneClass(message.roleName)
}

function textNode(content: string): Text {
  return document.createTextNode(content)
}

function switchChat(chatId: string): void {
  if (chatId === selectedChatId) {
    chatMenuChatId = undefined
    roleSiteMenuRoleId = undefined
    renderChatList()
    renderRolePanel()
    return
  }
  selectedChatId = chatId
  selectedRoleId = undefined
  selectedReference = undefined
  peopleDrawerOpen = false
  chatMenuChatId = undefined
  roleSiteMenuRoleId = undefined
  renderSelectedChat()
  if (pendingSwitchAnimationFrame !== undefined) window.cancelAnimationFrame(pendingSwitchAnimationFrame)
  pendingSwitchAnimationFrame = window.requestAnimationFrame(() => {
    pendingSwitchAnimationFrame = undefined
    if (selectedChatId !== chatId) return
    runCommand('GROUP_CHAT_SWITCH', { chatId })
      .catch(error => showError(error.message))
  })
}

async function reconnectRolesForSend(chat: GroupChat, roles: GroupRole[]): Promise<void> {
  const uniqueRoles = [...new Map(roles.map(role => [role.id, role])).values()]
  if (uniqueRoles.length === 0) return

  for (const role of uniqueRoles) reconnectingRoleKeys.add(teamRoleKey(chat.id, role.id))
  renderComposerState()

  try {
    log.info('roles:auto-reconnect:start', { chatId: chat.id, roleIds: uniqueRoles.map(role => role.id) })
    await Promise.all(uniqueRoles.map(role => runCommand('GROUP_ROLE_RECOVER', { chatId: chat.id, roleId: role.id })))
    for (const role of uniqueRoles) iframeHost.recoverRole(role)
    await waitForRolesReady(chat.id, uniqueRoles.map(role => role.id))
    log.info('roles:auto-reconnect:ready', { chatId: chat.id, roleIds: uniqueRoles.map(role => role.id) })
  } finally {
    for (const role of uniqueRoles) reconnectingRoleKeys.delete(teamRoleKey(chat.id, role.id))
    renderComposerState()
  }
}

function focusRoleFrame(chatId: string, roleId: string | undefined): void {
  if (!roleId) return
  setWindowMinimized(true)
  const chat = store.chatsById[chatId]
  if (chat && selectedChatId !== chatId) switchChat(chatId)
  if (iframeHost.focusRoleFrame(chatId, roleId)) return
  const role = store.rolesById[roleId]
  if (!role) return
  iframeHost.recoverRole(role)
}

async function interruptAndRetryRole(role: GroupRole): Promise<void> {
  const chat = store.chatsById[role.chatId]
  if (!chat) return
  await runCommand('GROUP_ROLE_RECOVER', { chatId: chat.id, roleId: role.id })
  iframeHost.recoverRole(role)
  await waitForRolesReady(chat.id, [role.id])
  await runCommand('GROUP_ROLE_RETRY_REPLY', { chatId: chat.id, roleId: role.id })
}

async function sendMessageAfterReconnect(chat: GroupChat, raw: string, reference: MessageReference | undefined, targetRoles: GroupRole[], retryOnUnavailable = true): Promise<void> {
  try {
    await runCommand('GROUP_MESSAGE_SEND', { chatId: chat.id, raw, reference })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!retryOnUnavailable || !isUnavailableRolesError(message)) throw error
    const reconnectableRoles = targetRoles.filter(role => role.status === 'ready' || shouldAutoReconnectRole(role))
    if (reconnectableRoles.length === 0) throw error
    await reconnectRolesForSend(chat, reconnectableRoles)
    await sendMessageAfterReconnect(chat, raw, reference, targetRoles, false)
  }
}

function clearComposerAfterSend(raw: string, reference: MessageReference | undefined): void {
  if (messageInputEl.value.trim() === raw) messageInputEl.value = ''
  if (selectedReference === reference) selectedReference = undefined
  renderComposerState()
}

async function submitComposerMessage(): Promise<void> {
  const chat = getCurrentChat()
  const raw = messageInputEl.value.trim()
  if (!chat || !raw) return

  const targetResult = resolveMessageTargets(raw, getCurrentRoles())
  if (!targetResult.ok) {
    showError(targetResult.error)
    return
  }

  const waitingRoles = targetResult.roles.filter(role => role.status === 'thinking' && !shouldAutoReconnectRole(role))
  if (waitingRoles.length > 0) {
    showError(`请等待人员回复完成：${waitingRoles.map(role => role.name).join('、')}`)
    return
  }

  const reference = selectedReference
  const reconnectableRoles = targetResult.roles.filter(role => role.status !== 'ready' && shouldAutoReconnectRole(role))
  if (reconnectableRoles.length > 0) await reconnectRolesForSend(chat, reconnectableRoles)

  await sendMessageAfterReconnect(chat, raw, reference, targetResult.roles)
  clearComposerAfterSend(raw, reference)
}

function setReference(message: GroupMessage): void {
  selectedReference = {
    messageId: message.id,
    roleId: message.roleId,
    roleName: message.roleName,
    contentSnapshot: message.content,
  }
  messageInputEl.focus()
  renderComposerState()
}

function shouldShowMentionPanel(value: string): boolean {
  const cursor = messageInputEl.selectionStart ?? value.length
  const beforeCursor = value.slice(0, cursor)
  const atIndex = beforeCursor.lastIndexOf('@')
  if (atIndex < 0) return false
  const mentionText = beforeCursor.slice(atIndex + 1)
  return !/\s/.test(mentionText)
}

function insertMention(role: GroupRole): void {
  const value = messageInputEl.value
  const cursor = messageInputEl.selectionStart ?? value.length
  const beforeCursor = value.slice(0, cursor)
  const atIndex = beforeCursor.lastIndexOf('@')
  const prefix = atIndex >= 0 ? value.slice(0, atIndex) : value.slice(0, cursor)
  const suffix = value.slice(cursor)
  const inserted = `${prefix}@${role.name} ${suffix}`
  messageInputEl.value = inserted
  const nextCursor = prefix.length + role.name.length + 2
  messageInputEl.setSelectionRange(nextCursor, nextCursor)
  messageInputEl.focus()
  mentionPanelEl.hidden = true
  renderComposerState()
}

function getChatRecentSummary(chat: GroupChat): string {
  const lastMessageId = chat.messageIds[chat.messageIds.length - 1]
  const message = lastMessageId ? store.messagesById[lastMessageId] : undefined
  if (!message) return '暂无消息。可恢复聊天、添加人员或发送第一条任务。'
  return `${messageTitle(message)}：${truncate(message.content, 72)}`
}

function messageTitle(message: GroupMessage): string {
  if (message.type === 'user') return '我'
  if (message.type === 'assistant') return message.roleName || 'AI 人员'
  return '系统'
}

function modeLabel(mode: RoomMode): string {
  return mode === 'collaborative' ? '协作群聊模式' : '独立专家模式'
}

function chatStatusLabel(status: GroupChat['status']): string {
  const labels: Record<GroupChat['status'], string> = {
    draft: '草稿',
    initializing: '初始化中',
    ready: '进行中',
    running: '运行中',
    error: '异常',
  }
  return labels[status]
}

function roleStatusLabel(status: RoleStatus): string {
  const labels: Record<RoleStatus, string> = {
    pending: '待唤醒',
    loading: '加载中',
    ready: '就绪',
    thinking: '回复中',
    error: '异常',
  }
  return labels[status]
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value
}

function readTemplateDraft(): TemplateDraft {
  return {
    name: templateNameEl.value.trim(),
    description: templateDescriptionEl.value.trim(),
    systemPrompt: templatePromptEl.value.trim(),
    defaultChatSite: readTemplateChatSite(),
  }
}

function validatePersonDraft(draft: TemplateDraft): string | undefined {
  if (!draft.name) return '人员名称不能为空'
  if (Array.from(draft.name).length > 10) return '人员名称最多 10 个字'
  if (!draft.systemPrompt.trim()) return '人设不能为空'
  return undefined
}

function selectedAddPersonItems(): Record<string, unknown>[] {
  const checkedKeys = new Set(Array.from(addLibraryPeopleListEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')).map(input => input.value))
  return addPersonItems().filter(item => checkedKeys.has(item.key)).map(item => {
    const chatSite = addPersonSiteByKey.get(item.key) ?? item.chatSite
    if (item.source === 'library') return { source: 'library', roleTemplateId: item.roleTemplateId, chatSite }
    return {
      source: 'temporary',
      name: item.name,
      description: item.description,
      systemPrompt: item.systemPrompt,
      chatSite,
    }
  })
}

function readTemplateChatSite(): ChatSite {
  const selected = document.querySelector<HTMLInputElement>('input[name="template-chat-site"]:checked')
  if (selected?.value === 'chatgpt') return 'chatgpt'
  if (selected?.value === 'claude') return 'claude'
  return 'gemini'
}

async function addPeopleToCurrentChat(items: Record<string, unknown>[]): Promise<void> {
  const chat = getCurrentChat()
  if (!chat) return
  if (items.length === 0) throw new Error('请选择或填写要添加的人员')
  await runCommand('GROUP_ROLES_CREATE_BATCH', { chatId: chat.id, items })
}

function deleteTemplate(template: RoleTemplate): void {
  if (isTemplateUsed(template.id)) return
  if (!window.confirm(`确定删除「${template.name}」吗？删除后这个人员会从人员库移除。`)) return
  if (selectedTemplateId === template.id) closeTemplateEditor()
  runCommand('ROLE_TEMPLATE_DELETE', { templateId: template.id }).catch(error => showError(error.message))
}

function readNewChatMode(): RoomMode {
  const selected = document.querySelector<HTMLInputElement>('input[name="new-chat-mode"]:checked')
  return selected?.value === 'collaborative' ? 'collaborative' : 'independent'
}

function setChatCreatePopoverVisible(visible: boolean): void {
  createChatFormEl.hidden = !visible
  quickCreateChatEl.setAttribute('aria-expanded', String(visible))
  if (visible) newChatNameEl.focus()
}

function showError(message: string): void {
  errorEl.textContent = message
  errorEl.hidden = false
  window.setTimeout(() => {
    errorEl.hidden = true
  }, 5200)
}

function registerRuntimePush(): void {
  chrome.runtime.onMessage.addListener((message: StorePushMessage) => {
    if (!message || typeof message.type !== 'string') return false
    if (message.type === 'TEAM_FRAME_ROLE_READY') iframeHost.markRoleReady(message.chatId, message.roleId)
    if (message.store) applyStore(message.store)
    if (message.type === 'GROUP_DELIVERY_ERROR' && message.error) showError(message.error)
    return false
  })
}

function ensureShellPositioned(): DOMRect {
  const rect = appShellEl.getBoundingClientRect()
  appShellEl.style.left = `${rect.left}px`
  appShellEl.style.top = `${rect.top}px`
  appShellEl.style.transform = 'none'
  return rect
}

function moveShellTo(left: number, top: number): void {
  const margin = 8
  const rect = appShellEl.getBoundingClientRect()
  const maxLeft = Math.max(margin, window.innerWidth - Math.min(rect.width, window.innerWidth - margin * 2) - margin)
  const maxTop = Math.max(margin, window.innerHeight - Math.min(rect.height, window.innerHeight - margin * 2) - margin)
  appShellEl.style.left = `${Math.min(Math.max(margin, left), maxLeft)}px`
  appShellEl.style.top = `${Math.min(Math.max(margin, top), maxTop)}px`
  appShellEl.style.transform = 'none'
}

function clampShellPosition(): void {
  if (appShellEl.style.transform !== 'none') return

  const rect = appShellEl.getBoundingClientRect()
  moveShellTo(rect.left, rect.top)
}

function setWindowMinimized(minimized: boolean): void {
  if (!minimized && appShellEl.style.transform !== 'none') ensureShellPositioned()
  appShellEl.classList.toggle('minimized', minimized)
  windowLauncherEl.hidden = !minimized
  toggleWindowSizeEl.textContent = minimized ? '□' : '−'
  toggleWindowSizeEl.setAttribute('aria-expanded', String(!minimized))
  if (!minimized) window.requestAnimationFrame(clampShellPosition)
}

function registerFloatingWindowControls(): void {
  let dragOffsetX = 0
  let dragOffsetY = 0
  let activePointerId: number | undefined

  floatingDragHandleEl.addEventListener('pointerdown', event => {
    if (event.button !== 0) return

    const rect = ensureShellPositioned()
    dragOffsetX = event.clientX - rect.left
    dragOffsetY = event.clientY - rect.top
    activePointerId = event.pointerId
    appShellEl.classList.add('dragging')
    floatingDragHandleEl.setPointerCapture(event.pointerId)
    event.preventDefault()
  })

  floatingDragHandleEl.addEventListener('pointermove', event => {
    if (activePointerId !== event.pointerId) return
    moveShellTo(event.clientX - dragOffsetX, event.clientY - dragOffsetY)
  })

  function stopDragging(event: PointerEvent): void {
    if (activePointerId !== event.pointerId) return
    activePointerId = undefined
    appShellEl.classList.remove('dragging')
    if (floatingDragHandleEl.hasPointerCapture(event.pointerId)) floatingDragHandleEl.releasePointerCapture(event.pointerId)
  }

  floatingDragHandleEl.addEventListener('pointerup', stopDragging)
  floatingDragHandleEl.addEventListener('pointercancel', stopDragging)
  toggleWindowSizeEl.addEventListener('click', () => setWindowMinimized(!appShellEl.classList.contains('minimized')))
  windowLauncherEl.addEventListener('click', () => setWindowMinimized(false))
  window.addEventListener('resize', clampShellPosition)
}

function registerUi(): void {
  requireElement<HTMLButtonElement>('#refresh-store').addEventListener('click', () => {
    refreshCurrentChat().catch(error => showError(error instanceof Error ? error.message : String(error)))
  })

  quickCreateChatEl.addEventListener('click', () => {
    setChatCreatePopoverVisible(createChatFormEl.hidden)
  })

  settingsButtonEl.addEventListener('click', event => {
    event.stopPropagation()
    const visible = settingsMenuEl.hidden
    settingsMenuEl.hidden = !visible
    settingsButtonEl.setAttribute('aria-expanded', String(visible))
    log.debug('ui:settings-menu:open')
  })

  requireElement<HTMLButtonElement>('#open-people-library').addEventListener('click', () => {
    settingsMenuEl.hidden = true
    settingsButtonEl.setAttribute('aria-expanded', 'false')
    peopleLibraryModalEl.hidden = false
    log.info('ui:people-library:open', { templateCount: getTemplates().length })
    renderTemplates()
  })

  requireElement<HTMLButtonElement>('#close-people-library').addEventListener('click', () => {
    peopleLibraryModalEl.hidden = true
  })

  requireElement<HTMLButtonElement>('#new-template').addEventListener('click', () => {
    openTemplateEditor()
  })

  requireElement<HTMLButtonElement>('#close-person-template').addEventListener('click', closeTemplateEditor)

  requireElement<HTMLButtonElement>('#close-add-person').addEventListener('click', () => {
    addPersonModalEl.hidden = true
    addPersonSiteMenuId = undefined
  })

  requireElement<HTMLButtonElement>('#open-temporary-person').addEventListener('click', openTemporaryPersonDialog)

  requireElement<HTMLButtonElement>('#close-temporary-person').addEventListener('click', closeTemporaryPersonDialog)

  togglePeopleDrawerEl.addEventListener('click', () => {
    peopleDrawerOpen = !peopleDrawerOpen
    render()
  })

  requireElement<HTMLButtonElement>('#close-people-drawer').addEventListener('click', () => {
    peopleDrawerOpen = false
    render()
  })

  document.addEventListener('click', event => {
    if (!settingsMenuEl.hidden && !settingsMenuEl.contains(event.target as Node) && event.target !== settingsButtonEl) {
      settingsMenuEl.hidden = true
      settingsButtonEl.setAttribute('aria-expanded', 'false')
    }
    if (chatMenuChatId && !(event.target as Element | null)?.closest('.chat-action-menu, .chat-menu-btn')) {
      chatMenuChatId = undefined
      renderChatList()
    }
    if (roleSiteMenuRoleId && !(event.target as Element | null)?.closest('.role-site-menu, .site-pill, .role-more')) {
      roleSiteMenuRoleId = undefined
      renderRolePanel()
    }
    if (addPersonSiteMenuId && !(event.target as Element | null)?.closest('.role-site-menu, .site-pill')) {
      addPersonSiteMenuId = undefined
      renderAddPersonDialog()
    }
  })

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    settingsMenuEl.hidden = true
    settingsButtonEl.setAttribute('aria-expanded', 'false')
    peopleLibraryModalEl.hidden = true
    personTemplateModalEl.hidden = true
    addPersonModalEl.hidden = true
    temporaryPersonModalEl.hidden = true
    selectedTemplateId = undefined
    chatMenuChatId = undefined
    roleSiteMenuRoleId = undefined
    addPersonSiteMenuId = undefined
    renderChatList()
    renderRolePanel()
  })

  requireElement<HTMLButtonElement>('#close-window').addEventListener('click', () => {
    window.close()
  })

  requireElement<HTMLButtonElement>('#cancel-create-chat').addEventListener('click', () => {
    setChatCreatePopoverVisible(false)
  })

  createChatFormEl.addEventListener('submit', event => {
    event.preventDefault()
    const name = newChatNameEl.value.trim() || '新群聊'
    const mode = readNewChatMode()
    newChatNameEl.value = ''
    setChatCreatePopoverVisible(false)
    runCommand('GROUP_CHAT_CREATE', { name, mode, roles: [] }).catch(error => showError(error.message))
  })

  requireElement<HTMLButtonElement>('#restore-chat').addEventListener('click', () => {
    const chat = getCurrentChat()
    if (!chat) return
    const roles = getCurrentRoles()
    log.info('ui:restore-chat', { chatId: chat.id, roleIds: roles.map(role => role.id) })
    iframeHost.restoreChat(chat, roles)
    Promise.all(roles.map(role => runCommand('GROUP_ROLE_RECOVER', { chatId: chat.id, roleId: role.id }))).catch(error => showError(error.message))
  })

  requireElement<HTMLFormElement>('#composer').addEventListener('submit', event => {
    event.preventDefault()
    if (sendButtonEl.disabled && reconnectingRoleKeys.size > 0) return
    submitComposerMessage().catch(error => showError(error instanceof Error ? error.message : String(error)))
  })

  messageInputEl.addEventListener('input', () => {
    mentionIndex = 0
    renderComposerState()
  })
  messageInputEl.addEventListener('keyup', () => renderComposerState())
  messageInputEl.addEventListener('keydown', event => {
    const roles = getCurrentRoles()
    if (!mentionPanelEl.hidden) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        mentionIndex = (mentionIndex + 1) % roles.length
        renderMentionPanel()
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        mentionIndex = (mentionIndex - 1 + roles.length) % roles.length
        renderMentionPanel()
      } else if (shouldConfirmMentionWithEnter(event)) {
        event.preventDefault()
        const role = roles[mentionIndex]
        if (role) insertMention(role)
      } else if (event.key === 'Escape') {
        mentionPanelEl.hidden = true
      }
      return
    }

    if (shouldSendMessageWithEnter(event)) {
      event.preventDefault()
      requireElement<HTMLFormElement>('#composer').requestSubmit()
    }
  })

  requireElement<HTMLFormElement>('#add-role-form').addEventListener('submit', event => {
    event.preventDefault()
    openAddPersonDialog()
  })

  requireElement<HTMLFormElement>('#add-library-people-form').addEventListener('submit', event => {
    event.preventDefault()
    addPeopleToCurrentChat(selectedAddPersonItems())
      .then(() => {
        addPersonModalEl.hidden = true
        addPersonSiteMenuId = undefined
        temporaryPersonDrafts.splice(0)
      })
      .catch(error => showError(error.message))
  })

  requireElement<HTMLFormElement>('#add-temporary-person-form').addEventListener('submit', event => {
    event.preventDefault()
    const draft = {
      name: temporaryPersonNameEl.value.trim(),
      description: temporaryPersonDescriptionEl.value.trim(),
      systemPrompt: temporaryPersonPromptEl.value.trim(),
    }
    const validationError = validatePersonDraft(draft)
    if (validationError) {
      showError(validationError)
      return
    }
    const id = `temporary-${Date.now()}-${Math.random().toString(16).slice(2)}`
    temporaryPersonDrafts.push({ id, ...draft, chatSite: store.settings.defaultChatSite })
    addPersonSiteByKey.set(`temporary:${id}`, store.settings.defaultChatSite)
    closeTemporaryPersonDialog()
    renderAddPersonDialog()
  })

  requireElement<HTMLFormElement>('#people-library-form').addEventListener('submit', event => {
    event.preventDefault()
    const draft = readTemplateDraft()
    const validationError = validatePersonDraft(draft)
    if (validationError) {
      showError(validationError)
      return
    }
    const type = selectedTemplateId ? 'ROLE_TEMPLATE_UPDATE' : 'ROLE_TEMPLATE_CREATE'
    const payload = selectedTemplateId ? { templateId: selectedTemplateId, ...draft } : draft
    runCommand(type, payload)
      .then(closeTemplateEditor)
      .catch(error => showError(error.message))
  })

  requireElement<HTMLButtonElement>('#open-gemini-login').addEventListener('click', () => {
    const site: ChatSite = store.rolesById[selectedRoleId ?? '']?.chatSite ?? store.settings.defaultChatSite
    chrome.tabs.create({ url: getDefaultChatSiteUrl(site) }).catch(error => showError(error instanceof Error ? error.message : String(error)))
  })
}

async function boot(): Promise<void> {
  await resolveHostTabId()
  registerRuntimePush()
  registerFloatingWindowControls()
  registerUi()
  render()
  await refreshStore(false)
}

boot().catch(error => showError(error instanceof Error ? error.message : String(error)))
