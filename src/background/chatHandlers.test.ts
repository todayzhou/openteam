import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore } from '../group/types'

describe('background chat handlers', () => {
  it('exposes group chat routes and creates a chat through the injected runtime dependencies', async () => {
    vi.resetModules()
    let draftStore: OpenTeamStore | undefined
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const store = createDefaultStore()
          const result = await mutator(store)
          draftStore = store
          return { store, result }
        }),
      }
    })

    const { CHAT_ROUTE_TYPES, createChatHandlers } = await import('./chatHandlers')
    const broadcastStoreUpdated = vi.fn()
    const routes = createChatHandlers({
      broadcastStoreUpdated,
      getChatStatusFromRoles: () => 'ready',
      log: { info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: { removeRole: vi.fn() },
    })

    expect(CHAT_ROUTE_TYPES).toEqual([
      'GROUP_CHAT_CREATE',
      'GROUP_CHAT_DUPLICATE',
      'GROUP_CHAT_SWITCH',
      'GROUP_CHAT_UPDATE',
      'GROUP_CHAT_DELETE',
      'GROUP_CHAT_CLEAR_MESSAGES',
      'GROUP_CHAT_CLOSE',
      'GROUP_CHAT_MARK_READ',
    ])
    expect(routes.map(route => route.type)).toEqual(CHAT_ROUTE_TYPES)

    const createRoute = routes.find(route => route.type === 'GROUP_CHAT_CREATE')
    const response = await createRoute?.handler({ type: 'GROUP_CHAT_CREATE', name: '架构评审' }, {})

    expect(response).toMatchObject({
      ok: true,
      chat: { id: 'chat-1', name: '架构评审', status: 'draft' },
    })
    expect(draftStore?.currentChatId).toBe('chat-1')
    expect(broadcastStoreUpdated).toHaveBeenCalledWith(expect.objectContaining({ currentChatId: 'chat-1' }))
  })
})
