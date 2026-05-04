import type { GroupChat, GroupMessage, GroupRole, OpenTeamStore, RoleTemplate } from '../group/types'
import { createDefaultStore } from '../group/store'
import { getAllRoleTemplates } from '../group/roleTemplates'
import { createTeamPageState } from './appState'
import { createAllNotesView } from './allNotesView'
import { createChatHeaderView } from './chatHeaderView'
import { createChatListView } from './chatListView'
import { createComposerView } from './composerView'
import { createTeamPageDomRefs } from './domRefs'
import { createFloatingWindowControls } from './floatingWindow'
import { createIframeHost } from './iframeHost'
import { createMessagesView } from './messagesView'
import { createNotesView } from './notesView'
import { createPeopleLibraryView } from './peopleLibraryView'
import { createRoleRecoveryController } from './roleRecoveryController'
import { createRolePanelView } from './rolePanelView'
import { createTeamPageRuntimeClient, type StorePushMessage } from './runtimeClient'
import { createTeamPagePrimaryCoordinator } from './teamPagePrimary'
import { createErrorPresenter, createSuccessPresenter, teamPageLog } from './teamPageServices'
import { createTeamUiController } from './teamUiController'
import { emptyCard, getChatRecentSummary as getStoreChatRecentSummary, messageTitle, roleAvatarLabel, roleToneClass } from './viewHelpers'

const appState = createTeamPageState()

let store: OpenTeamStore = appState.store

const teamDomRefs = createTeamPageDomRefs()
const { appShellEl, toggleWindowSizeEl, toggleFullscreenEl, storeSummaryEl, chatListEl, chatTitleEl, chatSubtitleEl, chatStatusEl, messagesEl } = teamDomRefs
const { roleSummaryEl, roleListEl, roleTemplateSelectEl, templateListEl, targetPreviewEl, busyPreviewEl, composerFormEl, sendButtonEl } = teamDomRefs
const { messageInputEl, referenceDraftEl, mentionPanelEl, errorEl, newChatNameEl, createChatFormEl, quickCreateChatEl } = teamDomRefs
const { templateNameEl, templateDescriptionEl, templatePromptEl, templateFormTitleEl, settingsButtonEl, settingsMenuEl } = teamDomRefs
const { openAllNotesEl, closeAllNotesEl, allNotesModalEl, allNotesListEl, allNotesActiveTitleEl, allNotesActiveMetaEl, allNotesEditorEl } = teamDomRefs
const { allNoteBoldEl, allNoteItalicEl, allNoteStrikeEl, allNoteBulletListEl, allNoteOrderedListEl, allNoteUndoEl, allNoteRedoEl } = teamDomRefs
const { openPeopleLibraryEl, closePeopleLibraryEl, peopleLibraryModalEl, personTemplateModalEl, addPersonModalEl, temporaryPersonModalEl } = teamDomRefs
const { notesPanelEl, notesDragHandleEl, toggleNotesPanelEl, closeNotesPanelEl, globalNoteTabEl, chatNoteTabEl, notesEditorEl } = teamDomRefs
const { noteBoldEl, noteItalicEl, noteStrikeEl, noteBulletListEl, noteOrderedListEl, noteUndoEl, noteRedoEl } = teamDomRefs
const { peopleLibrarySummaryEl, peopleLibraryListEl, peopleLibraryPaginationEl, addLibraryPeopleListEl, addPersonSearchEl, addPersonBuiltinTabEl, addPersonCustomTabEl, newTemplateEl, closePersonTemplateEl, closeAddPersonEl } = teamDomRefs
const { openTemporaryPersonEl, closeTemporaryPersonEl, addRoleFormEl, addLibraryPeopleFormEl, addTemporaryPersonFormEl, peopleLibraryFormEl } = teamDomRefs
const { templateSiteGeminiEl, templateSiteChatGptEl, templateSiteClaudeEl, templateSiteDeepSeekEl, templateSiteQwenEl, templateSiteKimiEl, templateChatGptGptsFieldEl, templateChatGptGptsUrlEl, temporaryPersonNameEl, temporaryPersonDescriptionEl, temporaryPersonPromptEl } = teamDomRefs
const { togglePeopleDrawerEl, rolePanelEl, windowLauncherEl } = teamDomRefs
const log = teamPageLog
const showError = createErrorPresenter(errorEl)
const showSuccess = createSuccessPresenter(errorEl)

