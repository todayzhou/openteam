import type {
  BackgroundToHostMessage,
  BackgroundToRoleMessage,
  HostToBackgroundMessage,
  RoleToBackgroundMessage,
  TeamMessage,
  TeamRole,
  TeamRoomState,
} from '../team/types'
import { getGeminiConversationLocation } from './geminiConversation'
import { isClickableButton, readEditorText, setContentEditableText } from './geminiInput'
import { createReplyTracker } from './replyTracker'
import { createReplyTimeout } from './replyTimeout'
import { waitBeforePromptInput, PROMPT_INPUT_DELAY_MS } from './promptDelay'
import { keepDeepestResponseContainers } from './responseContainers'

interface SiteConfig {
  editor: string
  sendButton: string
  responseSelector: string
}

type ContentRuntimeMessage =
  | BackgroundToHostMessage
  | BackgroundToRoleMessage
  | { type: 'TEAM_STATE_UPDATED'; state: TeamRoomState }

interface AssignedRole {
  chatId: string
  roleId: string
  roleName?: string
  roomId?: string
}

const OPEN_TEAM_LOADED_KEY = '__OPENTEAM_LOADED__'
const PANEL_ID = '__openteam_team_panel__'
const FRAME_ASSIGN_MESSAGE = 'OPENTEAM_ASSIGN_FRAME_ROLE'
const RESPONSE_DEBOUNCE_MS = 2500
const RESPONSE_FINAL_SETTLE_MS = 1500
const INPUT_TIMEOUT_MS = 9000
const REPLY_TIMEOUT_MS = 120000
const log = {
  debug(event: string, details?: Record<string, unknown>): void {
    console.debug('[OpenTeam][content]', event, details || {})
  },
  info(event: string, details?: Record<string, unknown>): void {
    console.info('[OpenTeam][content]', event, details || {})
  },
  warn(event: string, details?: Record<string, unknown>): void {
    console.warn('[OpenTeam][content]', event, details || {})
  },
}

const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'BR',
  'LI',
  'TR',
  'PRE',
  'BLOCKQUOTE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
])

const SKIP_TAGS = new Set([
  'MAT-ICON',
  'SCRIPT',
  'STYLE',
  'BUTTON',
  'MS-THOUGHT-CHUNK',
  'MAT-EXPANSION-PANEL-HEADER',
])

let assignedRole: AssignedRole | null = null
let activeMessageId: string | undefined
let currentState: TeamRoomState | null = null
let lastReportedConversationKey = ''
let conversationMonitorStarted = false
let promptBaselineContainers = new Set<Element>()
let promptBaselineReplies = new Set<string>()
const replyTracker = createReplyTracker()
let panelApi: ReturnType<typeof createTeamPanel> | null = null
const replyTimeout = createReplyTimeout(REPLY_TIMEOUT_MS, messageId => {
  log.warn('reply-timeout', { messageId, roleId: assignedRole?.roleId, roleName: assignedRole?.roleName })
  if (activeMessageId === messageId) activeMessageId = undefined
  sendRuntimeMessage({
    type: 'TEAM_ROLE_STATUS',
    status: 'error',
    error: `等待 Gemini 回复超时（${Math.round(REPLY_TIMEOUT_MS / 1000)} 秒）`,
  }).catch(error => log.warn('reply-timeout:status-failed', { error: error instanceof Error ? error.message : String(error) }))
})

function getSiteConfig(): SiteConfig {
  return {
    editor: 'div.ql-editor[contenteditable="true"], rich-textarea div[contenteditable="true"]',
    sendButton: 'button.send-button[aria-label*="发送"], button.send-button[aria-label*="Send"], button[aria-label*="Send message"], button[aria-label*="发送消息"]',
    responseSelector: 'model-response, .model-response-text, message-content',
  }
}

function getConversationId(): string {
  return getConversationSnapshot().conversationId || '__default__'
}

function getConversationSnapshot() {
  return getGeminiConversationLocation(location.href)
}

function getAssignedChatId(role: AssignedRole): string {
  return role.chatId || role.roomId || ''
}

function isEmbeddedFrame(): boolean {
  try {
    return window.top !== window
  } catch {
    return true
  }
}

