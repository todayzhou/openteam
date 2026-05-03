import type { GroupChat, OpenTeamStore, RoleTemplate } from '../group/types'
import type { TeamPageState } from './appState'
import { formatChatListTime } from './chatExperience'

export interface ChatListViewDependencies {
  state: TeamPageState
  getStore(): OpenTeamStore
  storeSummaryEl: HTMLElement
  chatListEl: HTMLElement
  getTemplates(): RoleTemplate[]
  getChatRecentSummary(chat: GroupChat): string
  roleToneClass(value: string): string
  roleAvatarLabel(value: string): string
  emptyCard(title: string, body: string): HTMLElement
  renderSelectedChat(): void
  renderRolePanel(): void
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  clearChatMessages(chatId: string): Promise<void>
  closeChatFrames(chatId: string): Promise<void>
  deleteChat(chatId: string): Promise<void>
  showError(message: string): void
}

export interface ChatListView {
  renderChatList(): void
  switchChat(chatId: string): void
}

export function createChatListView(deps: ChatListViewDependencies): ChatListView {
  function renderChatList() {
    const store = deps.getStore()
    const chats = store.chatOrder.map(chatId => store.chatsById[chatId]).filter((chat): chat is GroupChat => Boolean(chat))
    deps.storeSummaryEl.textContent = `${chats.length} 个群聊 · ${deps.getTemplates().length} 个人员库人员`
    deps.chatListEl.replaceChildren()

    if (chats.length === 0) {
      deps.chatListEl.append(deps.emptyCard('还没有群聊', '在上方创建一个群聊，然后从人员库添加人员。'))
      return
    }

    for (const chat of chats) {
      const item = document.createElement('section')
      const hasActivity = chat.id !== deps.state.selectedChatId && Boolean(store.viewState?.chatHasNewMessageById?.[chat.id])
      item.className = `chat-item${chat.id === deps.state.selectedChatId ? ' active' : ''}${hasActivity ? ' has-activity' : ''}`
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
      avatar.className = `chat-avatar ${deps.roleToneClass(chat.name)}`
      avatar.textContent = deps.roleAvatarLabel(chat.name)

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
        deps.state.chatMenuChatId = deps.state.chatMenuChatId === chat.id ? undefined : chat.id
        renderChatList()
      })
      row.append(name)

      const summary = document.createElement('div')
      summary.className = 'summary-line'
      summary.textContent = deps.getChatRecentSummary(chat)

      body.append(row, summary)

      const side = document.createElement('div')
      side.className = 'chat-item-side'
      const time = document.createElement('span')
      time.className = 'chat-time'
      time.textContent = formatChatListTime(chat.updatedAt)
      side.append(time, menuButton)

      item.append(avatar, body, side)
      if (deps.state.chatMenuChatId === chat.id) item.append(chatActionMenu(chat))
      deps.chatListEl.append(item)
    }
  }

  function switchChat(chatId: string) {
    if (chatId === deps.state.selectedChatId) {
      deps.state.chatMenuChatId = undefined
      deps.state.roleSiteMenuRoleId = undefined
      renderChatList()
      deps.renderRolePanel()
      return
    }
    deps.state.selectedChatId = chatId
    deps.state.selectedRoleId = undefined
    deps.state.selectedReference = undefined
    deps.state.peopleDrawerOpen = false
    deps.state.chatMenuChatId = undefined
    deps.state.roleSiteMenuRoleId = undefined
    deps.renderSelectedChat()
    if (deps.state.pendingSwitchAnimationFrame !== undefined) window.cancelAnimationFrame(deps.state.pendingSwitchAnimationFrame)
    deps.state.pendingSwitchAnimationFrame = window.requestAnimationFrame(() => {
      deps.state.pendingSwitchAnimationFrame = undefined
      if (deps.state.selectedChatId !== chatId) return
      deps.runCommand('GROUP_CHAT_SWITCH', { chatId })
        .catch(error => deps.showError(error.message))
    })
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
      deps.state.chatMenuChatId = undefined
      if (!nextName) {
        renderChatList()
        return
      }
      deps.runCommand('GROUP_CHAT_UPDATE', { chatId: chat.id, patch: { name: nextName } }).catch(error => deps.showError(error.message))
    })
    const duplicate = document.createElement('button')
    duplicate.type = 'button'
    duplicate.className = 'btn btn-ghost'
    duplicate.textContent = '复制群聊'
    duplicate.addEventListener('click', () => {
      deps.state.chatMenuChatId = undefined
      renderChatList()
      deps.runCommand('GROUP_CHAT_DUPLICATE', { chatId: chat.id }).catch(error => deps.showError(error.message))
    })
    const clearMessages = document.createElement('button')
    clearMessages.type = 'button'
    clearMessages.className = 'btn btn-ghost'
    clearMessages.textContent = '清空消息'
    clearMessages.addEventListener('click', () => {
      deps.state.chatMenuChatId = undefined
      renderChatList()
      if (!window.confirm(`确定清空「${chat.name}」的聊天消息吗？人员会保留，但所有 iframe 会重新创建。`)) return
      deps.clearChatMessages(chat.id).catch(error => deps.showError(error.message))
    })
    const closeFrames = document.createElement('button')
    closeFrames.type = 'button'
    closeFrames.className = 'btn btn-ghost'
    closeFrames.textContent = '关闭群聊'
    closeFrames.addEventListener('click', () => {
      deps.state.chatMenuChatId = undefined
      renderChatList()
      deps.closeChatFrames(chat.id).catch(error => deps.showError(error.message))
    })
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'btn btn-ghost btn-danger'
    remove.textContent = '删除群聊'
    remove.addEventListener('click', () => {
      deps.state.chatMenuChatId = undefined
      renderChatList()
      if (!window.confirm(`确定删除「${chat.name}」吗？删除后这个群聊的消息和角色都会移除。`)) return
      deps.deleteChat(chat.id).catch(error => deps.showError(error.message))
    })
    menu.append(rename, duplicate, clearMessages, closeFrames, remove)
    return menu
  }

  return { renderChatList, switchChat }
}
