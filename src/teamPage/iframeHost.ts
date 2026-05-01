import { getSafeGeminiIframeSrc } from '../group/conversationUrl'
import type { GroupChat, GroupRole } from '../group/types'

export const FRAME_ASSIGN_MESSAGE = 'OPENTEAM_ASSIGN_FRAME_ROLE'
export const GEMINI_IFRAME_ALLOW = 'clipboard-read; clipboard-write; microphone; camera; geolocation; autoplay; fullscreen; picture-in-picture; storage-access; web-share'

export type IframeHostChat = Pick<GroupChat, 'id' | 'roleIds'>
export type IframeHostRole = Pick<GroupRole, 'id' | 'chatId' | 'name' | 'geminiConversationUrl'>

export interface FrameAssignmentMessage {
  type: typeof FRAME_ASSIGN_MESSAGE
  chatId: string
  roleId: string
  hostTabId?: number
}

export type RoleFrameStatus = 'loading' | 'assigned'

export interface RoleFrameState {
  chatId: string
  roleId: string
  src: string
  active: boolean
  status: RoleFrameStatus
  assignmentAttempts: number
  lastAssignedAt?: number
}

export type IframeHostEvent =
  | { type: 'chat-activated'; chatId: string }
  | { type: 'chat-hidden'; chatId: string }
  | { type: 'role-created'; chatId: string; roleId: string; iframe: HTMLIFrameElement }
  | { type: 'role-recovered'; chatId: string; roleId: string; iframe: HTMLIFrameElement }
  | { type: 'role-assigned'; chatId: string; roleId: string; attempts: number }
  | { type: 'role-ready'; chatId: string; roleId: string }
  | { type: 'role-disposed'; chatId: string; roleId: string }
  | { type: 'disposed' }

export interface IframeHostOptions {
  visibleHost: HTMLElement
  hiddenHost?: HTMLElement
  document?: Document
  window?: Window
  assignIntervalMs?: number
  hostTabId?: number
  onEvent?: (event: IframeHostEvent) => void
}

interface RoleFrameRecord {
  chatId: string
  roleId: string
  iframe: HTMLIFrameElement
  src: string
  status: RoleFrameStatus
  assignmentAttempts: number
  assignTimer?: number
  lastAssignedAt?: number
}

const DEFAULT_ASSIGN_INTERVAL_MS = 1000

export class IframeHost {
  private readonly visibleHost: HTMLElement
  private readonly hiddenHost: HTMLElement
  private readonly document: Document
  private readonly window: Window
  private readonly assignIntervalMs: number
  private readonly onEvent?: (event: IframeHostEvent) => void
  private readonly framesByRoleKey = new Map<string, RoleFrameRecord>()
  private activeChatId?: string
  private hostTabId?: number
  private disposed = false

  constructor(options: IframeHostOptions) {
    this.visibleHost = options.visibleHost
    this.document = options.document ?? options.visibleHost.ownerDocument
    this.window = options.window ?? this.document.defaultView ?? window
    this.assignIntervalMs = options.assignIntervalMs ?? DEFAULT_ASSIGN_INTERVAL_MS
    this.hostTabId = options.hostTabId
    this.onEvent = options.onEvent
    this.hiddenHost = options.hiddenHost ?? this.createHiddenHost()
  }

  setHostTabId(hostTabId: number | undefined): void {
    this.hostTabId = hostTabId
  }

  getActiveChatId(): string | undefined {
    return this.activeChatId
  }

  isChatActive(chatId: string): boolean {
    return this.activeChatId === chatId
  }

  isChatActivated(chatId: string): boolean {
    for (const record of this.framesByRoleKey.values()) {
      if (record.chatId === chatId) return true
    }
    return false
  }

  hasRoleFrame(chatId: string, roleId: string): boolean {
    return this.framesByRoleKey.has(roleKey(chatId, roleId))
  }

  getRoleFrame(chatId: string, roleId: string): HTMLIFrameElement | undefined {
    return this.framesByRoleKey.get(roleKey(chatId, roleId))?.iframe
  }

  getChatState(chatId: string): RoleFrameState[] {
    return [...this.framesByRoleKey.values()]
      .filter(record => record.chatId === chatId)
      .map(record => this.toState(record))
  }

  activateChat(chat: IframeHostChat, roles: IframeHostRole[]): RoleFrameState[] {
    this.assertNotDisposed()
    if (this.activeChatId && this.activeChatId !== chat.id) this.hideActiveChat()
    this.activeChatId = chat.id

    const chatRoleIds = new Set(chat.roleIds)
    for (const role of roles) {
      if (role.chatId === chat.id && chatRoleIds.has(role.id)) {
        this.ensureRoleFrame(role)
      }
    }

    this.mountChat(chat.id, this.visibleHost)
    this.emit({ type: 'chat-activated', chatId: chat.id })
    return this.getChatState(chat.id)
  }

  restoreChat(chat: IframeHostChat, roles: IframeHostRole[]): RoleFrameState[] {
    this.assertNotDisposed()
    const chatRoleIds = new Set(chat.roleIds)
    for (const role of roles) {
      if (role.chatId === chat.id && chatRoleIds.has(role.id)) {
        this.ensureRoleFrame(role)
      }
    }

    this.mountChat(chat.id, this.isChatActive(chat.id) ? this.visibleHost : this.hiddenHost)
    return this.getChatState(chat.id)
  }