function isDirectEmbeddedFrame(): boolean {
  try {
    return window.top !== window && window.parent === window.top
  } catch {
    return false
  }
}

function querySelectorFirst(selectors: string): HTMLElement | null {
  for (const selector of selectors.split(',').map(item => item.trim())) {
    const element = document.querySelector(selector) as HTMLElement | null
    if (element) return element
  }

  return null
}

function describeElement(element: Element): Record<string, unknown> {
  const htmlElement = element as HTMLElement
  return {
    tagName: element.tagName,
    id: htmlElement.id || undefined,
    className: typeof htmlElement.className === 'string' ? htmlElement.className.slice(0, 120) : undefined,
    role: element.getAttribute('role') || undefined,
    ariaLabel: element.getAttribute('aria-label') || undefined,
    ariaDisabled: element.getAttribute('aria-disabled') || undefined,
    disabled: element instanceof HTMLButtonElement ? element.disabled : undefined,
    contentEditable: htmlElement.contentEditable || undefined,
  }
}

function collectPromptDiagnostics(config = getSiteConfig()): Record<string, unknown> {
  return {
    href: location.href,
    readyState: document.readyState,
    visibilityState: document.visibilityState,
    title: document.title,
    assignedRole,
    editorMatches: [...document.querySelectorAll(config.editor)].slice(0, 5).map(describeElement),
    sendButtonMatches: [...document.querySelectorAll(config.sendButton)].slice(0, 5).map(describeElement),
    visibleButtonSamples: [...document.querySelectorAll('button')].slice(0, 12).map(describeElement),
  }
}

function waitForElement(selectors: string, timeoutMs = INPUT_TIMEOUT_MS): Promise<HTMLElement> {
  const immediate = querySelectorFirst(selectors)
  if (immediate) {
    log.debug('wait-element:immediate', { selectors, tagName: immediate.tagName })
    return Promise.resolve(immediate)
  }

  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      const element = querySelectorFirst(selectors)
      if (element) {
        window.clearInterval(timer)
        log.debug('wait-element:found', { selectors, tagName: element.tagName, elapsedMs: Date.now() - startedAt })
        resolve(element)
        return
      }

      if (Date.now() - startedAt >= timeoutMs) {
        window.clearInterval(timer)
        log.warn('wait-element:timeout', { selectors, timeoutMs, diagnostics: collectPromptDiagnostics() })
        reject(new Error(`Element not found: ${selectors}`))
      }
    }, 250)
  })
}

function waitForClickableButton(selectors: string, timeoutMs = INPUT_TIMEOUT_MS): Promise<HTMLElement> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      const button = querySelectorFirst(selectors)
      if (button && isClickableButton(button)) {
        window.clearInterval(timer)
        log.debug('wait-button:clickable', {
          selectors,
          tagName: button.tagName,
          ariaDisabled: button.getAttribute('aria-disabled'),
          elapsedMs: Date.now() - startedAt,
        })
        resolve(button)
        return
      }

      if (Date.now() - startedAt >= timeoutMs) {
        window.clearInterval(timer)
        log.warn('wait-button:timeout', { selectors, timeoutMs, found: Boolean(button), diagnostics: collectPromptDiagnostics() })
        reject(new Error('Gemini 发送按钮暂不可用，请稍后重试'))
      }
    }, 250)
  })
}

