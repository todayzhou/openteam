// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { GroupChat, OpenTeamStore, RoleTemplate } from '../group/types'
import { createTeamPageState } from './appState'
import { createPeopleLibraryView } from './peopleLibraryView'

function makeTemplate(index: number): RoleTemplate {
  return {
    id: `template-${index}`,
    type: 'custom',
    name: `人员${index}`,
    description: `描述${index}`,
    defaultChatSite: 'gemini',
    systemPrompt: `提示词${index}`,
    createdAt: index,
    updatedAt: index,
  }
}

function makeChat(id: string): GroupChat {
  return {
    id,
    name: '群聊',
    mode: 'independent',
    roleIds: [],
    messageIds: [],
    nextMessageSeq: 1,
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
  }
}

function setupPeopleLibraryView(options: { store: OpenTeamStore; templates: RoleTemplate[]; currentChat?: GroupChat }) {
  const addLibraryPeopleListEl = document.createElement('div')
  const addLibraryPeopleFormEl = document.createElement('form')
  const addPersonSearchEl = document.createElement('input')
  const addPersonBuiltinTabEl = document.createElement('button')
  const addPersonCustomTabEl = document.createElement('button')
  const peopleLibraryListEl = document.createElement('div')
  const peopleLibraryPaginationEl = document.createElement('div')
  const templateListEl = document.createElement('div')
  const templateSiteChatGptEl = document.createElement('input')
  const templateChatGptGptsFieldEl = Object.assign(document.createElement('div'), { hidden: true })
  const templateChatGptGptsUrlEl = document.createElement('input')
  const templateNameEl = document.createElement('input')
  const templateDescriptionEl = document.createElement('textarea')
  const templatePromptEl = document.createElement('textarea')
  const peopleLibraryFormEl = document.createElement('form')
  const runCommand = vi.fn(async () => undefined)
  const view = createPeopleLibraryView({
    state: createTeamPageState(),
    getStore: () => options.store,
    settingsButtonEl: document.createElement('button'),
    settingsMenuEl: document.createElement('div'),
    openPeopleLibraryEl: document.createElement('button'),
    closePeopleLibraryEl: document.createElement('button'),
    peopleLibraryModalEl: document.createElement('div'),
    personTemplateModalEl: Object.assign(document.createElement('div'), { hidden: true }),
    addPersonModalEl: document.createElement('div'),
    temporaryPersonModalEl: document.createElement('div'),
    peopleLibrarySummaryEl: document.createElement('div'),
    peopleLibraryListEl,
    peopleLibraryPaginationEl,
    addLibraryPeopleListEl,
    addPersonSearchEl,
    addPersonBuiltinTabEl,
    addPersonCustomTabEl,
    roleTemplateSelectEl: document.createElement('select'),
    templateListEl,
    templateNameEl,
    templateDescriptionEl,
    templatePromptEl,
    templateFormTitleEl: document.createElement('div'),
    templateSiteGeminiEl: document.createElement('input'),
    templateSiteChatGptEl,
    templateSiteClaudeEl: document.createElement('input'),
    templateSiteDeepSeekEl: document.createElement('input'),
    templateSiteQwenEl: document.createElement('input'),
    templateSiteKimiEl: document.createElement('input'),
    templateChatGptGptsFieldEl,
    templateChatGptGptsUrlEl,
    temporaryPersonNameEl: document.createElement('input'),
    temporaryPersonDescriptionEl: document.createElement('textarea'),
    temporaryPersonPromptEl: document.createElement('textarea'),
    newTemplateEl: document.createElement('button'),
    closePersonTemplateEl: document.createElement('button'),
    closeAddPersonEl: document.createElement('button'),
    openTemporaryPersonEl: document.createElement('button'),
    closeTemporaryPersonEl: document.createElement('button'),
    addRoleFormEl: document.createElement('form'),
    addLibraryPeopleFormEl,
    addTemporaryPersonFormEl: document.createElement('form'),
    peopleLibraryFormEl,
    getCurrentChat: () => options.currentChat,
    getTemplates: () => options.templates,
    emptyCard: (title: string, body: string) => {
      const element = document.createElement('div')
      element.textContent = `${title}${body}`
      return element
    },
    runCommand,
    showError: vi.fn(),
    log: { info: vi.fn() },
  })
  return {
    view,
    addLibraryPeopleFormEl,
    addLibraryPeopleListEl,
    addPersonSearchEl,
    addPersonBuiltinTabEl,
    addPersonCustomTabEl,
    peopleLibraryListEl,
    peopleLibraryPaginationEl,
    runCommand,
    templateListEl,
    templateNameEl,
    templateDescriptionEl,
    templatePromptEl,
    templateSiteChatGptEl,
    templateChatGptGptsFieldEl,
    templateChatGptGptsUrlEl,
    peopleLibraryFormEl,
  }
}