const iframeHost = createIframeHost({
  visibleHost: teamDomRefs.iframeHostEl,
  onEvent(event) {
    log.debug(`iframe-host:${event.type}`, event)
  },
})
const primaryCoordinator = createTeamPagePrimaryCoordinator({
  navigator,
  window,
  onPrimaryChange: handlePrimaryModeChange,
  log,
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
let insertMention = (_role: GroupRole): void => {}
let insertTextIntoActiveNote = (_text: string): void => {}
const floatingWindowControls = createFloatingWindowControls({
  appShellEl,
  toggleWindowSizeEl,
  toggleFullscreenEl,
  windowLauncherEl,
})
const setWindowMinimized = floatingWindowControls.setWindowMinimized
const registerFloatingWindowControls = floatingWindowControls.registerFloatingWindowControls
const allNotesView = createAllNotesView({
  openAllNotesEl,
  closeAllNotesEl,
  allNotesModalEl,
  allNotesListEl,
  allNotesActiveTitleEl,
  allNotesActiveMetaEl,
  allNotesEditorEl,
  noteToolbarButtons: {
    bold: allNoteBoldEl,
    italic: allNoteItalicEl,
    strike: allNoteStrikeEl,
    bulletList: allNoteBulletListEl,
    orderedList: allNoteOrderedListEl,
    undo: allNoteUndoEl,
    redo: allNoteRedoEl,
  },
  getStore: () => store,
  getCurrentChat,
  runCommand,
  showError,
})
const renderAllNotes = allNotesView.renderAllNotes
const registerAllNotesEvents = allNotesView.registerAllNotesEvents
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
  insertMention: role => insertMention(role),
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
const resyncMessageReply = roleRecoveryController.resyncMessageReply
const retryRoleReply = roleRecoveryController.retryRoleReply
const stopRoleReply = roleRecoveryController.stopRoleReply
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
insertMention = composerView.insertMention
const registerComposerEvents = composerView.registerComposerEvents
const setReference = composerView.setReference
const notesView = createNotesView({
  state: appState,
  notesPanelEl,
  notesDragHandleEl,
  toggleNotesPanelEl,
  closeNotesPanelEl,
  globalNoteTabEl,
  chatNoteTabEl,
  notesEditorEl,
  noteToolbarButtons: {
    bold: noteBoldEl,
    italic: noteItalicEl,
    strike: noteStrikeEl,
    bulletList: noteBulletListEl,
    orderedList: noteOrderedListEl,
    undo: noteUndoEl,
    redo: noteRedoEl,
  },
  getStore: () => store,
  getCurrentChat,
  runCommand,
  showError,
})
const renderNotes = notesView.renderNotes
const registerNotesEvents = notesView.registerNotesEvents
insertTextIntoActiveNote = notesView.insertTextIntoActiveNote
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
  peopleLibraryPaginationEl,
  addLibraryPeopleListEl,
  addPersonSearchEl,
  addPersonBuiltinTabEl,
  addPersonCustomTabEl,
  roleTemplateSelectEl,
  templateListEl,
  templateNameEl,
  templateDescriptionEl,
  templatePromptEl,
  templateFormTitleEl,
  templateSiteGeminiEl,
  templateSiteChatGptEl,
  templateSiteClaudeEl,
  templateSiteDeepSeekEl,
  templateSiteQwenEl,
  templateSiteKimiEl,
  templateChatGptGptsFieldEl,
  templateChatGptGptsUrlEl,
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
  insertMention,
  setReference,
  insertTextIntoActiveNote,
  resyncMessageReply,
  retryRoleReply,
  stopRoleReply,
  runCommand,
  render,
  showError,
  showSuccess,
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
  rolePanelEl,
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
  return getAllRoleTemplates(store)
}

function syncIframeHost(): void {
  if (!primaryCoordinator.isPrimary()) {
    iframeHost.setEnabled(false)
    return
  }

  const chat = getCurrentChat()
  if (!chat) return
  iframeHost.setEnabled(true)
  const roles = getCurrentRoles()
  log.debug('iframe-sync:activate-chat', {
    chatId: chat.id,
    roleIds: roles.map(role => role.id),
    roleStatuses: roles.map(role => ({ id: role.id, name: role.name, status: role.status, conversationUrl: role.geminiConversationUrl })),
  })
  iframeHost.activateChat(chat, roles)
}

function handlePrimaryModeChange(isPrimary: boolean): void {
  iframeHost.setEnabled(isPrimary)
  document.body.dataset.teamPagePrimary = String(isPrimary)
  if (isPrimary) {
    log.info('team-page-primary:enabled', { hostTabId: appState.hostTabId })
    syncIframeHost()
    return
  }

  log.warn('team-page-primary:passive', { hostTabId: appState.hostTabId })
  showError('已检测到另一个 OpenTeam 页面正在运行。当前页面已暂停 AI iframe，避免两个页面同时加载导致卡死。')
}

function render(): void {
  renderSelectedChat()
  renderTemplates()
  renderAddPersonDialog()
  if (!allNotesModalEl.hidden) renderAllNotes()
}

function renderSelectedChat(): void {
  renderChatList()
  renderChatHeader()
  renderMessages()
  renderComposerState()
  renderRolePanel()
  renderNotes()
}

function registerRuntimePush(): void {
  chrome.runtime.onMessage.addListener((message: StorePushMessage) => {
    if (!message || typeof message.type !== 'string') return false
    if (message.type === 'TEAM_FRAME_ROLE_READY') iframeHost.markRoleReady(message.chatId, message.roleId)
    if (message.store) {
      applyStore(message.store)
    } else if (message.type.startsWith('GROUP_') || message.type.startsWith('TEAM_')) {
      refreshStore(false).catch(error => log.warn('runtime-push:refresh-failed', { type: message.type, error: error instanceof Error ? error.message : String(error) }))
    }
    if (message.type === 'GROUP_DELIVERY_ERROR') {
      const errorMessage = message.error || message.message
      if (errorMessage) showError(errorMessage)
    }
    return false
  })
}

async function boot(): Promise<void> {
  await resolveHostTabId()
  await primaryCoordinator.start()
  window.addEventListener('pagehide', () => primaryCoordinator.dispose(), { once: true })
  registerRuntimePush()
  registerFloatingWindowControls()
  registerAllNotesEvents()
  registerUi()
  registerNotesEvents()
  render()
  await refreshStore(false)
}

boot().catch(error => showError(error instanceof Error ? error.message : String(error)))