function extractCleanText(node: Node): string {
  const buffer: string[] = []

  function visit(current: Node): void {
    if (current.nodeType === Node.TEXT_NODE) {
      buffer.push(current.textContent || '')
      return
    }

    if (current.nodeType !== Node.ELEMENT_NODE) return

    const element = current as Element
    if (element.getAttribute('aria-hidden') === 'true') return
    if (SKIP_TAGS.has(element.tagName)) return
    if (BLOCK_TAGS.has(element.tagName)) buffer.push('\n')

    for (const child of element.childNodes) {
      visit(child)
    }
  }

  visit(node)

  return buffer
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function findResponseContainer(element: Element | null): Element | null {
  while (element) {
    if (element.matches('message-content, model-response, .model-response-text')) {
      return element
    }

    element = element.parentElement
  }

  return null
}

function getAllAssistantReplies(): string[] {
  return [...document.querySelectorAll(getSiteConfig().responseSelector)]
    .map(container => extractCleanText(container))
    .filter(Boolean)
}

function isGeminiGenerating(): boolean {
  return [...document.querySelectorAll('button')].some(button => {
    const label = [button.getAttribute('aria-label'), button.getAttribute('title'), button.textContent]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return /stop|stopping|停止|中止/.test(label) && isClickableButton(button as HTMLElement)
  })
}

function capturePromptReplyBaseline(messageId: string | undefined): void {
  const containers = [...document.querySelectorAll(getSiteConfig().responseSelector)]
  const replies = containers.map(container => extractCleanText(container)).filter(Boolean)
  promptBaselineContainers = new Set(containers)
  promptBaselineReplies = new Set(replies.map(reply => reply.trim()).filter(Boolean))
  replyTracker.seed(getConversationId(), replies)
  log.debug('reply-baseline:captured', {
    messageId,
    conversationId: getConversationId(),
    containerCount: promptBaselineContainers.size,
    replyCount: promptBaselineReplies.size,
  })
}

function clearPromptReplyBaseline(): void {
  promptBaselineContainers.clear()
  promptBaselineReplies.clear()
}

function isPromptBaselineReply(text: string, element: Element): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  if (promptBaselineReplies.has(trimmed)) return true

  for (const container of promptBaselineContainers) {
    if (container === element || container.contains(element) || element.contains(container)) return true
  }

  return false
}

function observeResponseContainers(onStableText: (text: string, element: Element) => void): void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  const pendingContainers = new Set<Element>()

  function flush(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }

    const pendingCount = pendingContainers.size
    const containers = keepDeepestResponseContainers([...pendingContainers])
    const snapshots = containers
      .map(container => ({ container, text: extractCleanText(container) }))
      .filter(snapshot => Boolean(snapshot.text))
    log.debug('observer:flush', { pending: pendingCount, kept: containers.length, snapshots: snapshots.length })
    pendingContainers.clear()

    window.setTimeout(() => {
      const generating = isGeminiGenerating()
      for (const snapshot of snapshots) {
        if (!snapshot.container.isConnected) continue

        const text = extractCleanText(snapshot.container)
        if (!text) continue

        if (generating || text !== snapshot.text) {
          log.debug('observer:defer-unstable', {
            generating,
            previousLength: snapshot.text.length,
            currentLength: text.length,
          })
          schedule(snapshot.container)
          continue
        }

        log.debug('observer:stable', { textLength: text.length })
        onStableText(text, snapshot.container)
      }
    }, RESPONSE_FINAL_SETTLE_MS)
  }

  function schedule(container: Element): void {
    pendingContainers.add(container)

    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(flush, RESPONSE_DEBOUNCE_MS)
  }

  function inspectNode(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      const container = findResponseContainer((node as Text).parentElement)
      if (container) schedule(container)
      return
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return

    const element = node as Element
    const container = findResponseContainer(element)
    if (container) {
      schedule(container)
      return
    }

    element.querySelectorAll(getSiteConfig().responseSelector).forEach(schedule)
  }

  new MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        inspectNode(mutation.target)
        continue
      }

      mutation.addedNodes.forEach(inspectNode)
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true })

  requestAnimationFrame(() => {
    document.querySelectorAll(getSiteConfig().responseSelector).forEach(schedule)
  })
}

async function sendRuntimeMessage<T>(message: HostToBackgroundMessage | RoleToBackgroundMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    log.debug('runtime-send:start', { type: message.type })
    chrome.runtime.sendMessage(message, response => {
      const error = chrome.runtime.lastError
      if (error) {
        log.warn('runtime-send:failed', { type: message.type, error: error.message })
        reject(new Error(error.message))
        return
      }

      log.debug('runtime-send:response', { type: message.type, response })
      resolve(response as T)
    })
  })
}

