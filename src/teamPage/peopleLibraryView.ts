import type { ChatSite, GroupChat, OpenTeamStore, RoleTemplate } from '../group/types'
import type { TeamPageState } from './appState'

type TemplateDraft = Pick<RoleTemplate, 'name' | 'description' | 'systemPrompt' | 'defaultChatSite' | 'chatGptGptsUrl'>
type AddPersonItem =
  | { key: string; source: 'library'; type: RoleTemplate['type']; roleTemplateId: string; name: string; description?: string; systemPrompt: string; chatSites: ChatSite[]; disabledSites: Set<ChatSite> }
  | { key: string; source: 'temporary'; type: 'custom'; draftId: string; name: string; description?: string; systemPrompt: string; chatSites: ChatSite[]; disabledSites: Set<ChatSite> }

const PEOPLE_LIBRARY_PAGE_SIZE = 5
const VISIBLE_CHAT_SITES = ['gemini', 'chatgpt', 'claude', 'deepseek'] as const

export interface PeopleLibraryViewDependencies {
  state: TeamPageState
  getStore(): OpenTeamStore
  settingsButtonEl: HTMLButtonElement
  settingsMenuEl: HTMLElement
  openPeopleLibraryEl: HTMLButtonElement
  closePeopleLibraryEl: HTMLButtonElement
  peopleLibraryModalEl: HTMLElement
  personTemplateModalEl: HTMLElement
  addPersonModalEl: HTMLElement
  temporaryPersonModalEl: HTMLElement
  peopleLibrarySummaryEl: HTMLElement
  peopleLibraryListEl: HTMLElement
  peopleLibraryPaginationEl: HTMLElement
  addLibraryPeopleListEl: HTMLElement
  addPersonSearchEl: HTMLInputElement
  addPersonBuiltinTabEl: HTMLButtonElement
  addPersonCustomTabEl: HTMLButtonElement
  roleTemplateSelectEl: HTMLSelectElement
  templateListEl: HTMLElement
  templateNameEl: HTMLInputElement
  templateDescriptionEl: HTMLTextAreaElement
  templatePromptEl: HTMLTextAreaElement
  templateFormTitleEl: HTMLElement
  templateSiteGeminiEl: HTMLInputElement
  templateSiteChatGptEl: HTMLInputElement
  templateSiteClaudeEl: HTMLInputElement
  templateSiteDeepSeekEl: HTMLInputElement
  templateSiteQwenEl: HTMLInputElement
  templateSiteKimiEl: HTMLInputElement
  templateChatGptGptsFieldEl: HTMLElement
  templateChatGptGptsUrlEl: HTMLInputElement
  temporaryPersonNameEl: HTMLInputElement
  temporaryPersonDescriptionEl: HTMLTextAreaElement
  temporaryPersonPromptEl: HTMLTextAreaElement
  newTemplateEl: HTMLButtonElement
  closePersonTemplateEl: HTMLButtonElement
  closeAddPersonEl: HTMLButtonElement
  openTemporaryPersonEl: HTMLButtonElement
  closeTemporaryPersonEl: HTMLButtonElement
  addRoleFormEl: HTMLFormElement
  addLibraryPeopleFormEl: HTMLFormElement
  addTemporaryPersonFormEl: HTMLFormElement
  peopleLibraryFormEl: HTMLFormElement
  getCurrentChat(): GroupChat | undefined
  getTemplates(): RoleTemplate[]
  emptyCard(title: string, body: string): HTMLElement
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  showError(message: string): void
  log: {
    info(event: string, details?: Record<string, unknown>): void
  }
}

export interface PeopleLibraryView {
  closePeopleModals(): void
  openAddPersonDialog(): void
  registerPeopleLibraryEvents(): void
  renderAddPersonDialog(): void
  renderTemplates(): void
}

