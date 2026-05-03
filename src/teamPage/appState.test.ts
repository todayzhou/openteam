import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('team page app state', () => {
  it('initializes mutable UI state with a default store and empty selections', async () => {
    const { createTeamPageState } = await import('./appState')
    const state = createTeamPageState()

    expect(state.store.version).toBeGreaterThan(0)
    expect(state.selectedChatId).toBeUndefined()
    expect(state.selectedReference).toBeUndefined()
    expect(state.mentionIndex).toBe(0)
    expect(state.peopleDrawerOpen).toBe(false)
    expect(state.messageNodeCache.size).toBe(0)
    expect(state.temporaryPersonDrafts).toEqual([])
  })

  it('keeps mutable page state declarations out of the team page entrypoint', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/index.ts'), 'utf8')
    const messagesSource = readFileSync(resolve(process.cwd(), 'src/teamPage/messagesView.ts'), 'utf8')
    const localStateDeclarations = [
      'let selectedChatId',
      'let selectedRoleId',
      'let selectedTemplateId',
      'let selectedReference',
      'let mentionIndex',
      'let peopleDrawerOpen',
      'let chatMenuChatId',
      'let roleSiteMenuRoleId',
      'let addPersonSiteMenuId',
      'let pendingSwitchAnimationFrame',
      'let thinkingTimeoutTimers',
      'const loggedThinkingTimeoutRoleIds',
      'const messageNodeCache',
      'const reconnectingRoleKeys',
      'const roleReadyWaiters',
      'const temporaryPersonDrafts',
      'const addPersonSiteByKey',
    ]

    for (const declaration of localStateDeclarations) {
      expect(source).not.toContain(declaration)
    }
    expect(source).toContain('appState.selectedChatId')
    expect(messagesSource).toContain('deps.state.messageNodeCache')
  })
})
