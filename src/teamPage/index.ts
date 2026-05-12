import type { GroupChat, GroupMessage, GroupRole, OpenTeamStore, RoleTemplate } from '../group/types'
import { ensureInviteGate } from '../access/inviteGate'
import type { GeneratedPersonDraft } from '../group/personaGeneration'
import { createDefaultStore } from '../group/store'
import { getAllRoleTemplates } from '../group/roleTemplates'
import { createTeamPageState, pickSelectedChatId } from './appState'
import { createAllNotesView } from './allNotesView'
import { createChatHeaderView } from './chatHeaderView'
import { createChatListView } from './chatListView'
import { createComposerView } from './composerView'
import { createTeamPageDomRefs } from './domRefs'
import { createExternalModelsView } from './externalModelsView'
import { createFloatingWindowControls } from './floatingWindow'
import { createIframeHost } from './iframeHost'
import { createMessagesView } from './messagesView'
import { createNotesView } from './notesView'
import { createPeopleLibraryView } from './peopleLibraryView'
import { createOrchestrationModalView } from './orchestrationModalView'
import { createOrchestrationStatusView } from './orchestrationStatusView'
import { createRoleRecoveryController } from './roleRecoveryController'
import { createRolePanelView } from './rolePanelView'
import { createTeamPageRuntimeClient, type StorePushMessage } from './runtimeClient'
import { createTeamPagePrimaryCoordinator } from './teamPagePrimary'
import { createErrorPresenter, createSuccessPresenter, teamPageLog } from './teamPageServices'
import { createThemeController } from './themeController'
import { createTeamUiController } from './teamUiController'
import { emptyCard, getChatRecentSummary as getStoreChatRecentSummary, messageTitle, roleAvatarLabel, roleToneClass } from './viewHelpers'

const appState = createTeamPageState()

let store: OpenTeamStore = appState.store