async function fillAndSend(content: string, autoSend = true): Promise<void> {
  const config = getSiteConfig()
  log.info('fill-send:lookup-start', { contentLength: content.length, autoSend, diagnostics: collectPromptDiagnostics(config) })
  const editor = await waitForElement(config.editor)

  log.info('fill-send:start', { contentLength: content.length, autoSend, editor: describeElement(editor) })
  setContentEditableText(editor, content)
  if (readEditorText(editor) !== content.trim()) {
    log.warn('fill-send:editor-mismatch', { expectedLength: content.trim().length, actualLength: readEditorText(editor).length })
    throw new Error('Gemini editor did not accept the prompt text')
  }
  log.info('fill-send:editor-written', { contentLength: content.trim().length })

  if (!autoSend) return

  log.info('fill-send:button-lookup-start', { diagnostics: collectPromptDiagnostics(config) })
  const sendButton = await waitForClickableButton(config.sendButton)
  sendButton.click()
  log.info('fill-send:clicked', { button: describeElement(sendButton) })
}

function reportConversationUpdate(force = false): void {
  if (!assignedRole) return

  const chatId = getAssignedChatId(assignedRole)
  if (!chatId) return

  const snapshot = getConversationSnapshot()
  const key = `${chatId}:${assignedRole.roleId}:${snapshot.conversationId || ''}:${snapshot.conversationUrl || ''}`
  if (!force && key === lastReportedConversationKey) return
  lastReportedConversationKey = key

  sendRuntimeMessage({
    type: 'TEAM_ROLE_CONVERSATION_UPDATED',
    chatId,
    roleId: assignedRole.roleId,
    conversationId: snapshot.conversationId,
    conversationUrl: snapshot.conversationUrl,
  }).catch(error => log.warn('conversation-update:failed', { error: error instanceof Error ? error.message : String(error) }))
}

function reportRoleError(messageId: string | undefined, reason: string, chatId = assignedRole ? getAssignedChatId(assignedRole) : '', roleId = assignedRole?.roleId || ''): void {
  if (!chatId || !roleId) {
    log.warn('role-error:skipped-missing-identity', { messageId, reason, assignedRole })
    return
  }

  log.warn('role-error:report', { chatId, roleId, messageId, reason, diagnostics: collectPromptDiagnostics() })
  sendRuntimeMessage({
    type: 'TEAM_ROLE_ERROR',
    chatId,
    roleId,
    messageId,
    reason,
  }).catch(error => log.warn('role-error:failed', { error: error instanceof Error ? error.message : String(error) }))
}

function startConversationMonitoring(): void {
  if (conversationMonitorStarted) return
  conversationMonitorStarted = true

  const notify = () => window.setTimeout(() => reportConversationUpdate(), 0)
  const originalPushState = history.pushState
  const originalReplaceState = history.replaceState

  history.pushState = function pushState(...args) {
    const result = originalPushState.apply(this, args)
    notify()
    return result
  }

  history.replaceState = function replaceState(...args) {
    const result = originalReplaceState.apply(this, args)
    notify()
    return result
  }

  window.addEventListener('popstate', notify)
  window.addEventListener('hashchange', notify)
  notify()
}

function teamStatusLabel(role: TeamRole): string {
  if (role.status === 'opening') return '打开中'
  if (role.status === 'online') return '在线'
  if (role.status === 'sending') return '发送中'
  if (role.status === 'generating') return '生成中'
  if (role.status === 'idle') return '空闲'
  if (role.status === 'offline') return '离线'
  return '异常'
}

function messageTitle(message: TeamMessage): string {
  if (message.from === 'user') {
    if (message.target === 'all') return '你 → all'
    if (message.target === 'role') return `你 → ${message.targetRoleName || '角色'}`
    return '你'
  }

  if (message.from === 'role') return message.roleName || '角色'
  return '系统'
}

