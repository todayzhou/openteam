import type { GroupChat, GroupMessage, GroupRole, OpenTeamStore, RoleTemplate } from '../group/types'
import { createDefaultStore } from '../group/store'
import { createTeamPageState } from './appState'
import { createChatHeaderView } from './chatHeaderView'
import { createChatListView } from './chatListView'
import { createComposerView } from './composerView'
import { createTeamPageDomRefs } from './domRefs'
import { createFloatingWindowControls } from './floatingWindow'
import { createIframeHost } from './iframeHost'
import { createMessagesView } from './messagesView'
import { createPeopleLibraryView } from './peopleLibraryView'
import { createRoleRecoveryController } from './roleRecoveryController'
import { createRolePanelView } from './rolePanelView'
import { createTeamPageRuntimeClient, type StorePushMessage } from './runtimeClient'
import { createErrorPresenter, teamPageLog } from './teamPageServices'
import { createTeamUiController } from './teamUiController'
import { emptyCard, getChatRecentSummary as getStoreChatRecentSummary, messageTitle, roleAvatarLabel, roleToneClass } from './viewHelpers'

const appState = createTeamPageState()

let store: OpenTeamStore = appState.store

const teamDomRefs = createTeamPageDomRefs()
const { appShellEl, floatingDragHandleEl, toggleWindowSizeEl, storeSummaryEl, chatListEl, chatTitleEl, chatSubtitleEl, chatStatusEl, messagesEl } = teamDomRefs
const { roleSummaryEl, roleListEl, roleTemplateSelectEl, templateListEl, targetPreviewEl, busyPreviewEl, composerFormEl, sendButtonEl } = teamDomRefs
const { messageInputEl, referenceDraftEl, mentionPanelEl, errorEl, newChatNameEl, createChatFormEl, quickCreateChatEl } = teamDomRefs
const { templateNameEl, templateDescriptionEl, templatePromptEl, templateFormTitleEl, settingsButtonEl, settingsMenuEl } = teamDomRefs
const { openPeopleLibraryEl, closePeopleLibraryEl, peopleLibraryModalEl, personTemplateModalEl, addPersonModalEl, temporaryPersonModalEl } = teamDomRefs
const { peopleLibrarySummaryEl, peopleLibraryListEl, addLibraryPeopleListEl, newTemplateEl, closePersonTemplateEl, closeAddPersonEl } = teamDomRefs
const { openTemporaryPersonEl, closeTemporaryPersonEl, addRoleFormEl, addLibraryPeopleFormEl, addTemporaryPersonFormEl, peopleLibraryFormEl } = teamDomRefs
const { templateSiteGeminiEl, templateSiteChatGptEl, templateSiteClaudeEl, temporaryPersonNameEl, temporaryPersonDescriptionEl, temporaryPersonPromptEl } = teamDomRefs
const { togglePeopleDrawerEl, rolePanelEl, windowLauncherEl } = teamDomRefs
const log = teamPageLog
const showError = createErrorPresenter(errorEl)

const iframeHost = createIframeHost({
  visibleHost: teamDomRefs.iframeHostEl,
  onEvent(event) {
    log.debug(`iframe-host:${event.type}`, event)
  },
})