const teamDomRefs = createTeamPageDomRefs()
const { appShellEl, closeWindowEl, toggleWindowSizeEl, toggleFullscreenEl, storeSummaryEl, chatListEl, chatTitleEl, chatSubtitleEl, chatStatusEl, messagesEl } = teamDomRefs
const { roleSummaryEl, roleListEl, roleTemplateSelectEl, templateListEl, targetPreviewEl, busyPreviewEl, composerFormEl, sendButtonEl } = teamDomRefs
const { messageInputEl, referenceDraftEl, mentionPanelEl, errorEl, newChatNameEl, createChatFormEl, quickCreateChatEl } = teamDomRefs
const { templateNameEl, templateDescriptionEl, templatePromptEl, templateAiDescriptionEl, generateTemplatePersonaEl, templatePersonaGenerationStatusEl, templateFormTitleEl, settingsButtonEl, settingsMenuEl, themeLightEl, themeDarkEl } = teamDomRefs
const { openAllNotesEl, closeAllNotesEl, allNotesModalEl, allNotesListEl, allNotesActiveTitleEl, allNotesActiveMetaEl, allNotesEditorEl } = teamDomRefs
const { allNoteBoldEl, allNoteItalicEl, allNoteStrikeEl, allNoteBulletListEl, allNoteOrderedListEl, allNoteUndoEl, allNoteRedoEl } = teamDomRefs
const { openPeopleLibraryEl, openExternalModelsEl, openOrchestrationEl, closeOrchestrationEl, orchestrationModalEl, orchestrationAutoModalEl, orchestrationTaskEl, autoOrchestrationEl, openOrchestrationTemplateEl, orchestrationTemplateModalEl, closeOrchestrationTemplateEl, orchestrationTemplateContentEl, closeAutoOrchestrationEl, orchestrationAutoContentEl, orchestrationPeopleListEl, arrangeOrchestrationEl, orchestrationCanvasEl, orchestrationHintEl, orchestrationStageSettingsEl, orchestrationReviewSettingsEl, orchestrationMaxRoundsEl, saveOrchestrationEl, runOrchestrationEl, closeExternalModelsEl, externalModelsModalEl, externalModelsListEl, externalModelFormEl, externalModelIdEl, externalModelNameEl, externalModelFormatEl, externalModelBaseUrlEl, externalModelApiKeyEl, externalModelModelNameEl, resetExternalModelFormEl, closePeopleLibraryEl, peopleLibraryModalEl, personTemplateModalEl, addPersonModalEl, temporaryPersonModalEl } = teamDomRefs
const { notesPanelEl, notesDragHandleEl, notesResizeHandleEl, toggleNotesPanelEl, closeNotesPanelEl, globalNoteTabEl, chatNoteTabEl, notesEditorEl } = teamDomRefs
const { noteBoldEl, noteItalicEl, noteStrikeEl, noteBulletListEl, noteOrderedListEl, noteUndoEl, noteRedoEl } = teamDomRefs
const { peopleLibrarySummaryEl, peopleLibraryListEl, peopleLibraryPaginationEl, peopleLibrarySearchEl, peopleLibraryCategoryFilterEl, peopleLibraryBuiltinTabEl, peopleLibraryCustomTabEl, addLibraryPeopleListEl, addPersonSearchEl, addPersonCategoryFilterEl, addPersonBuiltinTabEl, addPersonCustomTabEl } = teamDomRefs
const { builtinTemplateDetailModalEl, builtinTemplateDetailTitleEl, builtinTemplateDetailMetaEl, builtinTemplateDetailPromptEl, closeBuiltinTemplateDetailEl, newTemplateEl, closePersonTemplateEl, closeAddPersonEl } = teamDomRefs
const { openTemporaryPersonEl, closeTemporaryPersonEl, addRoleFormEl, addLibraryPeopleFormEl, addTemporaryPersonFormEl, peopleLibraryFormEl } = teamDomRefs
const { templateSiteGeminiEl, templateSiteChatGptEl, templateSiteClaudeEl, templateSiteDeepSeekEl, templateSiteExternalEl, templateExternalModelFieldEl, templateExternalModelSelectEl, templateChatGptGptsFieldEl, templateChatGptGptsUrlEl, temporaryPersonNameEl, temporaryPersonDescriptionEl, temporaryPersonPromptEl } = teamDomRefs
const { togglePeopleDrawerEl, rolePanelEl, windowLauncherEl, windowResizeHandleEl } = teamDomRefs
const log = teamPageLog
const showError = createErrorPresenter(errorEl)
const showSuccess = createSuccessPresenter(errorEl)
const themeController = createThemeController({
  root: document.documentElement,
  lightButton: themeLightEl,
  darkButton: themeDarkEl,
})
themeController.initializeTheme()

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
async function generatePersona(description: string): Promise<GeneratedPersonDraft> {
  const response = await sendRuntimeMessage('ROLE_TEMPLATE_PERSONA_GENERATE', { description }) as Awaited<ReturnType<typeof sendRuntimeMessage>> & { persona?: GeneratedPersonDraft }
  if (response.ok === false) throw new Error(response.error || 'AI 生成人设失败')
  if (!response.persona) throw new Error('AI 生成人设返回格式无效')
  return response.persona
}

async function testExternalModel(modelId: string): Promise<void> {
  const response = await sendRuntimeMessage('EXTERNAL_MODEL_TEST', { modelId })
  if (response.ok === false) throw new Error(response.error || '外部模型测试失败')
}