function createTeamPanel(initialState: TeamRoomState) {
  const host = document.createElement('div')
  host.id = PANEL_ID
  const shadow = host.attachShadow({ mode: 'open' })
  let expanded = true
  currentState = initialState

  shadow.innerHTML = `
    <style>
      :host {
        color-scheme: light;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .launcher {
        position: fixed;
        right: 22px;
        bottom: 22px;
        z-index: 2147483647;
        width: 52px;
        height: 52px;
        border: 0;
        border-radius: 50%;
        background: #101820;
        color: #f7f1df;
        box-shadow: 0 14px 34px rgba(16, 24, 32, 0.28);
        font-size: 20px;
        font-weight: 800;
        cursor: pointer;
      }

      .panel {
        position: fixed;
        right: 22px;
        bottom: 86px;
        z-index: 2147483647;
        width: min(390px, calc(100vw - 28px));
        height: min(620px, calc(100vh - 112px));
        display: grid;
        grid-template-rows: auto auto 1fr auto;
        overflow: hidden;
        border: 1px solid rgba(16, 24, 32, 0.12);
        border-radius: 8px;
        background: #fffdf6;
        box-shadow: 0 22px 70px rgba(16, 24, 32, 0.24);
      }

      .panel[hidden] {
        display: none;
      }

      .top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 14px 12px;
        border-bottom: 1px solid rgba(16, 24, 32, 0.1);
        background: #f7f1df;
      }

      .title {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }

      .title strong {
        color: #101820;
        font-size: 14px;
        line-height: 1.2;
      }

      .title span {
        color: #59646e;
        font-size: 12px;
        line-height: 1.2;
      }

      .icon-button,
      .add,
      .send {
        border: 1px solid rgba(16, 24, 32, 0.14);
        border-radius: 8px;
        background: #ffffff;
        color: #101820;
        cursor: pointer;
        font: inherit;
      }

      .icon-button {
        width: 30px;
        height: 30px;
        line-height: 28px;
      }

      .roles {
        display: flex;
        gap: 8px;
        overflow-x: auto;
        padding: 10px 12px;
        border-bottom: 1px solid rgba(16, 24, 32, 0.08);
      }

      .role {
        display: grid;
        grid-template-columns: auto auto;
        align-items: center;
        gap: 3px 8px;
        min-width: 118px;
        padding: 8px;
        border: 1px solid rgba(16, 24, 32, 0.1);
        border-radius: 8px;
        background: #ffffff;
      }

      .role-name {
        overflow: hidden;
        color: #101820;
        font-size: 13px;
        font-weight: 700;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .role-status {
        color: #64707a;
        font-size: 11px;
      }

      .role-remove {
        grid-row: span 2;
        width: 24px;
        height: 24px;
        border: 0;
        border-radius: 6px;
        background: #f1e7d0;
        color: #6e1f18;
        cursor: pointer;
      }

      .add {
        min-width: 86px;
        padding: 0 12px;
        background: #101820;
        color: #f7f1df;
        font-size: 12px;
        font-weight: 700;
      }

      .messages {
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow-y: auto;
        padding: 14px 12px;
        background: linear-gradient(180deg, #fffdf6, #f9fbff);
      }

      .empty {
        margin: auto;
        color: #73808b;
        font-size: 13px;
      }

      .message {
        max-width: 88%;
        padding: 9px 10px;
        border: 1px solid rgba(16, 24, 32, 0.1);
        border-radius: 8px;
        background: #ffffff;
        color: #17222b;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .message.user {
        align-self: flex-end;
        background: #e8f2ff;
      }

      .message.system {
        align-self: center;
        background: #fff0ec;
        color: #7a261f;
      }

      .message-title {
        margin-bottom: 4px;
        color: #53606a;
        font-size: 11px;
        font-weight: 800;
      }

      .composer {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
        padding: 12px;
        border-top: 1px solid rgba(16, 24, 32, 0.1);
        background: #ffffff;
      }

      textarea {
        min-height: 44px;
        max-height: 110px;
        resize: vertical;
        border: 1px solid rgba(16, 24, 32, 0.16);
        border-radius: 8px;
        padding: 9px 10px;
        color: #101820;
        font: inherit;
        font-size: 13px;
        outline: none;
      }

      textarea:focus {
        border-color: #2f6fed;
        box-shadow: 0 0 0 3px rgba(47, 111, 237, 0.12);
      }

      .send {
        width: 58px;
        background: #2f6fed;
        color: #ffffff;
        font-size: 13px;
        font-weight: 800;
      }
    </style>
    <button class="launcher" title="OpenTeam">OT</button>
    <section class="panel">
      <div class="top">
        <div class="title">
          <strong>OpenTeam</strong>
          <span class="summary"></span>
        </div>
        <button class="icon-button collapse" title="收起">×</button>
      </div>
      <div class="roles"></div>
      <div class="messages"></div>
      <form class="composer">
        <textarea placeholder="@A 分析这个方案"></textarea>
        <button class="send" type="submit">发送</button>
      </form>
    </section>
  `

  document.documentElement.append(host)

  const launcher = shadow.querySelector<HTMLButtonElement>('.launcher')
  const panel = shadow.querySelector<HTMLElement>('.panel')
  const collapse = shadow.querySelector<HTMLButtonElement>('.collapse')
  const rolesEl = shadow.querySelector<HTMLElement>('.roles')
  const messagesEl = shadow.querySelector<HTMLElement>('.messages')
  const summaryEl = shadow.querySelector<HTMLElement>('.summary')
  const form = shadow.querySelector<HTMLFormElement>('.composer')
  const textarea = shadow.querySelector<HTMLTextAreaElement>('textarea')

  function setExpanded(next: boolean): void {
    expanded = next
    if (panel) panel.hidden = !expanded
  }

  function renderRoles(state: TeamRoomState): void {
    if (!rolesEl) return

    rolesEl.replaceChildren()
    const add = document.createElement('button')
    add.className = 'add'
    add.type = 'button'
    add.textContent = '+ 角色'
    add.addEventListener('click', () => {
      const name = window.prompt('角色名')
      if (!name?.trim()) return
      sendRuntimeMessage({ type: 'TEAM_CREATE_ROLE', name }).catch(error => console.warn('[OpenTeam] create role failed', error))
    })
    rolesEl.append(add)

    for (const role of state.roles) {
      const item = document.createElement('div')
      item.className = 'role'
      item.innerHTML = `
        <div class="role-name"></div>
        <button class="role-remove" title="移除">×</button>
        <div class="role-status"></div>
      `
      item.querySelector('.role-name')!.textContent = role.name
      item.querySelector('.role-status')!.textContent = role.lastError || teamStatusLabel(role)
      item.querySelector<HTMLButtonElement>('.role-remove')!.addEventListener('click', () => {
        sendRuntimeMessage({ type: 'TEAM_REMOVE_ROLE', roleId: role.id }).catch(error => console.warn('[OpenTeam] remove role failed', error))
      })
      rolesEl.append(item)
    }
  }

  function renderMessages(state: TeamRoomState): void {
    if (!messagesEl) return

    messagesEl.replaceChildren()
    if (state.messages.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = '还没有消息'
      messagesEl.append(empty)
      return
    }

    for (const message of state.messages) {
      const item = document.createElement('div')
      item.className = `message ${message.from}`
      const title = document.createElement('div')
      title.className = 'message-title'
      title.textContent = messageTitle(message)
      const content = document.createElement('div')
      content.textContent = message.content
      item.append(title, content)
      messagesEl.append(item)
    }
    messagesEl.scrollTop = messagesEl.scrollHeight
  }

  function render(state: TeamRoomState): void {
    currentState = state
    if (summaryEl) summaryEl.textContent = `${state.roles.length} 个角色 · ${state.messages.length} 条消息`
    renderRoles(state)
    renderMessages(state)
  }

  launcher?.addEventListener('click', () => setExpanded(!expanded))
  collapse?.addEventListener('click', () => setExpanded(false))
  form?.addEventListener('submit', event => {
    event.preventDefault()
    const raw = textarea?.value.trim() || ''
    if (!raw) return

    if (textarea) textarea.value = ''
    sendRuntimeMessage({ type: 'TEAM_SEND_MESSAGE', raw }).catch(error => console.warn('[OpenTeam] send message failed', error))
  })

  render(initialState)

  return { render }
}