const runtimeClient = createTeamPageRuntimeClient({
  getHostTabId: () => appState.hostTabId,
  applyStore,
  refreshStore,
  log,
})
const sendRuntimeMessage = runtimeClient.sendRuntimeMessage
const runCommand = runtimeClient.runCommand
let renderComposerState = (): void => {}
const floatingWindowControls = createFloatingWindowControls({
  appShellEl,
  floatingDragHandleEl,
  toggleWindowSizeEl,
  windowLauncherEl,
})
const setWindowMinimized = floatingWindowControls.setWindowMinimized
const registerFloatingWindowControls = floatingWindowControls.registerFloatingWindowControls
const rolePanelView = createRolePanelView({
  state: appState,
  getStore: () => store,
  rolePanelEl,
  roleSummaryEl,
  roleListEl,
  iframeHost,
  getCurrentChat,
  getCurrentRoles,
  emptyCard,
  roleToneClass,
  roleAvatarLabel,
  runCommand,
  showError,
})
const renderRolePanel = rolePanelView.renderRolePanel
const chatHeaderView = createChatHeaderView({
  state: appState,
  chatTitleEl,
  chatSubtitleEl,
  chatStatusEl,
  togglePeopleDrawerEl,
  getCurrentChat,
  getCurrentRoles,
  getCurrentMessages,
})
const renderChatHeader = chatHeaderView.renderChatHeader
const chatListView = createChatListView({
  state: appState,
  getStore: () => store,
  applyStore,
  storeSummaryEl,
  chatListEl,
  iframeHost,
  getTemplates,
  getChatRecentSummary: chat => getStoreChatRecentSummary(chat, store),
  roleToneClass,
  roleAvatarLabel,
  emptyCard,
  renderSelectedChat,
  renderRolePanel,
  sendRuntimeMessage,
  runCommand,
  log,
  showError,
})
const renderChatList = chatListView.renderChatList
const switchChat = chatListView.switchChat
const roleRecoveryController = createRoleRecoveryController({
  state: appState,
  getStore: () => store,
  getCurrentRoles,
  refreshStore,
  switchChat,
  renderComposerState: () => renderComposerState(),
  setWindowMinimized,
  iframeHost,
  runCommand,
  showError,
  log,
})
const refreshCurrentChat = roleRecoveryController.refreshCurrentChat
const notifyRoleReadyWaiters = roleRecoveryController.notifyRoleReadyWaiters
const reconnectRolesForSend = roleRecoveryController.reconnectRolesForSend
const focusRoleFrame = roleRecoveryController.focusRoleFrame
const interruptAndRetryRole = roleRecoveryController.interruptAndRetryRole
const composerView = createComposerView({
  state: appState,
  composerFormEl,
  targetPreviewEl,
  busyPreviewEl,
  sendButtonEl,
  messageInputEl,
  referenceDraftEl,
  mentionPanelEl,
  getCurrentChat,
  getCurrentRoles,
  roleToneClass,
  roleAvatarLabel,
  reconnectRolesForSend,
  runCommand,
  showError,
})
renderComposerState = composerView.renderComposerState
const registerComposerEvents = composerView.registerComposerEvents
const setReference = composerView.setReference
const peopleLibraryView = createPeopleLibraryView({
  state: appState,
  getStore: () => store,
  settingsButtonEl,
  settingsMenuEl,
  openPeopleLibraryEl,
  closePeopleLibraryEl,
  peopleLibraryModalEl,
  personTemplateModalEl,
  addPersonModalEl,
  temporaryPersonModalEl,
  peopleLibrarySummaryEl,
  peopleLibraryListEl,
  addLibraryPeopleListEl,
  roleTemplateSelectEl,
  templateListEl,
  templateNameEl,
  templateDescriptionEl,
  templatePromptEl,
  templateFormTitleEl,
  templateSiteGeminiEl,
  templateSiteChatGptEl,
  templateSiteClaudeEl,
  temporaryPersonNameEl,
  temporaryPersonDescriptionEl,
  temporaryPersonPromptEl,
  newTemplateEl,
  closePersonTemplateEl,
  closeAddPersonEl,
  openTemporaryPersonEl,
  closeTemporaryPersonEl,
  addRoleFormEl,
  addLibraryPeopleFormEl,
  addTemporaryPersonFormEl,
  peopleLibraryFormEl,
  getCurrentChat,
  getTemplates,
  emptyCard,
  runCommand,
  showError,
  log,
})
const renderTemplates = peopleLibraryView.renderTemplates
const renderAddPersonDialog = peopleLibraryView.renderAddPersonDialog
const openAddPersonDialog = peopleLibraryView.openAddPersonDialog
const closePeopleModals = peopleLibraryView.closePeopleModals
const registerPeopleLibraryEvents = peopleLibraryView.registerPeopleLibraryEvents
const messagesView = createMessagesView({
  state: appState,
  getStore: () => store,
  messagesEl,
  getCurrentChat,
  getCurrentRoles,
  getCurrentMessages,
  emptyCard,
  openAddPersonDialog,
  roleToneClass,
  roleAvatarLabel,
  messageTitle,
  focusRoleFrame,
  setReference,
  interruptAndRetryRole,
  runCommand,
  render,
  showError,
  log,
})
const renderMessages = messagesView.renderMessages
const teamUiController = createTeamUiController({
  state: appState,
  settingsButtonEl,
  settingsMenuEl,
  quickCreateChatEl,
  createChatFormEl,
  newChatNameEl,
  togglePeopleDrawerEl,
  iframeHost,
  refreshCurrentChat,
  getCurrentChat,
  getCurrentRoles,
  getSelectedLoginSite: () => store.rolesById[appState.selectedRoleId ?? '']?.chatSite ?? store.settings.defaultChatSite,
  render,
  renderChatList,
  renderRolePanel,
  renderAddPersonDialog,
  closePeopleModals,
  registerComposerEvents,
  registerPeopleLibraryEvents,
  runCommand,
  showError,
  log,
})
const registerUi = teamUiController.registerUi

async function resolveHostTabId(): Promise<void> {
  const tab = await chrome.tabs.getCurrent()
  appState.hostTabId = tab?.id
  log.info('host-tab:resolved', { hostTabId: appState.hostTabId, url: tab?.url })
  iframeHost.setHostTabId(appState.hostTabId)
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
  appState.store = nextStore
  store = appState.store
  appState.selectedChatId = pickCurrentChatId()
  const roles = getCurrentRoles()
  if (!appState.selectedRoleId || !roles.some(role => role.id === appState.selectedRoleId)) appState.selectedRoleId = roles[0]?.id
  if (appState.selectedReference && appState.selectedReference.messageId && !getCurrentMessages().some(message => message.id === appState.selectedReference?.messageId)) {
    appState.selectedReference = undefined
  }
  syncIframeHost()
  render()
  notifyRoleReadyWaiters()
}

function pickCurrentChatId(): string | undefined {
  if (appState.selectedChatId && store.chatsById[appState.selectedChatId]) return appState.selectedChatId
  if (store.currentChatId && store.chatsById[store.currentChatId]) return store.currentChatId
  return [...store.chatOrder]
    .sort((left, right) => (store.chatsById[right]?.updatedAt ?? 0) - (store.chatsById[left]?.updatedAt ?? 0))
    .find(chatId => Boolean(store.chatsById[chatId]))
}

function getCurrentChat(): GroupChat | undefined {
  return appState.selectedChatId ? store.chatsById[appState.selectedChatId] : undefined
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

function registerRuntimePush(): void {
  chrome.runtime.onMessage.addListener((message: StorePushMessage) => {
    if (!message || typeof message.type !== 'string') return false
    if (message.type === 'TEAM_FRAME_ROLE_READY') iframeHost.markRoleReady(message.chatId, message.roleId)
    if (message.store) applyStore(message.store)
    if (message.type === 'GROUP_DELIVERY_ERROR' && message.error) showError(message.error)
    return false
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
