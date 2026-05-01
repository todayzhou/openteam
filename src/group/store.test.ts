import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CURRENT_STORE_VERSION, STORE_KEY, createDefaultStore, loadStore, updateStoreQueued } from './store'
import type { OpenTeamStore } from './types'

describe('group store', () => {
  let stored: Record<string, unknown>

  beforeEach(() => {
    stored = {}
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
          set: vi.fn(async (items: Record<string, unknown>) => {
            await Promise.resolve()
            stored = { ...stored, ...structuredClone(items) }
          }),
        },
      },
    })
  })

  it('creates the default store shape', () => {
    expect(createDefaultStore()).toEqual({
      version: CURRENT_STORE_VERSION,
      chatOrder: [],
      chatsById: {},
      rolesById: {},
      messagesById: {},
      roleTemplateOrder: [],
      roleTemplatesById: {},
      settings: {
        defaultMode: 'independent',
        maxContextChars: 6000,
      },
    })
  })

  it('loads a default store when storage is empty', async () => {
    await expect(loadStore()).resolves.toEqual(createDefaultStore())
  })

  it('merges missing keys with defaults when loading stored data', async () => {
    stored[STORE_KEY] = {
      currentChatId: 'chat-1',
      chatOrder: ['chat-1'],
      chatsById: {
        'chat-1': {
          id: 'chat-1',
          name: 'Planning',
          mode: 'collaborative',
          roleIds: [],
          messageIds: [],
          nextMessageSeq: 1,
          status: 'ready',
          createdAt: 1,
          updatedAt: 1,
        },
      },
      settings: {
        defaultMode: 'collaborative',
      },
    }

    await expect(loadStore()).resolves.toMatchObject({
      version: CURRENT_STORE_VERSION,
      currentChatId: 'chat-1',
      chatOrder: ['chat-1'],
      rolesById: {},
      messagesById: {},
      roleTemplateOrder: [],
      roleTemplatesById: {},
      settings: {
        defaultMode: 'collaborative',
        maxContextChars: 6000,
      },
    })
  })

  it('serializes queued updates so concurrent writes are preserved', async () => {
    const addChat = (id: string) =>
      updateStoreQueued((draft: OpenTeamStore) => {
        draft.chatOrder.push(id)
        draft.chatsById[id] = {
          id,
          name: id,
          mode: 'independent',
          roleIds: [],
          messageIds: [],
          nextMessageSeq: 1,
          status: 'draft',
          createdAt: 1,
          updatedAt: 1,
        }
      })

    await Promise.all([addChat('chat-1'), addChat('chat-2'), addChat('chat-3')])

    const store = stored[STORE_KEY] as OpenTeamStore
    expect(store.chatOrder).toEqual(['chat-1', 'chat-2', 'chat-3'])
    expect(Object.keys(store.chatsById)).toEqual(['chat-1', 'chat-2', 'chat-3'])
  })
})
