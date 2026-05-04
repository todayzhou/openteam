// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore, RoleTemplate } from '../group/types'
import { createTeamPageState } from './appState'
import { createPeopleLibraryView } from './peopleLibraryView'

function makeTemplate(index: number): RoleTemplate {
  return {
    id: `template-${index}`,
    name: `人员${index}`,
    description: `描述${index}`,
    defaultChatSite: 'gemini',
    systemPrompt: `提示词${index}`,
    createdAt: index,
    updatedAt: index,
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
    const peopleLibraryListEl = document.createElement('div')
    const peopleLibraryPaginationEl = document.createElement('div')
    const templateListEl = document.createElement('div')

    createPeopleLibraryView({
      state: createTeamPageState(),
      getStore: () => store,
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
      addLibraryPeopleListEl: document.createElement('div'),
      roleTemplateSelectEl: document.createElement('select'),
      templateListEl,
      templateNameEl: document.createElement('input'),
      templateDescriptionEl: document.createElement('textarea'),
      templatePromptEl: document.createElement('textarea'),
      templateFormTitleEl: document.createElement('div'),
      templateSiteGeminiEl: document.createElement('input'),
      templateSiteChatGptEl: document.createElement('input'),
      templateSiteClaudeEl: document.createElement('input'),
      templateSiteDeepSeekEl: document.createElement('input'),
      templateSiteQwenEl: document.createElement('input'),
      templateSiteKimiEl: document.createElement('input'),
      temporaryPersonNameEl: document.createElement('input'),
      temporaryPersonDescriptionEl: document.createElement('textarea'),
      temporaryPersonPromptEl: document.createElement('textarea'),
      newTemplateEl: document.createElement('button'),
      closePersonTemplateEl: document.createElement('button'),
      closeAddPersonEl: document.createElement('button'),
      openTemporaryPersonEl: document.createElement('button'),
      closeTemporaryPersonEl: document.createElement('button'),
      addRoleFormEl: document.createElement('form'),
      addLibraryPeopleFormEl: document.createElement('form'),
      addTemporaryPersonFormEl: document.createElement('form'),
      peopleLibraryFormEl: document.createElement('form'),
      getCurrentChat: () => undefined,
      getTemplates: () => templates,
      emptyCard: () => document.createElement('div'),
      runCommand: vi.fn(async () => undefined),
      showError: vi.fn(),
      log: { info: vi.fn() },
    }).renderTemplates()

    expect(peopleLibraryListEl.querySelectorAll('.template-card')).toHaveLength(5)
    expect(templateListEl.querySelectorAll('.template-card')).toHaveLength(5)
    expect(peopleLibraryPaginationEl.textContent).toContain('1 / 2')
  })
})