export function createPeopleLibraryView(deps: PeopleLibraryViewDependencies): PeopleLibraryView {
  function renderTemplates(): void {
    const templates = deps.getTemplates()
    deps.peopleLibrarySummaryEl.textContent = `${templates.length} 人`
    deps.roleTemplateSelectEl.replaceChildren(new Option('不使用人员库，手动创建', ''))
    for (const template of templates) deps.roleTemplateSelectEl.append(new Option(template.name, template.id))

    deps.templateListEl.replaceChildren()
    deps.peopleLibraryListEl.replaceChildren()
    deps.peopleLibraryPaginationEl.replaceChildren()
    if (templates.length === 0) {
      deps.peopleLibraryListEl.append(deps.emptyCard('暂无人员', '新建人员后，可在添加人员时复用。'))
    } else {
      const visibleTemplates = pagedTemplates(templates)
      for (const template of visibleTemplates) {
        const card = templateCard(template)
        deps.templateListEl.append(card.cloneNode(true))
        deps.peopleLibraryListEl.append(card)
      }
      renderPeopleLibraryPagination(templates.length)
    }
    if (!deps.personTemplateModalEl.hidden) renderTemplateEditor()
  }

  function renderTemplateEditor(): void {
    const store = deps.getStore()
    const selectedTemplate = deps.state.selectedTemplateId ? store.roleTemplatesById[deps.state.selectedTemplateId] : undefined
    deps.templateFormTitleEl.textContent = selectedTemplate ? `编辑人员：${selectedTemplate.name}` : '新建人员'
    if (selectedTemplate) {
      const defaultChatSite = visibleChatSite(selectedTemplate.defaultChatSite ?? store.settings.defaultChatSite)
      deps.templateNameEl.value = selectedTemplate.name
      deps.templateDescriptionEl.value = selectedTemplate.description ?? ''
      deps.templatePromptEl.value = selectedTemplate.systemPrompt
      deps.templateSiteGeminiEl.checked = defaultChatSite === 'gemini'
      deps.templateSiteChatGptEl.checked = defaultChatSite === 'chatgpt'
      deps.templateSiteClaudeEl.checked = defaultChatSite === 'claude'
      deps.templateSiteDeepSeekEl.checked = defaultChatSite === 'deepseek'
      deps.templateSiteQwenEl.checked = defaultChatSite === 'qwen'
      deps.templateSiteKimiEl.checked = false
      deps.templateChatGptGptsUrlEl.value = selectedTemplate.chatGptGptsUrl ?? ''
      syncTemplateChatGptGptsField()
    } else {
      deps.templateNameEl.value = ''
      deps.templateDescriptionEl.value = ''
      deps.templatePromptEl.value = ''
      const defaultChatSite = visibleChatSite(store.settings.defaultChatSite)
      deps.templateSiteGeminiEl.checked = defaultChatSite === 'gemini'
      deps.templateSiteChatGptEl.checked = defaultChatSite === 'chatgpt'
      deps.templateSiteClaudeEl.checked = defaultChatSite === 'claude'
      deps.templateSiteDeepSeekEl.checked = defaultChatSite === 'deepseek'
      deps.templateSiteQwenEl.checked = defaultChatSite === 'qwen'
      deps.templateSiteKimiEl.checked = false
      deps.templateChatGptGptsUrlEl.value = ''
      syncTemplateChatGptGptsField()
    }
  }

  function openTemplateEditor(templateId?: string): void {
    deps.state.selectedTemplateId = templateId
    renderTemplateEditor()
    deps.personTemplateModalEl.hidden = false
    deps.templateNameEl.focus()
  }

  function closeTemplateEditor(): void {
    deps.personTemplateModalEl.hidden = true
    deps.state.selectedTemplateId = undefined
  }

  function openAddPersonDialog(): void {
    if (!deps.getCurrentChat()) return
    deps.addPersonModalEl.hidden = false
    deps.state.addPersonSiteMenuId = undefined
    deps.state.addPersonTemplateType = 'builtin'
    deps.state.addPersonSearchQuery = ''
    deps.addPersonSearchEl.value = ''
    deps.log.info('ui:person-add-dialog:open', { chatId: deps.getCurrentChat()?.id, source: 'mixed' })
    renderAddPersonDialog()
  }

  function openTemporaryPersonDialog(): void {
    deps.temporaryPersonNameEl.value = ''
    deps.temporaryPersonDescriptionEl.value = ''
    deps.temporaryPersonPromptEl.value = ''
    deps.temporaryPersonModalEl.hidden = false
    deps.temporaryPersonNameEl.focus()
  }

  function closeTemporaryPersonDialog(): void {
    deps.temporaryPersonModalEl.hidden = true
  }

  function closePeopleModals(): void {
    deps.peopleLibraryModalEl.hidden = true
    deps.personTemplateModalEl.hidden = true
    deps.addPersonModalEl.hidden = true
    deps.temporaryPersonModalEl.hidden = true
    deps.state.selectedTemplateId = undefined
    deps.state.addPersonSiteMenuId = undefined
    deps.state.addPersonTemplateType = 'builtin'
    deps.state.addPersonSearchQuery = ''
  }

  function registerPeopleLibraryEvents(): void {
    deps.openPeopleLibraryEl.addEventListener('click', () => {
      deps.settingsMenuEl.hidden = true
      deps.settingsButtonEl.setAttribute('aria-expanded', 'false')
      deps.peopleLibraryModalEl.hidden = false
      deps.state.peopleLibraryPage = 0
      deps.log.info('ui:people-library:open', { templateCount: deps.getTemplates().length })
      renderTemplates()
    })

    deps.closePeopleLibraryEl.addEventListener('click', () => {
      deps.peopleLibraryModalEl.hidden = true
    })

    deps.newTemplateEl.addEventListener('click', () => openTemplateEditor())
    deps.closePersonTemplateEl.addEventListener('click', closeTemplateEditor)
    for (const input of templateSiteInputs()) {
      input.addEventListener('change', syncTemplateChatGptGptsField)
    }

    deps.closeAddPersonEl.addEventListener('click', () => {
      deps.addPersonModalEl.hidden = true
      deps.state.addPersonSiteMenuId = undefined
    })

    deps.addPersonSearchEl.addEventListener('input', () => {
      deps.state.addPersonSearchQuery = deps.addPersonSearchEl.value
      renderAddPersonDialog()
    })
    deps.addPersonBuiltinTabEl.addEventListener('click', () => {
      deps.state.addPersonTemplateType = 'builtin'
      renderAddPersonDialog()
    })
    deps.addPersonCustomTabEl.addEventListener('click', () => {
      deps.state.addPersonTemplateType = 'custom'
      renderAddPersonDialog()
    })

    deps.openTemporaryPersonEl.addEventListener('click', openTemporaryPersonDialog)
    deps.closeTemporaryPersonEl.addEventListener('click', closeTemporaryPersonDialog)

    deps.addRoleFormEl.addEventListener('submit', event => {
      event.preventDefault()
      openAddPersonDialog()
    })

    deps.addLibraryPeopleFormEl.addEventListener('submit', event => {
      event.preventDefault()
      addPeopleToCurrentChat(selectedAddPersonItems())
        .then(() => {
          deps.addPersonModalEl.hidden = true
          deps.state.addPersonSiteMenuId = undefined
          deps.state.temporaryPersonDrafts.splice(0)
        })
        .catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
    })

    deps.addTemporaryPersonFormEl.addEventListener('submit', event => {
      event.preventDefault()
      const draft = {
        name: deps.temporaryPersonNameEl.value.trim(),
        description: deps.temporaryPersonDescriptionEl.value.trim(),
        systemPrompt: deps.temporaryPersonPromptEl.value.trim(),
      }
      const validationError = validatePersonDraft(draft)
      if (validationError) {
        deps.showError(validationError)
        return
      }
      const id = `temporary-${Date.now()}-${Math.random().toString(16).slice(2)}`
      const store = deps.getStore()
      const chatSite = visibleChatSite(store.settings.defaultChatSite)
      deps.state.temporaryPersonDrafts.push({ id, ...draft, chatSite })
      deps.state.addPersonSiteByKey.set(`temporary:${id}`, new Set([chatSite]))
      closeTemporaryPersonDialog()
      renderAddPersonDialog()
    })

    deps.peopleLibraryFormEl.addEventListener('submit', event => {
      event.preventDefault()
      const draft = readTemplateDraft()
      const validationError = validatePersonDraft(draft)
      if (validationError) {
        deps.showError(validationError)
        return
      }
      const type = deps.state.selectedTemplateId ? 'ROLE_TEMPLATE_UPDATE' : 'ROLE_TEMPLATE_CREATE'
      const payload = deps.state.selectedTemplateId ? { templateId: deps.state.selectedTemplateId, ...draft } : draft
      deps.runCommand(type, payload)
        .then(closeTemplateEditor)
        .catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
    })
  }

  function templateCard(template: RoleTemplate): HTMLElement {
    const store = deps.getStore()
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
    used.className = `template-type-badge template-type-${template.type}`
    used.textContent = template.type === 'builtin' ? '内置' : '自定义'
    row.append(name, used)

    const description = document.createElement('div')
    description.className = 'template-description'
    description.textContent = template.description || '未填写人员库描述'
    const site = document.createElement('div')
    site.className = 'template-description'
    const defaultChatSite = visibleChatSite(template.defaultChatSite ?? store.settings.defaultChatSite)
    site.textContent = `默认站点：${siteLabel(defaultChatSite)}${defaultChatSite === 'chatgpt' && template.chatGptGptsUrl ? ' · GPTs' : ''}`
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
    if (template.type !== 'builtin') {
      actions.append(edit)
    }

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'btn btn-danger template-delete'
    remove.textContent = '删除'
    remove.addEventListener('click', event => {
      event.stopPropagation()
      deleteTemplate(template)
    })
    if (template.type !== 'builtin') {
      if (!isTemplateUsed(template.id)) actions.append(remove)
    }

    card.append(body, actions)
    return card
  }

  function pagedTemplates(templates: RoleTemplate[]): RoleTemplate[] {
    const pageCount = Math.max(1, Math.ceil(templates.length / PEOPLE_LIBRARY_PAGE_SIZE))
    deps.state.peopleLibraryPage = Math.min(Math.max(0, deps.state.peopleLibraryPage), pageCount - 1)
    const start = deps.state.peopleLibraryPage * PEOPLE_LIBRARY_PAGE_SIZE
    return templates.slice(start, start + PEOPLE_LIBRARY_PAGE_SIZE)
  }

  function renderPeopleLibraryPagination(total: number): void {
    const pageCount = Math.max(1, Math.ceil(total / PEOPLE_LIBRARY_PAGE_SIZE))
    if (pageCount <= 1) return

    const previous = paginationButton('上一页', deps.state.peopleLibraryPage === 0, () => {
      deps.state.peopleLibraryPage = Math.max(0, deps.state.peopleLibraryPage - 1)
      renderTemplates()
    })
    const next = paginationButton('下一页', deps.state.peopleLibraryPage >= pageCount - 1, () => {
      deps.state.peopleLibraryPage = Math.min(pageCount - 1, deps.state.peopleLibraryPage + 1)
      renderTemplates()
    })
    const label = document.createElement('span')
    label.className = 'pagination-label'
    label.textContent = `${deps.state.peopleLibraryPage + 1} / ${pageCount}`
    deps.peopleLibraryPaginationEl.append(previous, label, next)
  }

  function paginationButton(label: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'btn btn-ghost pagination-btn'
    button.textContent = label
    button.disabled = disabled
    button.addEventListener('click', onClick)
    return button
  }

  function renderAddPersonDialog(): void {
    ensureAddPersonTemplateTypeHasItems()
    syncAddPersonTypeTabs()
    const items = filteredAddPersonItems()
    deps.addLibraryPeopleListEl.replaceChildren()
    if (items.length === 0) {
      deps.addLibraryPeopleListEl.append(deps.emptyCard(
        deps.state.addPersonSearchQuery.trim() ? `没有匹配的${deps.state.addPersonTemplateType === 'builtin' ? '内置' : '自定义'}人员` : `暂无${deps.state.addPersonTemplateType === 'builtin' ? '内置' : '自定义'}人员`,
        deps.state.addPersonTemplateType === 'builtin' ? '可以切换到自定义人员，或调整搜索词。' : '先在人员库中新建人员，或点击右上角临时添加。',
      ))
      return
    }

    for (const item of items) {
      const label = document.createElement('div')
      label.className = 'select-row'
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.value = item.key
      checkbox.disabled = item.chatSites.length === 0
      const content = document.createElement('span')
      content.className = 'select-row-content'
      const name = document.createElement('strong')
      name.textContent = item.name
      const description = document.createElement('div')
      description.className = 'template-description'
      description.textContent = item.description || '未填写描述'
      const site = document.createElement('div')
      site.className = 'template-description'
      site.textContent = item.chatSites.length === 0 ? '所有可用站点已添加' : item.source === 'temporary' ? '临时人员' : templateTypeLabel(item.type)
      content.append(name, description, site)
      label.append(checkbox, content, addPersonSiteControl(item.key, item.chatSites, item.disabledSites))
      deps.addLibraryPeopleListEl.append(label)
    }
  }

  function addPersonItems(): AddPersonItem[] {
    const store = deps.getStore()
    const libraryItems = deps.getTemplates().map(template => {
      const key = `library:${template.id}`
      const disabledSites = usedLibrarySites(template)
      const chatSites = selectedAddPersonSites(key, template.defaultChatSite ?? store.settings.defaultChatSite, disabledSites)
      return {
        key,
        source: 'library' as const,
        type: template.type,
        roleTemplateId: template.id,
        name: template.name,
        description: template.description,
        systemPrompt: template.systemPrompt,
        chatSites,
        disabledSites,
      }
    })
    const temporaryItems = deps.state.temporaryPersonDrafts.map(draft => {
      const key = `temporary:${draft.id}`
      const disabledSites = usedNameSites(draft.name)
      const chatSites = selectedAddPersonSites(key, draft.chatSite, disabledSites)
      return {
        key,
        source: 'temporary' as const,
        type: 'custom' as const,
        draftId: draft.id,
        name: draft.name,
        description: draft.description,
        systemPrompt: draft.systemPrompt,
        chatSites,
        disabledSites,
      }
    })
    return [...libraryItems, ...temporaryItems]
  }

  function filteredAddPersonItems(): AddPersonItem[] {
    return addPersonItems().filter(item => item.type === deps.state.addPersonTemplateType && matchesAddPersonSearch(item))
  }

  function ensureAddPersonTemplateTypeHasItems(): void {
    if (deps.state.addPersonSearchQuery.trim()) return
    const items = addPersonItems()
    if (items.some(item => item.type === deps.state.addPersonTemplateType)) return
    const fallbackType = deps.state.addPersonTemplateType === 'builtin' ? 'custom' : 'builtin'
    if (items.some(item => item.type === fallbackType)) deps.state.addPersonTemplateType = fallbackType
  }

  function matchesAddPersonSearch(item: AddPersonItem): boolean {
    const query = deps.state.addPersonSearchQuery.trim().toLowerCase()
    if (!query) return true
    return [
      item.name,
      item.description ?? '',
      item.systemPrompt,
    ].some(value => value.toLowerCase().includes(query))
  }

  function syncAddPersonTypeTabs(): void {
    const builtinActive = deps.state.addPersonTemplateType === 'builtin'
    deps.addPersonBuiltinTabEl.className = `template-type-tab${builtinActive ? ' active' : ''}`
    deps.addPersonCustomTabEl.className = `template-type-tab${builtinActive ? '' : ' active'}`
    deps.addPersonBuiltinTabEl.setAttribute('aria-selected', String(builtinActive))
    deps.addPersonCustomTabEl.setAttribute('aria-selected', String(!builtinActive))
  }

  function addPersonSiteControl(itemKey: string, chatSites: ChatSite[], disabledSites: Set<ChatSite>): HTMLElement {
    const control = document.createElement('div')
    control.className = 'role-site-control add-person-site-control'
    const selectedSites = new Set(chatSites)
    for (const site of VISIBLE_CHAT_SITES) {
      const option = document.createElement('label')
      option.className = `site-pill site-pill-${site} add-person-site-option${selectedSites.has(site) ? ' active' : ''}${disabledSites.has(site) ? ' disabled' : ''}`
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.value = site
      input.checked = selectedSites.has(site)
      input.disabled = disabledSites.has(site)
      input.addEventListener('change', event => {
        event.stopPropagation()
        if (disabledSites.has(site)) return
        const nextSites = new Set(selectedAddPersonSites(itemKey, site, disabledSites))
        if (input.checked) {
          nextSites.add(site)
        } else if (nextSites.size > 1) {
          nextSites.delete(site)
        } else {
          input.checked = true
          return
        }
        deps.state.addPersonSiteByKey.set(itemKey, nextSites)
        renderAddPersonDialog()
      })
      option.append(input, document.createTextNode(siteLabel(site)))
      control.append(option)
    }
    return control
  }

  function selectedAddPersonSites(itemKey: string, fallbackSite: ChatSite, disabledSites = new Set<ChatSite>()): ChatSite[] {
    const selectedSites = deps.state.addPersonSiteByKey.get(itemKey)
    const visibleSelectedSites = selectedSites ? VISIBLE_CHAT_SITES.filter(site => selectedSites.has(site) && !disabledSites.has(site)) : []
    if (visibleSelectedSites.length > 0) return visibleSelectedSites

    const fallback = visibleChatSite(fallbackSite)
    const nextSite = disabledSites.has(fallback) ? VISIBLE_CHAT_SITES.find(site => !disabledSites.has(site)) : fallback
    if (!nextSite) {
      deps.state.addPersonSiteByKey.set(itemKey, new Set())
      return []
    }
    deps.state.addPersonSiteByKey.set(itemKey, new Set([nextSite]))
    return [nextSite]
  }

  function usedLibrarySites(template: RoleTemplate): Set<ChatSite> {
    const chat = deps.getCurrentChat()
    if (!chat) return new Set()
    const store = deps.getStore()
    return new Set(chat.roleIds
      .map(roleId => store.rolesById[roleId])
      .filter(role => role?.templateId === template.id)
      .map(role => visibleChatSite(role.chatSite ?? store.settings.defaultChatSite)))
  }

  function usedNameSites(name: string): Set<ChatSite> {
    const chat = deps.getCurrentChat()
    if (!chat) return new Set()
    const store = deps.getStore()
    return new Set(chat.roleIds
      .map(roleId => store.rolesById[roleId])
      .filter(role => role?.name.trim().toLowerCase() === name.trim().toLowerCase())
      .map(role => visibleChatSite(role.chatSite ?? store.settings.defaultChatSite)))
  }

  function readTemplateDraft(): TemplateDraft {
    return {
      name: deps.templateNameEl.value.trim(),
      description: deps.templateDescriptionEl.value.trim(),
      systemPrompt: deps.templatePromptEl.value.trim(),
      defaultChatSite: readTemplateChatSite(),
      chatGptGptsUrl: deps.templateSiteChatGptEl.checked ? deps.templateChatGptGptsUrlEl.value.trim() : undefined,
    }
  }

  function validatePersonDraft(draft: Pick<TemplateDraft, 'name' | 'description' | 'systemPrompt'>): string | undefined {
    if (!draft.name) return '人员名称不能为空'
    if (Array.from(draft.name).length > 10) return '人员名称最多 10 个字'
    return undefined
  }

  function selectedAddPersonItems(): Record<string, unknown>[] {
    const checkedKeys = new Set(Array.from(deps.addLibraryPeopleListEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')).map(input => input.value))
    return addPersonItems().filter(item => checkedKeys.has(item.key)).flatMap(item => item.chatSites.map(chatSite => {
      if (item.source === 'library') return { source: 'library', roleTemplateId: item.roleTemplateId, chatSite }
      return {
        source: 'temporary',
        name: item.name,
        description: item.description,
        systemPrompt: item.systemPrompt,
        chatSite,
      }
    }))
  }

  function readTemplateChatSite(): ChatSite {
    if (deps.templateSiteChatGptEl.checked) return 'chatgpt'
    if (deps.templateSiteClaudeEl.checked) return 'claude'
    if (deps.templateSiteDeepSeekEl.checked) return 'deepseek'
    return 'gemini'
  }

  function syncTemplateChatGptGptsField(): void {
    const visible = deps.templateSiteChatGptEl.checked
    deps.templateChatGptGptsFieldEl.hidden = !visible
    deps.templateChatGptGptsFieldEl.style.display = visible ? '' : 'none'
    if (!visible) deps.templateChatGptGptsUrlEl.value = ''
  }

  function templateSiteInputs(): HTMLInputElement[] {
    return [
      deps.templateSiteGeminiEl,
      deps.templateSiteChatGptEl,
      deps.templateSiteClaudeEl,
      deps.templateSiteDeepSeekEl,
      deps.templateSiteQwenEl,
      deps.templateSiteKimiEl,
    ]
  }

  async function addPeopleToCurrentChat(items: Record<string, unknown>[]): Promise<void> {
    const chat = deps.getCurrentChat()
    if (!chat) return
    if (items.length === 0) throw new Error('请选择或填写要添加的人员')
    await deps.runCommand('GROUP_ROLES_CREATE_BATCH', { chatId: chat.id, items })
  }

  function deleteTemplate(template: RoleTemplate): void {
    if (isTemplateUsed(template.id)) return
    if (!window.confirm(`确定删除「${template.name}」吗？删除后这个人员会从人员库移除。`)) return
    if (deps.state.selectedTemplateId === template.id) closeTemplateEditor()
    deps.runCommand('ROLE_TEMPLATE_DELETE', { templateId: template.id }).catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
  }

  function isTemplateUsed(templateId: string): boolean {
    return Object.values(deps.getStore().rolesById).some(role => role.templateId === templateId)
  }

  return { closePeopleModals, openAddPersonDialog, registerPeopleLibraryEvents, renderAddPersonDialog, renderTemplates }
}

function siteLabel(site: ChatSite | undefined): string {
  if (site === 'chatgpt') return 'ChatGPT'
  if (site === 'claude') return 'Claude'
  if (site === 'deepseek') return 'DeepSeek'
  if (site === 'kimi') return 'Kimi'
  if (site === 'qwen') return '千问'
  return 'Gemini'
}

function templateTypeLabel(type: RoleTemplate['type']): string {
  return type === 'builtin' ? '内置人员' : '自定义人员'
}

function visibleChatSite(site: ChatSite | undefined): ChatSite {
  return site && VISIBLE_CHAT_SITES.includes(site as typeof VISIBLE_CHAT_SITES[number]) ? site : 'gemini'
}