  recoverRole(role: IframeHostRole): RoleFrameState {
    this.assertNotDisposed()
    const key = roleKey(role.chatId, role.id)
    const existing = this.framesByRoleKey.get(key)
    if (existing) {
      this.stopAssignLoop(existing)
      existing.iframe.remove()
      this.framesByRoleKey.delete(key)
    }

    const record = this.createRoleFrame(role)
    this.mountRole(record, this.isChatActive(role.chatId) ? this.visibleHost : this.hiddenHost)
    this.emit({ type: 'role-recovered', chatId: role.chatId, roleId: role.id, iframe: record.iframe })
    return this.toState(record)
  }

  markRoleReady(chatId: string, roleId: string): void {
    const record = this.framesByRoleKey.get(roleKey(chatId, roleId))
    if (!record) return

    record.status = 'assigned'
    this.stopAssignLoop(record)
    this.emit({ type: 'role-ready', chatId, roleId })
  }

  hideActiveChat(): void {
    if (!this.activeChatId) return

    const chatId = this.activeChatId
    this.mountChat(chatId, this.hiddenHost)
    this.activeChatId = undefined
    this.emit({ type: 'chat-hidden', chatId })
  }

  dispose(): void {
    if (this.disposed) return

    for (const record of this.framesByRoleKey.values()) {
      this.stopAssignLoop(record)
      record.iframe.remove()
      this.emit({ type: 'role-disposed', chatId: record.chatId, roleId: record.roleId })
    }
    this.framesByRoleKey.clear()
    this.hiddenHost.remove()
    this.activeChatId = undefined
    this.disposed = true
    this.emit({ type: 'disposed' })
  }

  private ensureRoleFrame(role: IframeHostRole): RoleFrameRecord {
    const key = roleKey(role.chatId, role.id)
    const existing = this.framesByRoleKey.get(key)
    if (existing) return existing
    return this.createRoleFrame(role)
  }

  private createRoleFrame(role: IframeHostRole): RoleFrameRecord {
    const iframe = this.document.createElement('iframe')
    const src = getSafeGeminiIframeSrc(role.geminiConversationUrl)
    iframe.className = 'role-frame'
    iframe.title = `${role.name} Gemini`
    iframe.src = src
    iframe.allow = GEMINI_IFRAME_ALLOW
    iframe.dataset.chatId = role.chatId
    iframe.dataset.roleId = role.id
    iframe.setAttribute('user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36')
    iframe.setAttribute('accept-language', 'zh-CN,zh;q=0.9,en;q=0.8')
    iframe.setAttribute('sec-ch-ua', '"Chromium";v="122", "Google Chrome";v="122"')
    iframe.setAttribute('sec-ch-ua-mobile', '?0')
    iframe.setAttribute('sec-ch-ua-platform', '"Macintosh"')

    const record: RoleFrameRecord = {
      chatId: role.chatId,
      roleId: role.id,
      iframe,
      src,
      status: 'loading',
      assignmentAttempts: 0,
    }

    iframe.addEventListener('load', () => this.startAssignLoop(record))
    this.framesByRoleKey.set(roleKey(role.chatId, role.id), record)
    this.startAssignLoop(record)
    this.emit({ type: 'role-created', chatId: role.chatId, roleId: role.id, iframe })
    return record
  }

  private mountChat(chatId: string, host: HTMLElement): void {
    for (const record of this.framesByRoleKey.values()) {
      if (record.chatId === chatId) this.mountRole(record, host)
    }
  }

  private mountRole(record: RoleFrameRecord, host: HTMLElement): void {
    if (record.iframe.parentElement !== host) host.append(record.iframe)
  }

  private startAssignLoop(record: RoleFrameRecord): void {
    if (record.status === 'assigned') return

    this.stopAssignLoop(record)
    this.assignRole(record)
    record.assignTimer = this.window.setInterval(() => this.assignRole(record), this.assignIntervalMs)
  }

  private stopAssignLoop(record: RoleFrameRecord): void {
    if (record.assignTimer === undefined) return

    this.window.clearInterval(record.assignTimer)
    record.assignTimer = undefined
  }

  private assignRole(record: RoleFrameRecord): void {
    record.assignmentAttempts += 1
    record.lastAssignedAt = Date.now()
    record.iframe.contentWindow?.postMessage({
      type: FRAME_ASSIGN_MESSAGE,
      chatId: record.chatId,
      roleId: record.roleId,
      hostTabId: this.hostTabId,
    } satisfies FrameAssignmentMessage, 'https://gemini.google.com')
    this.emit({ type: 'role-assigned', chatId: record.chatId, roleId: record.roleId, attempts: record.assignmentAttempts })
  }

  private createHiddenHost(): HTMLElement {
    const host = this.document.createElement('div')
    host.className = 'iframe-host'
    host.dataset.openteamIframeHiddenHost = 'true'
    host.setAttribute('aria-hidden', 'true')
    host.style.position = 'fixed'
    host.style.left = '-10000px'
    host.style.top = '0'
    host.style.width = '420px'
    host.style.height = '720px'
    host.style.overflow = 'hidden'
    host.style.opacity = '0'
    host.style.pointerEvents = 'none'
    host.style.zIndex = '-1'
    this.visibleHost.after(host)
    return host
  }

  private toState(record: RoleFrameRecord): RoleFrameState {
    return {
      chatId: record.chatId,
      roleId: record.roleId,
      src: record.src,
      active: this.isChatActive(record.chatId),
      status: record.status,
      assignmentAttempts: record.assignmentAttempts,
      lastAssignedAt: record.lastAssignedAt,
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('IframeHost has been disposed')
  }

  private emit(event: IframeHostEvent): void {
    this.onEvent?.(event)
  }
}

export function createIframeHost(options: IframeHostOptions): IframeHost {
  return new IframeHost(options)
}

function roleKey(chatId: string, roleId: string): string {
  return `${chatId}:${roleId}`
}