function ensureHostPanel(state: TeamRoomState): void {
  const existing = document.getElementById(PANEL_ID)
  if (existing && panelApi) {
    panelApi.render(state)
    return
  }

  if (existing) existing.remove()
  panelApi = createTeamPanel(state)
}

function assignRole(role: AssignedRole): void {
  assignedRole = role
  activeMessageId = undefined
  clearPromptReplyBaseline()
  replyTimeout.clear()
  replyTracker.seed(getConversationId(), getAllAssistantReplies())
  reportConversationUpdate(true)
  log.info('role-assigned', {
    chatId: getAssignedChatId(role),
    roleId: role.roleId,
    roleName: role.roleName,
    roomId: role.roomId,
    conversationId: getConversationId(),
  })
}

function registerMessageHandlers(): void {
  chrome.runtime.onMessage.addListener((message: ContentRuntimeMessage, _sender, sendResponse) => {
    if (message?.type === 'TEAM_ASSIGN_ROLE') {
      log.info('message:assign-role', { chatId: message.chatId, roleId: message.roleId, roleName: message.roleName, roomId: message.roomId })
      assignRole({
        chatId: message.chatId || message.roomId,
        roleId: message.roleId,
        roleName: message.roleName,
        roomId: message.roomId,
      })
      sendResponse({ ok: true })
      return false
    }

    if (message?.type === 'TEAM_STATE_UPDATED') {
      log.debug('message:state-updated', { roles: message.state.roles.length, messages: message.state.messages.length })
      currentState = message.state
      ensureHostPanel(message.state)
      sendResponse({ ok: true })
      return false
    }

    if (message?.type === 'TEAM_ERROR') {
      log.warn('message:team-error', { message: message.message })
      sendResponse({ ok: true })
      return false
    }

    if (message?.type !== 'TEAM_SEND_PROMPT') return false

    const promptChatId = message.chatId || assignedRole?.chatId || assignedRole?.roomId || ''
    const promptRoleId = message.roleId || assignedRole?.roleId || ''
    log.info('message:send-prompt', {
      chatId: promptChatId,
      roleId: promptRoleId,
      messageId: message.messageId,
      contentLength: message.content.length,
      autoSend: message.autoSend,
    })
    capturePromptReplyBaseline(message.messageId)
    activeMessageId = message.messageId
    replyTimeout.clear()
    sendRuntimeMessage({ type: 'TEAM_ROLE_STATUS', status: 'sending' })
      .then(() => {
        log.info('message:send-prompt:delay-before-input', { messageId: message.messageId, delayMs: PROMPT_INPUT_DELAY_MS })
        return waitBeforePromptInput()
      })
      .then(() => fillAndSend(message.content, message.autoSend !== false))
      .then(() => {
        reportConversationUpdate()
        if (promptChatId && promptRoleId) {
          sendRuntimeMessage({ type: 'TEAM_SEND_ACK', chatId: promptChatId, roleId: promptRoleId, messageId: message.messageId }).catch(error =>
            log.warn('message:send-prompt:ack-failed', { messageId: message.messageId, error: error instanceof Error ? error.message : String(error) }),
          )
        }
      })
      .then(() => sendRuntimeMessage({ type: 'TEAM_ROLE_STATUS', status: 'generating' }))
      .then(() => {
        if (message.messageId) replyTimeout.arm(message.messageId)
        log.info('message:send-prompt:ok', { messageId: message.messageId })
        sendResponse({ ok: true, messageId: message.messageId })
      })
      .catch(error => {
        const reason = error instanceof Error ? error.message : String(error)
        log.warn('message:send-prompt:failed', { messageId: message.messageId, error: reason, diagnostics: collectPromptDiagnostics() })
        activeMessageId = undefined
        clearPromptReplyBaseline()
        replyTimeout.clear()
        reportRoleError(message.messageId, reason, promptChatId, promptRoleId)
        sendRuntimeMessage({ type: 'TEAM_ROLE_STATUS', status: 'error', error: reason }).catch(() => undefined)
        sendResponse({ ok: false, messageId: message.messageId, error: reason })
      })

    return true
  })
}

