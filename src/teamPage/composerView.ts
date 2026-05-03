import { parseGroupMentions } from '../group/mentionParser'
import type { GroupChat, GroupMessage, GroupRole, MessageReference } from '../group/types'
import type { TeamPageState } from './appState'
import { getVisibleThinkingRoles, isUnavailableRolesError, shouldAutoReconnectRole, shouldConfirmMentionWithEnter, shouldSendMessageWithEnter } from './chatExperience'

export interface ComposerViewDependencies {
  state: TeamPageState
  composerFormEl: HTMLFormElement
  targetPreviewEl: HTMLElement
  busyPreviewEl: HTMLElement
  sendButtonEl: HTMLButtonElement
  messageInputEl: HTMLTextAreaElement
  referenceDraftEl: HTMLElement
  mentionPanelEl: HTMLElement
  getCurrentChat(): GroupChat | undefined
  getCurrentRoles(): GroupRole[]
  roleToneClass(seed: string | undefined): string
  roleAvatarLabel(name: string | undefined): string
  reconnectRolesForSend(chat: GroupChat, roles: GroupRole[]): Promise<void>
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  showError(message: string): void
}

export interface ComposerView {
  renderComposerState(): void
  registerComposerEvents(): void
  insertMention(role: GroupRole): void
  setReference(message: GroupMessage): void
  submitComposerMessage(): Promise<void>
}