describe('team page people library view boundary', () => {
  it('keeps people library rendering, add-person dialogs, and template edits outside the entrypoint', () => {
    const entrySource = readFileSync(resolve(process.cwd(), 'src/teamPage/index.ts'), 'utf8')
    const viewSource = readFileSync(resolve(process.cwd(), 'src/teamPage/peopleLibraryView.ts'), 'utf8')

    expect(viewSource).toContain('function renderTemplates(): void')
    expect(viewSource).toContain('function renderTemplateEditor(): void')
    expect(viewSource).toContain('function openAddPersonDialog(): void')
    expect(viewSource).toContain('function renderAddPersonDialog(): void')
    expect(viewSource).toContain('function addPersonItems(): AddPersonItem[]')
    expect(viewSource).toContain('function selectedAddPersonItems(): Record<string, unknown>[]')
    expect(viewSource).toContain('function registerPeopleLibraryEvents(): void')
    expect(entrySource).not.toContain('function renderTemplates(): void')
    expect(entrySource).not.toContain('function renderTemplateEditor(): void')
    expect(entrySource).not.toContain('function openAddPersonDialog(): void')
    expect(entrySource).not.toContain('function renderAddPersonDialog(): void')
    expect(entrySource).not.toContain('function addPersonItems(): AddPersonItem[]')
    expect(entrySource).not.toContain('function selectedAddPersonItems(): Record<string, unknown>[]')
  })

  it('renders five people library entries per page', () => {
    const templates = Array.from({ length: 6 }, (_, index) => makeTemplate(index + 1))
    const store: OpenTeamStore = {
      ...createDefaultStore(),
      roleTemplateOrder: templates.map(template => template.id),
      roleTemplatesById: Object.fromEntries(templates.map(template => [template.id, template])),
    }
    const { view, peopleLibraryListEl, peopleLibraryPaginationEl, templateListEl } = setupPeopleLibraryView({ store, templates })

    view.renderTemplates()

    expect(peopleLibraryListEl.querySelectorAll('.template-card')).toHaveLength(5)
    expect(templateListEl.querySelectorAll('.template-card')).toHaveLength(5)
    expect(peopleLibraryPaginationEl.textContent).toContain('1 / 2')
  })

  it('submits one library person once for every selected chat site', async () => {
    const template = makeTemplate(1)
    const chat = makeChat('chat-1')
    const store: OpenTeamStore = {
      ...createDefaultStore(),
      currentChatId: chat.id,
      chatOrder: [chat.id],
      chatsById: { [chat.id]: chat },
      roleTemplateOrder: [template.id],
      roleTemplatesById: { [template.id]: template },
    }
    const { view, addLibraryPeopleFormEl, addLibraryPeopleListEl, runCommand } = setupPeopleLibraryView({ store, templates: [template], currentChat: chat })

    view.registerPeopleLibraryEvents()
    view.renderAddPersonDialog()
    const claudeSite = addLibraryPeopleListEl.querySelector<HTMLInputElement>('input[type="checkbox"][value="claude"]')!
    claudeSite.checked = true
    claudeSite.dispatchEvent(new Event('change', { bubbles: true }))
    addLibraryPeopleListEl.querySelector<HTMLInputElement>('input[type="checkbox"][value="library:template-1"]')!.checked = true
    addLibraryPeopleFormEl.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve()

    expect(runCommand).toHaveBeenCalledWith('GROUP_ROLES_CREATE_BATCH', {
      chatId: chat.id,
      items: [
        { source: 'library', roleTemplateId: template.id, chatSite: 'gemini' },
        { source: 'library', roleTemplateId: template.id, chatSite: 'claude' },
      ],
    })
  })

  it('submits a ChatGPT GPTs prefix when creating a library person', async () => {
    const store = createDefaultStore()
    const {
      view,
      runCommand,
      templateNameEl,
      templatePromptEl,
      templateSiteChatGptEl,
      templateChatGptGptsFieldEl,
      templateChatGptGptsUrlEl,
      peopleLibraryFormEl,
    } = setupPeopleLibraryView({ store, templates: [] })

    view.registerPeopleLibraryEvents()
    view.renderTemplates()
    templateNameEl.value = '飞飞教练'
    templatePromptEl.value = '以教练方式回应'
    templateSiteChatGptEl.checked = true
    templateSiteChatGptEl.dispatchEvent(new Event('change', { bubbles: true }))
    templateChatGptGptsUrlEl.value = 'https://chatgpt.com/g/g-LrdzaEiqT-fei-fei-jiao-lian/c/69f7fabe-9878-83a8-a867-88ebb36967d4'
    peopleLibraryFormEl.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve()

    expect(templateChatGptGptsFieldEl.hidden).toBe(false)
    expect(templateChatGptGptsFieldEl.style.display).toBe('')
    expect(runCommand).toHaveBeenCalledWith('ROLE_TEMPLATE_CREATE', {
      name: '飞飞教练',
      description: '',
      systemPrompt: '以教练方式回应',
      defaultChatSite: 'chatgpt',
      chatGptGptsUrl: 'https://chatgpt.com/g/g-LrdzaEiqT-fei-fei-jiao-lian/c/69f7fabe-9878-83a8-a867-88ebb36967d4',
    })
  })

  it('hides the ChatGPT GPTs prefix field when another site is selected', () => {
    const store = createDefaultStore()
    const {
      view,
      templateSiteChatGptEl,
      templateChatGptGptsFieldEl,
      templateChatGptGptsUrlEl,
    } = setupPeopleLibraryView({ store, templates: [] })

    view.registerPeopleLibraryEvents()
    view.renderTemplates()
    templateSiteChatGptEl.checked = false
    templateChatGptGptsUrlEl.value = 'https://chatgpt.com/g/g-LrdzaEiqT-fei-fei-jiao-lian'
    templateSiteChatGptEl.dispatchEvent(new Event('change', { bubbles: true }))

    expect(templateChatGptGptsFieldEl.hidden).toBe(true)
    expect(templateChatGptGptsFieldEl.style.display).toBe('none')
    expect(templateChatGptGptsUrlEl.value).toBe('')
  })

  it('submits library people with an empty persona', async () => {
    const store = createDefaultStore()
    const {
      view,
      runCommand,
      templateNameEl,
      templatePromptEl,
      peopleLibraryFormEl,
    } = setupPeopleLibraryView({ store, templates: [] })

    view.registerPeopleLibraryEvents()
    view.renderTemplates()
    templateNameEl.value = '观察员'
    templatePromptEl.value = ''
    peopleLibraryFormEl.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve()

    expect(runCommand).toHaveBeenCalledWith('ROLE_TEMPLATE_CREATE', {
      name: '观察员',
      description: '',
      systemPrompt: '',
      defaultChatSite: 'gemini',
      chatGptGptsUrl: undefined,
    })
  })

  it('renders built-in and custom template type badges and hides built-in delete actions', () => {
    const builtinTemplate: RoleTemplate = {
      id: 'builtin-frankl',
      type: 'builtin',
      name: '弗兰克尔',
      description: '意义顾问',
      defaultChatSite: 'gemini',
      systemPrompt: '弗兰克尔式意义顾问',
      createdAt: 0,
      updatedAt: 0,
    }
    const customTemplate = makeTemplate(1)
    const store: OpenTeamStore = {
      ...createDefaultStore(),
      roleTemplateOrder: [customTemplate.id],
      roleTemplatesById: { [customTemplate.id]: customTemplate },
    }
    const { view, peopleLibraryListEl } = setupPeopleLibraryView({ store, templates: [builtinTemplate, customTemplate] })

    view.renderTemplates()

    const cards = peopleLibraryListEl.querySelectorAll('.template-card')
    expect(cards).toHaveLength(2)
    expect(cards[0].textContent).toContain('内置')
    expect(cards[0].querySelector('.template-delete')).toBeNull()
    expect(cards[1].textContent).toContain('自定义')
    expect(cards[1].querySelector('.template-delete')).toBeDefined()
  })

  it('filters add-person choices by built-in and custom tabs', () => {
    const builtinTemplate: RoleTemplate = {
      id: 'builtin-frankl',
      type: 'builtin',
      name: '弗兰克尔',
      description: '意义顾问',
      defaultChatSite: 'gemini',
      systemPrompt: '弗兰克尔式意义顾问',
      createdAt: 0,
      updatedAt: 0,
    }
    const customTemplate = makeTemplate(1)
    const chat = makeChat('chat-1')
    const store: OpenTeamStore = {
      ...createDefaultStore(),
      currentChatId: chat.id,
      chatOrder: [chat.id],
      chatsById: { [chat.id]: chat },
      roleTemplateOrder: [customTemplate.id],
      roleTemplatesById: { [customTemplate.id]: customTemplate },
    }
    const { view, addLibraryPeopleListEl, addPersonBuiltinTabEl, addPersonCustomTabEl } = setupPeopleLibraryView({ store, templates: [builtinTemplate, customTemplate], currentChat: chat })

    view.registerPeopleLibraryEvents()
    view.renderAddPersonDialog()
    expect(addLibraryPeopleListEl.textContent).toContain('弗兰克尔')
    expect(addLibraryPeopleListEl.textContent).not.toContain('人员1')
    expect(addPersonBuiltinTabEl.className).toContain('active')

    addPersonCustomTabEl.click()
    expect(addLibraryPeopleListEl.textContent).toContain('人员1')
    expect(addLibraryPeopleListEl.textContent).not.toContain('弗兰克尔')
    expect(addPersonCustomTabEl.className).toContain('active')
  })

  it('searches add-person choices by name, description, and persona text', () => {
    const builtinTemplate: RoleTemplate = {
      id: 'builtin-frankl',
      type: 'builtin',
      name: '弗兰克尔',
      description: '意义顾问',
      defaultChatSite: 'gemini',
      systemPrompt: '苦难中的尊严',
      createdAt: 0,
      updatedAt: 0,
    }
    const camusTemplate: RoleTemplate = {
      id: 'builtin-camus',
      type: 'builtin',
      name: '加缪',
      description: '清醒生活',
      defaultChatSite: 'gemini',
      systemPrompt: '荒诞与反抗',
      createdAt: 0,
      updatedAt: 0,
    }
    const chat = makeChat('chat-1')
    const store: OpenTeamStore = {
      ...createDefaultStore(),
      currentChatId: chat.id,
      chatOrder: [chat.id],
      chatsById: { [chat.id]: chat },
    }
    const { view, addLibraryPeopleListEl, addPersonSearchEl } = setupPeopleLibraryView({ store, templates: [builtinTemplate, camusTemplate], currentChat: chat })

    view.registerPeopleLibraryEvents()
    view.renderAddPersonDialog()
    addPersonSearchEl.value = '荒诞'
    addPersonSearchEl.dispatchEvent(new Event('input', { bubbles: true }))
    expect(addLibraryPeopleListEl.textContent).toContain('加缪')
    expect(addLibraryPeopleListEl.textContent).not.toContain('弗兰克尔')

    addPersonSearchEl.value = '没有这个人'
    addPersonSearchEl.dispatchEvent(new Event('input', { bubbles: true }))
    expect(addLibraryPeopleListEl.textContent).toContain('没有匹配的内置人员')
  })
})
