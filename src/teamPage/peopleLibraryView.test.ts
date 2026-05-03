import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

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
})
