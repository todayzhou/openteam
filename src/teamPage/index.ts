import type { GroupChat, GroupMessage, GroupRole, MessageReference, OpenTeamStore, RoleStatus, RoleTemplate, RoomMode } from '../group/types'
import { createDefaultStore } from '../group/store'
import { parseGroupMentions } from '../group/mentionParser'
import { createIframeHost } from './iframeHost'

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

type TemplateDraft = Pick<RoleTemplate, 'name' | 'description' | 'systemPrompt'>
type RolePatch = Pick<GroupRole, 'name' | 'description' | 'systemPrompt'>

const GEMINI_URL = 'https://gemini.google.com/'

let store: OpenTeamStore = createDefaultStore()
let selectedChatId: string | undefined
let selectedRoleId: string | undefined
let selectedTemplateId: string | undefined
let selectedReference: MessageReference | undefined
let hostTabId: number | undefined
let mentionIndex = 0

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
const templateSummaryEl = requireElement<HTMLElement>('#template-summary')
const targetPreviewEl = requireElement<HTMLElement>('#target-preview')
const busyPreviewEl = requireElement<HTMLElement>('#busy-preview')
const sendButtonEl = requireElement<HTMLButtonElement>('#send-message')
const messageInputEl = requireElement<HTMLTextAreaElement>('#message-input')
const referenceDraftEl = requireElement<HTMLElement>('#reference-draft')
const mentionPanelEl = requireElement<HTMLElement>('#mention-panel')
const errorEl = requireElement<HTMLElement>('#error')
const newChatNameEl = requireElement<HTMLInputElement>('#new-chat-name')
const newChatModeEl = requireElement<HTMLSelectElement>('#new-chat-mode')
const newRoleNameEl = requireElement<HTMLInputElement>('#new-role-name')
const editRoleNameEl = requireElement<HTMLInputElement>('#edit-role-name')
const editRoleDescriptionEl = requireElement<HTMLTextAreaElement>('#edit-role-description')
const editRolePromptEl = requireElement<HTMLTextAreaElement>('#edit-role-prompt')
const templateNameEl = requireElement<HTMLInputElement>('#template-name')
const templateDescriptionEl = requireElement<HTMLTextAreaElement>('#template-description')
const templatePromptEl = requireElement<HTMLTextAreaElement>('#template-prompt')
const templateFormTitleEl = requireElement<HTMLElement>('#template-form-title')
const deleteTemplateEl = requireElement<HTMLButtonElement>('#delete-template')
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
  if (response.store) applyStore(response.store)
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
  renderChatList()
  renderChatHeader()
  renderMessages()
  renderComposerState()
  renderRolePanel()
  renderTemplates()
}

function renderChatList(): void {
  const chats = store.chatOrder.map(chatId => store.chatsById[chatId]).filter((chat): chat is GroupChat => Boolean(chat))
  storeSummaryEl.textContent = `${chats.length} 个群聊 · ${getTemplates().length} 个模板`
  chatListEl.replaceChildren()

  if (chats.length === 0) {
    chatListEl.append(emptyCard('还没有群聊', '在上方创建一个群聊，然后从模板库添加角色。'))
    return
  }

  for (const chat of chats) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = `chat-item${chat.id === selectedChatId ? ' active' : ''}`
    item.addEventListener('click', () => switchChat(chat.id))

    const row = document.createElement('div')
    row.className = 'chat-row'
    const name = document.createElement('div')
    name.className = 'chat-name'
    name.textContent = chat.name
    row.append(name, statusPill(chat.status, chatStatusLabel(chat.status)))

    const summary = document.createElement('div')
    summary.className = 'summary-line'
    summary.textContent = getChatRecentSummary(chat)

    const meta = document.createElement('div')
    meta.className = 'chat-row tiny'
    meta.append(textNode(`${chat.roleIds.length} 个角色`), textNode(formatTime(chat.updatedAt)))
    item.append(row, summary, meta)
    chatListEl.append(item)
  }
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
    return
  }

  chatTitleEl.textContent = chat.name
  chatSubtitleEl.textContent = `${modeLabel(chat.mode)} · ${roles.length} 个角色 · ${messages.length} 条消息`
  chatStatusEl.className = `status-pill status-${chat.status}`
  chatStatusEl.textContent = chatStatusLabel(chat.status)
}