function startReplyReporting(): void {
  observeResponseContainers((text, element) => {
    if (!assignedRole) return

    const messageId = activeMessageId
    if (messageId && isPromptBaselineReply(text, element)) {
      log.debug('reply:skipped-baseline', { messageId, textLength: text.length, roleId: assignedRole.roleId })
      return
    }

    if (!replyTracker.consumeIfNewForMessage(getConversationId(), text, messageId)) {
      log.debug('reply:skipped', { messageId, textLength: text.length, roleId: assignedRole.roleId })
      return
    }
    activeMessageId = undefined
    clearPromptReplyBaseline()
    replyTimeout.clear()
    log.info('reply:accepted', { messageId, textLength: text.length, roleId: assignedRole.roleId, roleName: assignedRole.roleName })

    const snapshot = getConversationSnapshot()
    sendRuntimeMessage({
      type: 'TEAM_ROLE_REPLY',
      chatId: getAssignedChatId(assignedRole),
      roleId: assignedRole.roleId,
      messageId,
      content: text,
      conversationId: snapshot.conversationId,
      conversationUrl: snapshot.conversationUrl,
    })
      .then(() => sendRuntimeMessage({ type: 'TEAM_ROLE_STATUS', status: 'idle' }))
      .catch(error => log.warn('reply:report-failed', { error: error instanceof Error ? error.message : String(error) }))
  })
}