export function createComposerView(deps: ComposerViewDependencies): ComposerView {
  function renderComposerState(): void {
    renderReferenceDraft()
    renderMentionPanel()

    const chat = deps.getCurrentChat()
    const roles = deps.getCurrentRoles()
    const raw = deps.messageInputEl.value.trim()
    const parsed = parseGroupMentions(raw || 'x', roles)
    const targetRoleIds = raw && parsed.ok ? parsed.targetRoleIds : roles.map(role => role.id)
    const targets = roles.filter(role => targetRoleIds.includes(role.id))
    const unavailable = targets.filter(role => role.status !== 'ready')
    const reconnecting = targets.filter(role => deps.state.reconnectingRoleKeys.has(teamRoleKey(role.chatId, role.id)))
    const thinking = getVisibleThinkingRoles(roles)

    if (!chat) {
      deps.targetPreviewEl.textContent = '选择群聊后可发送'
      deps.sendButtonEl.disabled = true
    } else if (roles.length === 0) {
      deps.targetPreviewEl.textContent = '当前群聊还没有人员'
      deps.sendButtonEl.disabled = true
    } else if (!raw) {
      deps.targetPreviewEl.textContent = '输入消息后可发送；无 @ 默认全员'
      deps.sendButtonEl.disabled = true
    } else if (!parsed.ok) {
      deps.targetPreviewEl.textContent = parsed.error
      deps.sendButtonEl.disabled = true
    } else if (reconnecting.length > 0) {
      deps.targetPreviewEl.textContent = `正在自动连接：${reconnecting.map(role => role.name).join('、')}`
      deps.sendButtonEl.disabled = true
    } else if (unavailable.length > 0) {
      const waiting = unavailable.filter(role => !shouldAutoReconnectRole(role))
      if (waiting.length > 0) {
        deps.targetPreviewEl.textContent = `请稍等：${waiting.map(role => role.name).join('、')} 正在回复`
        deps.sendButtonEl.disabled = true
      } else {
        deps.targetPreviewEl.textContent = `将先自动连接：${unavailable.map(role => role.name).join('、')}`
        deps.sendButtonEl.disabled = false
      }
    } else {
      deps.targetPreviewEl.textContent = `将发送给：${targets.map(role => role.name).join('、') || '全部人员'}`
      deps.sendButtonEl.disabled = false
    }

    deps.busyPreviewEl.textContent = thinking.length > 0 ? `正在回复：${thinking.map(role => role.name).join('、')}` : ''
  }

  function renderReferenceDraft(): void {
    deps.referenceDraftEl.replaceChildren()
    if (!deps.state.selectedReference) {
      deps.referenceDraftEl.hidden = true
      return
    }

    deps.referenceDraftEl.hidden = false
    const preview = document.createElement('div')
    preview.className = 'reference-draft-preview'
    preview.textContent = `引用 ${deps.state.selectedReference.roleName || '人员'}：${deps.state.selectedReference.contentSnapshot}`

    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'btn btn-ghost'
    cancel.setAttribute('aria-label', '取消引用')
    cancel.textContent = '×'
    cancel.addEventListener('click', () => {
      deps.state.selectedReference = undefined
      renderComposerState()
    })
    deps.referenceDraftEl.append(preview, cancel)
  }

  function renderMentionPanel(): void {
    const roles = deps.getCurrentRoles()
    const show = shouldShowMentionPanel(deps.messageInputEl.value) && roles.length > 0
    deps.mentionPanelEl.hidden = !show
    deps.mentionPanelEl.replaceChildren()
    if (!show) return

    roles.forEach((role, index) => {
      const option = document.createElement('button')
      option.type = 'button'
      option.className = `mention-option${index === deps.state.mentionIndex ? ' active' : ''}`
      const avatar = document.createElement('span')
      avatar.className = `mention-avatar ${deps.roleToneClass(role.name)}`
      avatar.textContent = deps.roleAvatarLabel(role.name)
      const name = document.createElement('span')
      name.textContent = role.name
      option.addEventListener('click', () => insertMention(role))
      option.append(avatar, name)
      deps.mentionPanelEl.append(option)
    })
  }

  function registerComposerEvents(): void {
    deps.composerFormEl.addEventListener('submit', event => {
      event.preventDefault()
      if (deps.sendButtonEl.disabled && deps.state.reconnectingRoleKeys.size > 0) return
      submitComposerMessage().catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
    })

    deps.messageInputEl.addEventListener('input', () => {
      deps.state.mentionIndex = 0
      renderComposerState()
    })
    deps.messageInputEl.addEventListener('keyup', () => renderComposerState())
    deps.messageInputEl.addEventListener('keydown', event => {
      const roles = deps.getCurrentRoles()
      if (!deps.mentionPanelEl.hidden) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          deps.state.mentionIndex = (deps.state.mentionIndex + 1) % roles.length
          renderMentionPanel()
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          deps.state.mentionIndex = (deps.state.mentionIndex - 1 + roles.length) % roles.length
          renderMentionPanel()
        } else if (shouldConfirmMentionWithEnter(event)) {
          event.preventDefault()
          const role = roles[deps.state.mentionIndex]
          if (role) insertMention(role)
        } else if (event.key === 'Escape') {
          deps.mentionPanelEl.hidden = true
        }
        return
      }

      if (shouldSendMessageWithEnter(event)) {
        event.preventDefault()
        deps.composerFormEl.requestSubmit()
      }
    })
  }

  async function submitComposerMessage(): Promise<void> {
    const chat = deps.getCurrentChat()
    const raw = deps.messageInputEl.value.trim()
    if (!chat || !raw) return

    const targetResult = resolveMessageTargets(raw, deps.getCurrentRoles())
    if (!targetResult.ok) {
      deps.showError(targetResult.error)
      return
    }

    const waitingRoles = targetResult.roles.filter(role => role.status === 'thinking' && !shouldAutoReconnectRole(role))
    if (waitingRoles.length > 0) {
      deps.showError(`请等待人员回复完成：${waitingRoles.map(role => role.name).join('、')}`)
      return
    }

    const reference = deps.state.selectedReference
    const reconnectableRoles = targetResult.roles.filter(role => role.status !== 'ready' && shouldAutoReconnectRole(role))
    if (reconnectableRoles.length > 0) await deps.reconnectRolesForSend(chat, reconnectableRoles)

    await sendMessageAfterReconnect(chat, raw, reference, targetResult.roles)
    clearComposerAfterSend(raw, reference)
  }

  async function sendMessageAfterReconnect(chat: GroupChat, raw: string, reference: MessageReference | undefined, targetRoles: GroupRole[], retryOnUnavailable = true): Promise<void> {
    try {
      await deps.runCommand('GROUP_MESSAGE_SEND', { chatId: chat.id, raw, reference })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!retryOnUnavailable || !isUnavailableRolesError(message)) throw error
      const reconnectableRoles = targetRoles.filter(role => role.status === 'ready' || shouldAutoReconnectRole(role))
      if (reconnectableRoles.length === 0) throw error
      await deps.reconnectRolesForSend(chat, reconnectableRoles)
      await sendMessageAfterReconnect(chat, raw, reference, targetRoles, false)
    }
  }

  function clearComposerAfterSend(raw: string, reference: MessageReference | undefined): void {
    if (deps.messageInputEl.value.trim() === raw) deps.messageInputEl.value = ''
    if (deps.state.selectedReference === reference) deps.state.selectedReference = undefined
    renderComposerState()
  }

  function setReference(message: GroupMessage): void {
    deps.state.selectedReference = {
      messageId: message.id,
      roleId: message.roleId,
      roleName: message.roleName,
      contentSnapshot: message.content,
    }
    deps.messageInputEl.focus()
    renderComposerState()
  }

  function resolveMessageTargets(raw: string, roles: GroupRole[]): { ok: true; roles: GroupRole[] } | { ok: false; error: string } {
    const parsed = parseGroupMentions(raw, roles)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const targets = roles.filter(role => parsed.targetRoleIds.includes(role.id))
    if (targets.length === 0) return { ok: false, error: '当前群聊没有可投递人员' }
    return { ok: true, roles: targets }
  }

  function shouldShowMentionPanel(value: string): boolean {
    const cursor = deps.messageInputEl.selectionStart ?? value.length
    const beforeCursor = value.slice(0, cursor)
    const atIndex = beforeCursor.lastIndexOf('@')
    if (atIndex < 0) return false
    const mentionText = beforeCursor.slice(atIndex + 1)
    return !/\s/.test(mentionText)
  }

  function insertMention(role: GroupRole): void {
    const value = deps.messageInputEl.value
    const cursor = deps.messageInputEl.selectionStart ?? value.length
    const beforeCursor = value.slice(0, cursor)
    const atIndex = beforeCursor.lastIndexOf('@')
    const rawPrefix = atIndex >= 0 ? value.slice(0, atIndex) : value.slice(0, cursor)
    const prefix = rawPrefix && !/\s$/.test(rawPrefix) ? `${rawPrefix} ` : rawPrefix
    const suffix = value.slice(cursor)
    const inserted = `${prefix}@${role.name} ${suffix}`
    deps.messageInputEl.value = inserted
    const nextCursor = prefix.length + role.name.length + 2
    deps.messageInputEl.setSelectionRange(nextCursor, nextCursor)
    deps.messageInputEl.focus()
    deps.mentionPanelEl.hidden = true
    renderComposerState()
  }

  return { renderComposerState, registerComposerEvents, insertMention, setReference, submitComposerMessage }
}

function teamRoleKey(chatId: string, roleId: string): string {
  return `${chatId}:${roleId}`
}
