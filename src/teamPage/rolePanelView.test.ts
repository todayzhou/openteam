import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('team page role panel view boundary', () => {
  it('keeps role panel rendering and role site switching outside the entrypoint', () => {
    const entrySource = readFileSync(resolve(process.cwd(), 'src/teamPage/index.ts'), 'utf8')
    const viewSource = readFileSync(resolve(process.cwd(), 'src/teamPage/rolePanelView.ts'), 'utf8')

    expect(viewSource).toContain('function renderRolePanel(): void')
    expect(viewSource).toContain('function roleCard(role: GroupRole): HTMLElement')
    expect(viewSource).toContain('function roleSiteControl(role: GroupRole): HTMLElement')
    expect(viewSource).toContain('function roleSiteMenu(role: GroupRole): HTMLElement')
    expect(viewSource).toContain('function switchRoleSite(role: GroupRole, chatSite: ChatSite): Promise<void>')
    expect(entrySource).not.toContain('function renderRolePanel(): void')
    expect(entrySource).not.toContain('function roleCard(role: GroupRole): HTMLElement')
    expect(entrySource).not.toContain('function roleSiteControl(role: GroupRole): HTMLElement')
    expect(entrySource).not.toContain('function roleSiteMenu(role: GroupRole): HTMLElement')
    expect(entrySource).not.toContain('function switchRoleSite(role: GroupRole, chatSite: ChatSite): Promise<void>')
  })
})