function renderMessages(): void {
  const messages = getCurrentMessages()
  messagesEl.replaceChildren()

  if (!getCurrentChat()) {
    messagesEl.append(emptyCard('选择一个群聊', '左侧群聊列表会显示最近摘要、状态和更新时间。'))
    return
  }

  if (messages.length === 0) {
    messagesEl.append(emptyCard('等待第一条消息', '初始化角色后，在下方输入任务；无 @ 默认发送给全部角色。'))
    return
  }

  for (const message of messages) {
    const article = document.createElement('article')
    article.className = `message ${message.type}`

    const meta = document.createElement('div')
    meta.className = 'message-meta tiny'
    meta.append(textNode(messageTitle(message)), textNode(formatTime(message.createdAt)))

    const body = document.createElement('div')
    body.className = 'message-body'
    body.textContent = message.content

    if (message.type === 'system') {
      article.append(meta, body)
      messagesEl.append(article)
      continue
    }

    const avatar = document.createElement('div')
    avatar.className = `message-avatar ${messageToneClass(message)}`
    avatar.textContent = messageAvatarLabel(message)

    const content = document.createElement('div')
    content.className = 'message-content'
    content.append(meta, body)
    if (message.references?.length) content.append(referenceBox(message.references[0]))

    if (message.type === 'assistant') {
      const tools = document.createElement('div')
      tools.className = 'message-tools'
      const quote = document.createElement('button')
      quote.type = 'button'
      quote.className = 'btn btn-ghost'
      quote.textContent = '引用'
      quote.addEventListener('click', () => setReference(message))
      tools.append(quote)
      content.append(tools)
    }

    article.append(avatar, content)
    messagesEl.append(article)
  }
  messagesEl.scrollTop = messagesEl.scrollHeight
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
  const thinking = roles.filter(role => role.status === 'thinking')

  if (!chat) {
    targetPreviewEl.textContent = '选择群聊后可发送'
    sendButtonEl.disabled = true
  } else if (roles.length === 0) {
    targetPreviewEl.textContent = '当前群聊还没有角色'
    sendButtonEl.disabled = true
  } else if (!raw) {
    targetPreviewEl.textContent = '输入消息后可发送；无 @ 默认全员'
    sendButtonEl.disabled = true
  } else if (!parsed.ok) {
    targetPreviewEl.textContent = parsed.error
    sendButtonEl.disabled = true
  } else if (unavailable.length > 0) {
    targetPreviewEl.textContent = `不可发送：${unavailable.map(role => role.name).join('、')} 未 ready`
    sendButtonEl.disabled = true
  } else {
    targetPreviewEl.textContent = `将发送给：${targets.map(role => role.name).join('、') || '全部角色'}`
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
  const content = document.createElement('div')
  const title = document.createElement('div')
  title.className = 'tiny'
  title.textContent = `引用 ${selectedReference.roleName || '角色'} 的观点`
  const body = document.createElement('div')
  body.className = 'summary-line'
  body.textContent = selectedReference.contentSnapshot
  content.append(title, body)

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'btn btn-ghost'
  cancel.textContent = '取消引用'
  cancel.addEventListener('click', () => {
    selectedReference = undefined
    renderComposerState()
  })
  referenceDraftEl.append(content, cancel)
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
  roleSummaryEl.textContent = `${roles.length} 个角色${selectedRole ? ` · 当前：${selectedRole.name}` : ''}`
  roleListEl.replaceChildren()

  if (!getCurrentChat()) {
    roleListEl.append(emptyCard('未选择群聊', '选择群聊后可添加、编辑、恢复和初始化角色。'))
  } else if (roles.length === 0) {
    roleListEl.append(emptyCard('暂无角色', '从下方模板库选择角色，或直接输入新角色名。'))
  } else {
    for (const role of roles) roleListEl.append(roleCard(role))
  }

  editRoleNameEl.value = selectedRole?.name ?? ''
  editRoleDescriptionEl.value = selectedRole?.description ?? ''
  editRolePromptEl.value = selectedRole?.systemPrompt ?? ''
  editRoleNameEl.disabled = !selectedRole
  editRoleDescriptionEl.disabled = !selectedRole
  editRolePromptEl.disabled = !selectedRole
}

function renderTemplates(): void {
  const templates = getTemplates()
  templateSummaryEl.textContent = `${templates.length} 个模板`
  roleTemplateSelectEl.replaceChildren(new Option('不使用模板，手动创建', ''))
  for (const template of templates) roleTemplateSelectEl.append(new Option(template.name, template.id))

  templateListEl.replaceChildren()
  if (templates.length === 0) {
    templateListEl.append(emptyCard('暂无模板', '创建模板后，可在添加角色时复用。'))
  } else {
    for (const template of templates) templateListEl.append(templateCard(template))
  }

  const selectedTemplate = selectedTemplateId ? store.roleTemplatesById[selectedTemplateId] : undefined
  templateFormTitleEl.textContent = selectedTemplate ? `编辑模板：${selectedTemplate.name}` : '创建模板'
  deleteTemplateEl.disabled = !selectedTemplate
  if (selectedTemplate) {
    templateNameEl.value = selectedTemplate.name
    templateDescriptionEl.value = selectedTemplate.description ?? ''
    templatePromptEl.value = selectedTemplate.systemPrompt
  }
}

function roleCard(role: GroupRole): HTMLElement {
  const card = document.createElement('section')
  card.className = `role-card${role.id === selectedRoleId ? ' active' : ''}`
  card.addEventListener('click', () => {
    selectedRoleId = role.id
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
  description.textContent = role.description || '未填写角色描述'

  const meta = document.createElement('div')
  meta.className = 'chat-row tiny'
  meta.append(textNode(`cursor ${role.contextCursor}`), textNode(role.geminiConversationUrl ? '已有会话' : '未绑定会话'))
  main.append(row, description, meta)

  const more = document.createElement('div')
  more.className = 'role-more'
  more.textContent = '···'
  card.append(avatar, main, more)

  if (role.status === 'error') {
    const error = document.createElement('div')
    error.className = 'reference-box'
    error.textContent = '角色异常。若 Gemini 未登录，请打开登录页后点击恢复角色。'
    main.append(error)
  }
  return card
}

function templateCard(template: RoleTemplate): HTMLElement {
  const card = document.createElement('section')
  card.className = `template-card${template.id === selectedTemplateId ? ' active' : ''}`
  card.addEventListener('click', () => {
    selectedTemplateId = template.id
    renderTemplates()
  })

  const row = document.createElement('div')
  row.className = 'role-row'
  const name = document.createElement('div')
  name.className = 'role-name'
  name.textContent = template.name
  const use = document.createElement('button')
  use.type = 'button'
  use.className = 'btn btn-ghost'
  use.textContent = '选择'
  use.addEventListener('click', event => {
    event.stopPropagation()
    roleTemplateSelectEl.value = template.id
    newRoleNameEl.value = ''
  })
  row.append(name, use)

  const description = document.createElement('div')
  description.className = 'template-description'
  description.textContent = template.description || '未填写模板描述'
  card.append(row, description)
  return card
}

function referenceBox(reference: MessageReference): HTMLElement {
  const box = document.createElement('div')
  box.className = 'reference-box'
  box.textContent = `引用 ${reference.roleName || '角色'}：${truncate(reference.contentSnapshot, 160)}`
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
  const trimmed = name?.trim()
  if (!trimmed) return 'AI'
  return trimmed.slice(0, Math.min(2, trimmed.length)).toUpperCase()
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
  selectedChatId = chatId
  selectedRoleId = undefined
  selectedReference = undefined
  render()
  runCommand('GROUP_CHAT_SWITCH', { chatId }).catch(error => showError(error.message))
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
  if (!message) return '暂无消息。可恢复聊天、添加角色或发送第一条任务。'
  return `${messageTitle(message)}：${truncate(message.content, 72)}`
}

function messageTitle(message: GroupMessage): string {
  if (message.type === 'user') return message.targetRoleIds?.length ? `你 -> ${roleNames(message.targetRoleIds)}` : '你 -> 全部角色'
  if (message.type === 'assistant') return message.roleName || 'AI 角色'
  return '系统'
}

function roleNames(roleIds: string[]): string {
  const names = roleIds.map(roleId => store.rolesById[roleId]?.name).filter((name): name is string => Boolean(name))
  return names.length > 0 ? names.join('、') : '全部角色'
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

function formatTime(timestamp: number): string {
  if (!timestamp) return '-'
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(timestamp)
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value
}

function readTemplateDraft(): TemplateDraft {
  return {
    name: templateNameEl.value.trim(),
    description: templateDescriptionEl.value.trim(),
    systemPrompt: templatePromptEl.value.trim(),
  }
}

function readRolePatch(): RolePatch {
  return {
    name: editRoleNameEl.value.trim(),
    description: editRoleDescriptionEl.value.trim(),
    systemPrompt: editRolePromptEl.value.trim(),
  }
}

function resetTemplateForm(): void {
  selectedTemplateId = undefined
  templateNameEl.value = ''
  templateDescriptionEl.value = ''
  templatePromptEl.value = ''
  renderTemplates()
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
  if (appShellEl.style.transform !== 'none') ensureShellPositioned()
  appShellEl.classList.toggle('minimized', minimized)
  toggleWindowSizeEl.textContent = minimized ? '□' : '−'
  toggleWindowSizeEl.setAttribute('aria-expanded', String(!minimized))
  window.requestAnimationFrame(clampShellPosition)
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
  window.addEventListener('resize', clampShellPosition)
}

function registerUi(): void {
  requireElement<HTMLButtonElement>('#refresh-store').addEventListener('click', () => {
    refreshStore().catch(error => showError(error instanceof Error ? error.message : String(error)))
  })

  requireElement<HTMLButtonElement>('#quick-create-chat').addEventListener('click', () => {
    const mode = newChatModeEl.value as RoomMode
    runCommand('GROUP_CHAT_CREATE', { name: '新群聊', mode, roles: [] }).catch(error => showError(error.message))
  })

  requireElement<HTMLButtonElement>('#close-window').addEventListener('click', () => {
    window.close()
  })

  requireElement<HTMLFormElement>('#create-chat-form').addEventListener('submit', event => {
    event.preventDefault()
    const name = newChatNameEl.value.trim() || '新群聊'
    const mode = newChatModeEl.value as RoomMode
    newChatNameEl.value = ''
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
    const chat = getCurrentChat()
    const raw = messageInputEl.value.trim()
    if (!chat || !raw || sendButtonEl.disabled) return
    const reference = selectedReference
    messageInputEl.value = ''
    selectedReference = undefined
    renderComposerState()
    runCommand('GROUP_MESSAGE_SEND', { chatId: chat.id, raw, reference }).catch(error => showError(error.message))
  })

  messageInputEl.addEventListener('input', () => {
    mentionIndex = 0
    renderComposerState()
  })
  messageInputEl.addEventListener('keyup', () => renderComposerState())
  messageInputEl.addEventListener('keydown', event => {
    if (mentionPanelEl.hidden) return
    const roles = getCurrentRoles()
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      mentionIndex = (mentionIndex + 1) % roles.length
      renderMentionPanel()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      mentionIndex = (mentionIndex - 1 + roles.length) % roles.length
      renderMentionPanel()
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      const role = roles[mentionIndex]
      if (role) insertMention(role)
    } else if (event.key === 'Escape') {
      mentionPanelEl.hidden = true
    }
  })

  requireElement<HTMLFormElement>('#add-role-form').addEventListener('submit', event => {
    event.preventDefault()
    const chat = getCurrentChat()
    if (!chat) return
    const roleTemplateId = roleTemplateSelectEl.value || undefined
    const name = newRoleNameEl.value.trim() || undefined
    newRoleNameEl.value = ''
    runCommand('GROUP_ROLE_CREATE', { chatId: chat.id, roleTemplateId, name }).catch(error => showError(error.message))
  })

  requireElement<HTMLFormElement>('#role-editor').addEventListener('submit', event => {
    event.preventDefault()
    const chat = getCurrentChat()
    const role = selectedRoleId ? store.rolesById[selectedRoleId] : undefined
    if (!chat || !role) return
    runCommand('GROUP_ROLE_UPDATE', { chatId: chat.id, roleId: role.id, patch: readRolePatch() }).catch(error => showError(error.message))
  })

  requireElement<HTMLButtonElement>('#recover-role').addEventListener('click', () => {
    const chat = getCurrentChat()
    const role = selectedRoleId ? store.rolesById[selectedRoleId] : undefined
    if (!chat || !role) return
    log.info('ui:recover-role', { chatId: chat.id, roleId: role.id, roleName: role.name, conversationUrl: role.geminiConversationUrl })
    iframeHost.recoverRole(role)
    runCommand('GROUP_ROLE_RECOVER', { chatId: chat.id, roleId: role.id }).catch(error => showError(error.message))
  })

  requireElement<HTMLButtonElement>('#initialize-role').addEventListener('click', () => {
    const chat = getCurrentChat()
    if (!chat || !selectedRoleId) return
    const role = store.rolesById[selectedRoleId]
    log.info('ui:reinitialize-role', { chatId: chat.id, roleId: selectedRoleId, roleName: role?.name, roleStatus: role?.status })
    runCommand('GROUP_ROLE_REINITIALIZE', { chatId: chat.id, roleId: selectedRoleId }).catch(error => showError(error.message))
  })

  requireElement<HTMLFormElement>('#template-form').addEventListener('submit', event => {
    event.preventDefault()
    const draft = readTemplateDraft()
    if (!draft.name) return
    const type = selectedTemplateId ? 'ROLE_TEMPLATE_UPDATE' : 'ROLE_TEMPLATE_CREATE'
    const payload = selectedTemplateId ? { templateId: selectedTemplateId, ...draft } : draft
    runCommand(type, payload).catch(error => showError(error.message))
  })

  requireElement<HTMLButtonElement>('#reset-template-form').addEventListener('click', resetTemplateForm)
  deleteTemplateEl.addEventListener('click', () => {
    if (!selectedTemplateId) return
    const templateId = selectedTemplateId
    resetTemplateForm()
    runCommand('ROLE_TEMPLATE_DELETE', { templateId }).catch(error => showError(error.message))
  })

  requireElement<HTMLButtonElement>('#open-gemini-login').addEventListener('click', () => {
    chrome.tabs.create({ url: GEMINI_URL }).catch(error => showError(error instanceof Error ? error.message : String(error)))
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