let renderComposerState = (): void => {}
let insertMention = (_role: GroupRole): void => {}
let insertTextIntoActiveNote = (_text: string): void => {}
const floatingWindowControls = createFloatingWindowControls({
  appShellEl,
  closeWindowEl,
  toggleWindowSizeEl,
  toggleFullscreenEl,
  windowLauncherEl,
  windowResizeHandleEl,
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
  refreshCurrentChat: () => roleRecoveryController.refreshCurrentChat(),
  focusRoleFrame: (chatId, roleId) => roleRecoveryController.focusRoleFrame(chatId, roleId),
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
  openOrchestrationEl,
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
  getStore: () => store,
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
  notesResizeHandleEl,
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
  peopleLibrarySearchEl,
  peopleLibraryCategoryFilterEl,
  peopleLibraryBuiltinTabEl,
  peopleLibraryCustomTabEl,
  addLibraryPeopleListEl,
  addPersonSearchEl,
  addPersonCategoryFilterEl,
  addPersonBuiltinTabEl,
  addPersonCustomTabEl,
  builtinTemplateDetailModalEl,
  builtinTemplateDetailTitleEl,
  builtinTemplateDetailMetaEl,
  builtinTemplateDetailPromptEl,
  closeBuiltinTemplateDetailEl,
  roleTemplateSelectEl,
  templateListEl,
  templateNameEl,
  templateDescriptionEl,
  templatePromptEl,
  templateAiDescriptionEl,
  generateTemplatePersonaEl,
  templatePersonaGenerationStatusEl,
  templateFormTitleEl,
  templateSiteGeminiEl,
  templateSiteChatGptEl,
  templateSiteClaudeEl,
  templateSiteDeepSeekEl,
  templateSiteExternalEl,
  templateExternalModelFieldEl,
  templateExternalModelSelectEl,
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
  generatePersona,
  runCommand,
  showError,
  log,
})
const externalModelsView = createExternalModelsView({
  getStore: () => store,
  settingsButtonEl,
  settingsMenuEl,
  openExternalModelsEl,
  closeExternalModelsEl,
  externalModelsModalEl,
  externalModelsListEl,
  externalModelFormEl,
  externalModelIdEl,
  externalModelNameEl,
  externalModelFormatEl,
  externalModelBaseUrlEl,
  externalModelApiKeyEl,
  externalModelModelNameEl,
  resetExternalModelFormEl,
  runCommand,
  testExternalModel,
  showError,
})
const renderExternalModels = externalModelsView.renderExternalModels
const openExternalModels = externalModelsView.openExternalModels
const closeExternalModels = externalModelsView.closeExternalModels
const registerExternalModelsEvents = externalModelsView.registerExternalModelsEvents
const orchestrationModalView = createOrchestrationModalView({
  openOrchestrationEl,
  orchestrationModalEl,
  orchestrationAutoModalEl,
  closeOrchestrationEl,
  orchestrationTaskEl,
  autoOrchestrationEl,
  openOrchestrationTemplateEl,
  orchestrationTemplateModalEl,
  closeOrchestrationTemplateEl,
  orchestrationTemplateContentEl,
  closeAutoOrchestrationEl,
  orchestrationAutoContentEl,
  orchestrationPeopleListEl,
  arrangeOrchestrationEl,
  orchestrationCanvasEl,
  orchestrationHintEl,
  orchestrationStageSettingsEl,
  orchestrationReviewSettingsEl,
  orchestrationMaxRoundsEl,
  saveOrchestrationEl,
  runOrchestrationEl,
  getStore: () => store,
  applyStore,
  getCurrentChat,
  getCurrentRoles,
  reconnectRolesForSend,
  sendRuntimeMessage,
  runCommand,
  openExternalModels,
  showError,
  showSuccess,
})
const registerOrchestrationEvents = orchestrationModalView.registerOrchestrationEvents
const renderOrchestrationModal = orchestrationModalView.render
const orchestrationStatusView = createOrchestrationStatusView({
  getStore: () => store,
  getCurrentChat,
  getCurrentRoles,
  reconnectRolesForSend,
  runCommand,
  showError,
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
  renderOrchestrationStatus: orchestrationStatusView.renderOrchestrationStatus,
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
  getCurrentChat,
  getCurrentRoles,
  getSelectedLoginSite: () => store.rolesById[appState.selectedRoleId ?? '']?.chatSite ?? store.settings.defaultChatSite,
  render,
  renderChatList,
  renderRolePanel,
  renderAddPersonDialog,
  closePeopleModals,
  closeExternalModels,
  registerComposerEvents,
  registerPeopleLibraryEvents,
  registerExternalModelsEvents,
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
  appState.selectedChatId = pickSelectedChatId(appState)
  const roles = getCurrentRoles()
  if (!appState.selectedRoleId || !roles.some(role => role.id === appState.selectedRoleId)) appState.selectedRoleId = roles[0]?.id
  if (appState.selectedReference && appState.selectedReference.messageId && !getCurrentMessages().some(message => message.id === appState.selectedReference?.messageId)) {
    appState.selectedReference = undefined
  }
  syncIframeHost()
  render()
  notifyRoleReadyWaiters()
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
  const siteRoles = roles.filter(role => role.modelSource !== 'external')
  log.debug('iframe-sync:activate-chat', {
    chatId: chat.id,
    roleIds: siteRoles.map(role => role.id),
    roleStatuses: roles.map(role => ({ id: role.id, name: role.name, status: role.status, conversationUrl: role.geminiConversationUrl })),
  })
  iframeHost.activateChat({ ...chat, roleIds: siteRoles.map(role => role.id) }, siteRoles)
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
  if (!externalModelsModalEl.hidden) renderExternalModels()
  if (!orchestrationModalEl.hidden) renderOrchestrationModal()
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
  chrome.runtime.onMessage.addListener((message: StorePushMessage, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false
    if (message.type === 'GROUP_ROLE_RECOVERY_REQUEST') {
      handleRoleRecoveryRequest(message, sendResponse)
      return true
    }
    if (orchestrationModalView.handleRuntimeMessage(message)) return false
    if (message.type === 'TEAM_FRAME_ROLE_READY') iframeHost.markRoleReady(message.chatId, message.roleId)
    if ('store' in message && message.store) {
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

function handleRoleRecoveryRequest(message: Extract<StorePushMessage, { type: 'GROUP_ROLE_RECOVERY_REQUEST' }>, sendResponse: (response?: unknown) => void): void {
  const chat = store.chatsById[message.chatId]
  const role = store.rolesById[message.roleId]
  if (!chat || !role || role.chatId !== chat.id) {
    log.warn('orchestration-diagnostic:role-recovery:missing-role', {
      chatId: message.chatId,
      roleId: message.roleId,
      reason: message.reason,
      hasChat: Boolean(chat),
      hasRole: Boolean(role),
      roleChatId: role?.chatId,
    })
    sendResponse({ ok: false, error: '找不到要恢复的人员' })
    return
  }
  log.warn('orchestration-diagnostic:role-recovery:start', {
    chatId: chat.id,
    roleId: role.id,
    roleName: role.name,
    chatSite: role.chatSite,
    reason: message.reason,
  })
  reconnectRolesForSend(chat, [role])
    .then(() => {
      log.warn('orchestration-diagnostic:role-recovery:ready', {
        chatId: chat.id,
        roleId: role.id,
        roleName: role.name,
        chatSite: role.chatSite,
      })
      sendResponse({ ok: true })
    })
    .catch(error => {
      const reason = error instanceof Error ? error.message : String(error)
      log.warn('orchestration-diagnostic:role-recovery:failed', { chatId: chat.id, roleId: role.id, roleName: role.name, chatSite: role.chatSite, reason: message.reason, error: reason })
      sendResponse({ ok: false, error: reason })
    })
}

async function boot(): Promise<void> {
  await ensureInviteGate()
  await resolveHostTabId()
  await primaryCoordinator.start()
  window.addEventListener('pagehide', () => primaryCoordinator.dispose(), { once: true })
  registerRuntimePush()
  themeController.registerThemeEvents()
  registerFloatingWindowControls()
  registerAllNotesEvents()
  registerUi()
  registerOrchestrationEvents()
  registerNotesEvents()
  render()
  await refreshStore(false)
}

boot().catch(error => showError(error instanceof Error ? error.message : String(error)))