async function identifyPage(): Promise<void> {
  const response = await sendRuntimeMessage<{
    ok: boolean
    mode?: 'host' | 'role'
    state?: TeamRoomState
    role?: TeamRole
    error?: string
  }>({
    type: 'TEAM_CONTENT_READY',
    conversationId: getConversationId(),
  })

  if (!response.ok) {
    log.warn('identify:failed', { error: response.error })
    return
  }

  if (response.mode === 'role' && response.role) {
    log.info('identify:role', { roleId: response.role.id, roleName: response.role.name, tabId: response.role.tabId })
    assignRole({
      chatId: currentState?.roomId || '',
      roleId: response.role.id,
      roleName: response.role.name,
      roomId: currentState?.roomId || '',
    })
    return
  }

  if (response.mode === 'host' && response.state) {
    log.info('identify:host', { roles: response.state.roles.length, messages: response.state.messages.length })
    ensureHostPanel(response.state)
    sendRuntimeMessage({ type: 'TEAM_HOST_READY' }).catch(error =>
      log.warn('host-ready:failed', { error: error instanceof Error ? error.message : String(error) }),
    )
  }
}

function registerFrameRoleHandshake(): void {
  window.addEventListener('message', event => {
    if (!event.data || typeof event.data !== 'object') return
    if (event.data.type !== FRAME_ASSIGN_MESSAGE) return

    const chatId = typeof event.data.chatId === 'string' ? event.data.chatId : typeof event.data.roomId === 'string' ? event.data.roomId : ''
    const roleId = typeof event.data.roleId === 'string' ? event.data.roleId : ''
    const hostTabId = typeof event.data.hostTabId === 'number' ? event.data.hostTabId : undefined
    if (!roleId) return

    const snapshot = getConversationSnapshot()
    log.info('frame-role:assignment-received', { chatId, roleId, hostTabId, conversationId: snapshot.conversationId })
    sendRuntimeMessage<{
      ok: boolean
      role?: TeamRole
      state?: TeamRoomState
      error?: string
    }>({
      type: 'TEAM_FRAME_ROLE_READY',
      chatId,
      roleId,
      hostTabId,
      conversationId: snapshot.conversationId || getConversationId(),
      conversationUrl: snapshot.conversationUrl,
    })
      .then(response => {
        if (!response.ok || !response.role) {
          log.warn('frame-role:ready-failed', { roleId, error: response.error })
          return
        }

        assignRole({
          chatId,
          roleId: response.role.id,
          roleName: response.role.name,
          roomId: response.state?.roomId || currentState?.roomId || chatId,
        })
      })
      .catch(error => log.warn('frame-role:ready-error', { roleId, error: error instanceof Error ? error.message : String(error) }))
  })
}

function startOpenTeam(): void {
  const embedded = isEmbeddedFrame()
  const directEmbedded = isDirectEmbeddedFrame()
  log.info('boot', { href: location.href, conversationId: getConversationId(), embedded, directEmbedded })
  registerMessageHandlers()

  if (embedded) {
    if (directEmbedded) {
      startConversationMonitoring()
      startReplyReporting()
      registerFrameRoleHandshake()
    }
    return
  }

  startConversationMonitoring()
  startReplyReporting()
  identifyPage().catch(error => log.warn('boot:failed', { error: error instanceof Error ? error.message : String(error) }))
}

function bootWhenReady(): void {
  if (document.body) {
    startOpenTeam()
    return
  }

  document.addEventListener('DOMContentLoaded', startOpenTeam, { once: true })
}

if (!(window as unknown as Record<string, boolean>)[OPEN_TEAM_LOADED_KEY]) {
  ;(window as unknown as Record<string, boolean>)[OPEN_TEAM_LOADED_KEY] = true
  bootWhenReady()
}
