import type { ChatSite, GroupChat, OpenTeamStore, RoleTemplate } from '../group/types'
import type { TeamPageState } from './appState'

type TemplateDraft = Pick<RoleTemplate, 'name' | 'description' | 'systemPrompt' | 'defaultChatSite'>
type AddPersonItem =
  | { key: string; source: 'library'; roleTemplateId: string; name: string; description?: string; chatSite: ChatSite }
  | { key: string; source: 'temporary'; draftId: string; name: string; description?: string; systemPrompt: string; chatSite: ChatSite }

const PEOPLE_LIBRARY_PAGE_SIZE = 8

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
      const defaultChatSite = selectedTemplate.defaultChatSite ?? store.settings.defaultChatSite
      deps.templateNameEl.value = selectedTemplate.name
      deps.templateDescriptionEl.value = selectedTemplate.description ?? ''
      deps.templatePromptEl.value = selectedTemplate.systemPrompt
      deps.templateSiteGeminiEl.checked = defaultChatSite === 'gemini'
      deps.templateSiteChatGptEl.checked = defaultChatSite === 'chatgpt'
      deps.templateSiteClaudeEl.checked = defaultChatSite === 'claude'
      deps.templateSiteDeepSeekEl.checked = defaultChatSite === 'deepseek'
    } else {
      deps.templateNameEl.value = ''
      deps.templateDescriptionEl.value = ''
      deps.templatePromptEl.value = ''
      deps.templateSiteGeminiEl.checked = store.settings.defaultChatSite === 'gemini'
      deps.templateSiteChatGptEl.checked = store.settings.defaultChatSite === 'chatgpt'
      deps.templateSiteClaudeEl.checked = store.settings.defaultChatSite === 'claude'
      deps.templateSiteDeepSeekEl.checked = store.settings.defaultChatSite === 'deepseek'
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

    deps.closeAddPersonEl.addEventListener('click', () => {
      deps.addPersonModalEl.hidden = true
      deps.state.addPersonSiteMenuId = undefined
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
      deps.state.temporaryPersonDrafts.push({ id, ...draft, chatSite: store.settings.defaultChatSite })
      deps.state.addPersonSiteByKey.set(`temporary:${id}`, store.settings.defaultChatSite)
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
    used.className = 'tiny'
    used.textContent = isTemplateUsed(template.id) ? '已被群聊使用' : '可删除'
    row.append(name, used)

    const description = document.createElement('div')
    description.className = 'template-description'
    description.textContent = template.description || '未填写人员库描述'
    const site = document.createElement('div')
    site.className = 'template-description'
    site.textContent = `默认站点：${siteLabel(template.defaultChatSite ?? store.settings.defaultChatSite)}`
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
    actions.append(edit)

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'btn btn-danger template-delete'
    remove.textContent = '删除'
    remove.addEventListener('click', event => {
      event.stopPropagation()
      deleteTemplate(template)
    })
    if (!isTemplateUsed(template.id)) actions.append(remove)

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
    const items = addPersonItems()
    deps.addLibraryPeopleListEl.replaceChildren()
    if (items.length === 0) {
      deps.addLibraryPeopleListEl.append(deps.emptyCard('暂无可选人员', '先在人员库中新建人员，或点击右上角临时添加。'))
      return
    }

    for (const item of items) {
      const label = document.createElement('label')
      label.className = 'select-row'
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.value = item.key
      const content = document.createElement('span')
      content.className = 'select-row-content'
      const name = document.createElement('strong')
      name.textContent = item.name
      const description = document.createElement('div')
      description.className = 'template-description'
      description.textContent = item.description || '未填写描述'
      const site = document.createElement('div')
      site.className = 'template-description'
      site.textContent = item.source === 'temporary' ? '临时人员' : '人员库'
      content.append(name, description, site)
      label.append(checkbox, content, addPersonSiteControl(item.key, item.chatSite))
      deps.addLibraryPeopleListEl.append(label)
    }
  }

  function addPersonItems(): AddPersonItem[] {
    const store = deps.getStore()
    const libraryItems = deps.getTemplates().map(template => {
      const key = `library:${template.id}`
      const chatSite = deps.state.addPersonSiteByKey.get(key) ?? template.defaultChatSite ?? store.settings.defaultChatSite
      deps.state.addPersonSiteByKey.set(key, chatSite)
      return {
        key,
        source: 'library' as const,
        roleTemplateId: template.id,
        name: template.name,
        description: template.description,
        chatSite,
      }
    })
    const temporaryItems = deps.state.temporaryPersonDrafts.map(draft => {
      const key = `temporary:${draft.id}`
      const chatSite = deps.state.addPersonSiteByKey.get(key) ?? draft.chatSite
      deps.state.addPersonSiteByKey.set(key, chatSite)
      return {
        key,
        source: 'temporary' as const,
        draftId: draft.id,
        name: draft.name,
        description: draft.description,
        systemPrompt: draft.systemPrompt,
        chatSite,
      }
    })
    return [...libraryItems, ...temporaryItems]
  }

  function addPersonSiteControl(itemKey: string, chatSite: ChatSite): HTMLElement {
    const control = document.createElement('div')
    control.className = 'role-site-control'
    const sitePill = document.createElement('button')
    sitePill.type = 'button'
    sitePill.className = `site-pill site-pill-${chatSite}`
    sitePill.setAttribute('aria-expanded', String(deps.state.addPersonSiteMenuId === itemKey))
    sitePill.textContent = siteLabel(chatSite)
    sitePill.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      deps.state.addPersonSiteMenuId = deps.state.addPersonSiteMenuId === itemKey ? undefined : itemKey
      renderAddPersonDialog()
    })
    control.append(sitePill)
    if (deps.state.addPersonSiteMenuId === itemKey) control.append(addPersonSiteMenu(itemKey, chatSite))
    return control
  }

  function addPersonSiteMenu(itemKey: string, currentSite: ChatSite): HTMLElement {
    const menu = document.createElement('div')
    menu.className = 'role-site-menu'
    menu.addEventListener('click', event => event.stopPropagation())
    for (const site of ['gemini', 'chatgpt', 'claude', 'deepseek'] as const) {
      const option = document.createElement('button')
      option.type = 'button'
      option.className = `role-site-option${currentSite === site ? ' active' : ''}`
      option.textContent = currentSite === site ? `✓ ${siteLabel(site)}` : siteLabel(site)
      option.addEventListener('click', event => {
        event.preventDefault()
        deps.state.addPersonSiteByKey.set(itemKey, site)
        deps.state.addPersonSiteMenuId = undefined
        renderAddPersonDialog()
      })
      menu.append(option)
    }
    return menu
  }

  function readTemplateDraft(): TemplateDraft {
    return {
      name: deps.templateNameEl.value.trim(),
      description: deps.templateDescriptionEl.value.trim(),
      systemPrompt: deps.templatePromptEl.value.trim(),
      defaultChatSite: readTemplateChatSite(),
    }
  }

  function validatePersonDraft(draft: Pick<TemplateDraft, 'name' | 'description' | 'systemPrompt'>): string | undefined {
    if (!draft.name) return '人员名称不能为空'
    if (Array.from(draft.name).length > 10) return '人员名称最多 10 个字'
    if (!draft.systemPrompt.trim()) return '人设不能为空'
    return undefined
  }

  function selectedAddPersonItems(): Record<string, unknown>[] {
    const checkedKeys = new Set(Array.from(deps.addLibraryPeopleListEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')).map(input => input.value))
    return addPersonItems().filter(item => checkedKeys.has(item.key)).map(item => {
      const chatSite = deps.state.addPersonSiteByKey.get(item.key) ?? item.chatSite
      if (item.source === 'library') return { source: 'library', roleTemplateId: item.roleTemplateId, chatSite }
      return {
        source: 'temporary',
        name: item.name,
        description: item.description,
        systemPrompt: item.systemPrompt,
        chatSite,
      }
    })
  }

  function readTemplateChatSite(): ChatSite {
    if (deps.templateSiteChatGptEl.checked) return 'chatgpt'
    if (deps.templateSiteClaudeEl.checked) return 'claude'
    if (deps.templateSiteDeepSeekEl.checked) return 'deepseek'
    return 'gemini'
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
  return 'Gemini'
}
