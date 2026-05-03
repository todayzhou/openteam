import { getDefaultChatSiteUrl } from '../group/conversationUrl'
import type { ChatSite, GroupChat, GroupRole, RoomMode } from '../group/types'
import type { TeamPageState } from './appState'
import { requireElement } from './domRefs'

interface TeamUiIframeHost {
  restoreChat(chat: GroupChat, roles: GroupRole[]): void
}

export interface TeamUiControllerDependencies {
  state: TeamPageState
  settingsButtonEl: HTMLButtonElement
  settingsMenuEl: HTMLElement
  quickCreateChatEl: HTMLButtonElement
  createChatFormEl: HTMLFormElement
  newChatNameEl: HTMLInputElement
  togglePeopleDrawerEl: HTMLButtonElement
  iframeHost: TeamUiIframeHost
  refreshCurrentChat(): Promise<void>
  getCurrentChat(): GroupChat | undefined
  getCurrentRoles(): GroupRole[]
  getSelectedLoginSite(): ChatSite
  render(): void
  renderChatList(): void
  renderRolePanel(): void
  renderAddPersonDialog(): void
  closePeopleModals(): void
  registerComposerEvents(): void
  registerPeopleLibraryEvents(): void
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  showError(message: string): void
  log: {
    debug(event: string, details?: Record<string, unknown>): void
    info(event: string, details?: Record<string, unknown>): void
  }
}

export interface TeamUiController {
  registerUi(): void
}

export function createTeamUiController(deps: TeamUiControllerDependencies): TeamUiController {
  function registerUi(): void {
    requireElement<HTMLButtonElement>('#refresh-store').addEventListener('click', () => {
      deps.refreshCurrentChat().catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
    })

    deps.quickCreateChatEl.addEventListener('click', () => {
      setChatCreatePopoverVisible(deps.createChatFormEl.hidden)
    })

    deps.settingsButtonEl.addEventListener('click', event => {
      event.stopPropagation()
      const visible = deps.settingsMenuEl.hidden
      deps.settingsMenuEl.hidden = !visible
      deps.settingsButtonEl.setAttribute('aria-expanded', String(visible))
      deps.log.debug('ui:settings-menu:open')
    })

    deps.registerPeopleLibraryEvents()

    deps.togglePeopleDrawerEl.addEventListener('click', () => {
      deps.state.peopleDrawerOpen = !deps.state.peopleDrawerOpen
      deps.render()
    })

    requireElement<HTMLButtonElement>('#close-people-drawer').addEventListener('click', () => {
      deps.state.peopleDrawerOpen = false
      deps.render()
    })

    document.addEventListener('click', event => {
      if (!deps.settingsMenuEl.hidden && !deps.settingsMenuEl.contains(event.target as Node) && event.target !== deps.settingsButtonEl) {
        deps.settingsMenuEl.hidden = true
        deps.settingsButtonEl.setAttribute('aria-expanded', 'false')
      }
      if (deps.state.chatMenuChatId && !(event.target as Element | null)?.closest('.chat-action-menu, .chat-menu-btn')) {
        deps.state.chatMenuChatId = undefined
        deps.renderChatList()
      }
      if (deps.state.roleSiteMenuRoleId && !(event.target as Element | null)?.closest('.role-site-menu, .site-pill, .role-more')) {
        deps.state.roleSiteMenuRoleId = undefined
        deps.renderRolePanel()
      }
      if (deps.state.addPersonSiteMenuId && !(event.target as Element | null)?.closest('.role-site-menu, .site-pill')) {
        deps.state.addPersonSiteMenuId = undefined
        deps.renderAddPersonDialog()
      }
    })

    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return
      deps.settingsMenuEl.hidden = true
      deps.settingsButtonEl.setAttribute('aria-expanded', 'false')
      deps.closePeopleModals()
      deps.state.chatMenuChatId = undefined
      deps.state.roleSiteMenuRoleId = undefined
      deps.renderChatList()
      deps.renderRolePanel()
    })

    requireElement<HTMLButtonElement>('#close-window').addEventListener('click', () => {
      window.close()
    })

    requireElement<HTMLButtonElement>('#cancel-create-chat').addEventListener('click', () => {
      setChatCreatePopoverVisible(false)
    })

    deps.createChatFormEl.addEventListener('submit', event => {
      event.preventDefault()
      const name = deps.newChatNameEl.value.trim() || '新群聊'
      const mode = readNewChatMode()
      deps.newChatNameEl.value = ''
      setChatCreatePopoverVisible(false)
      deps.runCommand('GROUP_CHAT_CREATE', { name, mode, roles: [] }).catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
    })

    requireElement<HTMLButtonElement>('#restore-chat').addEventListener('click', () => {
      const chat = deps.getCurrentChat()
      if (!chat) return
      const roles = deps.getCurrentRoles()
      deps.log.info('ui:restore-chat', { chatId: chat.id, roleIds: roles.map(role => role.id) })
      deps.iframeHost.restoreChat(chat, roles)
      Promise.all(roles.map(role => deps.runCommand('GROUP_ROLE_RECOVER', { chatId: chat.id, roleId: role.id }))).catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
    })

    deps.registerComposerEvents()

    requireElement<HTMLButtonElement>('#open-gemini-login').addEventListener('click', () => {
      chrome.tabs.create({ url: getDefaultChatSiteUrl(deps.getSelectedLoginSite()) }).catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
    })
  }

  function readNewChatMode(): RoomMode {
    const selected = document.querySelector<HTMLInputElement>('input[name="new-chat-mode"]:checked')
    return selected?.value === 'collaborative' ? 'collaborative' : 'independent'
  }

  function setChatCreatePopoverVisible(visible: boolean): void {
    deps.createChatFormEl.hidden = !visible
    deps.quickCreateChatEl.setAttribute('aria-expanded', String(visible))
    if (visible) deps.newChatNameEl.focus()
  }

  return { registerUi }
}
