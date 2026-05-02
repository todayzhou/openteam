import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CURRENT_STORE_VERSION,
  MESSAGE_CHUNK_SIZE,
  META_STORE_KEY,
  STORE_KEY,
  chatStorageKey,
  createDefaultStore,
  loadStore,
  messageChunkStorageKey,
  saveStore,
  updateStoreQueued,
} from './store'
import type { GroupMessage, OpenTeamStore } from './types'

describe('group store', () => {
  let stored: Record<string, unknown>

  beforeEach(() => {
    stored = {}
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key?: string | string[] | null) => {
            if (key === null || typeof key === 'undefined') {
              return structuredClone(stored)
            }
            if (Array.isArray(key)) {
              return Object.fromEntries(key.map(item => [item, structuredClone(stored[item])]))
            }
            return { [key]: structuredClone(stored[key]) }
          }),
          set: vi.fn(async (items: Record<string, unknown>) => {
            await Promise.resolve()
            stored = { ...stored, ...structuredClone(items) }
          }),
          remove: vi.fn(async (keys: string | string[]) => {
            const next = { ...stored }
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              delete next[key]
            }
            stored = next
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
      viewState: {
        chatReadSeqById: {},
        chatHasNewMessageById: {},
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

  it('migrates the legacy single-key store into split storage', async () => {
    stored[STORE_KEY] = {
      version: 1,
      currentChatId: 'chat-1',
      chatOrder: ['chat-1'],
      chatsById: {
        'chat-1': {
          id: 'chat-1',
          name: 'Planning',
          mode: 'collaborative',
          roleIds: ['role-1'],
          messageIds: ['msg-1'],
          nextMessageSeq: 2,
          status: 'ready',
          createdAt: 1,
          updatedAt: 1,
        },
      },
      rolesById: {
        'role-1': {
          id: 'role-1',
          chatId: 'chat-1',
          name: '工程师',
          status: 'ready',
          contextCursor: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      },
      messagesById: {
        'msg-1': makeMessage('chat-1', 'msg-1', 1),
      },
      settings: {
        defaultMode: 'collaborative',
      },
    }

    const store = await loadStore()

    expect(store).toMatchObject({
      version: CURRENT_STORE_VERSION,
      currentChatId: 'chat-1',
      chatOrder: ['chat-1'],
      chatsById: {
        'chat-1': {
          messageIds: ['msg-1'],
        },
      },
      rolesById: {
        'role-1': {
          name: '工程师',
        },
      },
      messagesById: {
        'msg-1': {
          content: 'message-1',
        },
      },
    })
    expect(stored[STORE_KEY]).toBeUndefined()
    expect(stored[META_STORE_KEY]).toBeDefined()
    expect(stored[chatStorageKey('chat-1')]).toBeDefined()
    expect(stored[messageChunkStorageKey('chat-1', '000001')]).toBeDefined()
  })

  it('saves chat messages in chunks instead of the legacy whole-store key', async () => {
    const store = createDefaultStore()
    const messages = Array.from({ length: MESSAGE_CHUNK_SIZE + 5 }, (_, index) => makeMessage('chat-1', `msg-${index + 1}`, index + 1))
    store.currentChatId = 'chat-1'
    store.chatOrder = ['chat-1']
    store.chatsById['chat-1'] = {
      id: 'chat-1',
      name: 'Planning',
      mode: 'independent',
      roleIds: [],
      messageIds: messages.map(message => message.id),
      nextMessageSeq: messages.length + 1,
      status: 'ready',
      createdAt: 1,
      updatedAt: 1,
    }
    store.messagesById = Object.fromEntries(messages.map(message => [message.id, message]))

    await saveStore(store)

    const chatDocument = stored[chatStorageKey('chat-1')] as { messageChunkIds: string[]; messageCount: number }
    const firstChunk = stored[messageChunkStorageKey('chat-1', '000001')] as { messages: GroupMessage[] }
    const secondChunk = stored[messageChunkStorageKey('chat-1', '000002')] as { messages: GroupMessage[] }

    expect(stored[STORE_KEY]).toBeUndefined()
    expect(chatDocument.messageCount).toBe(MESSAGE_CHUNK_SIZE + 5)
    expect(chatDocument.messageChunkIds).toEqual(['000001', '000002'])
    expect(firstChunk.messages).toHaveLength(MESSAGE_CHUNK_SIZE)
    expect(secondChunk.messages).toHaveLength(5)
    await expect(loadStore()).resolves.toMatchObject({
      chatOrder: ['chat-1'],
      chatsById: {
        'chat-1': {
          messageIds: messages.map(message => message.id),
        },
      },
    })
  })

  it('removes stale split-storage keys after a chat is deleted', async () => {
    const store = createDefaultStore()
    store.chatOrder = ['chat-1', 'chat-2']
    store.chatsById['chat-1'] = makeChat('chat-1', ['msg-1'])
    store.chatsById['chat-2'] = makeChat('chat-2', ['msg-2'])
    store.messagesById['msg-1'] = makeMessage('chat-1', 'msg-1', 1)
    store.messagesById['msg-2'] = makeMessage('chat-2', 'msg-2', 1)
    await saveStore(store)

    delete store.chatsById['chat-1']
    delete store.messagesById['msg-1']
    store.chatOrder = ['chat-2']
    await saveStore(store)

    expect(stored[chatStorageKey('chat-1')]).toBeUndefined()
    expect(stored[messageChunkStorageKey('chat-1', '000001')]).toBeUndefined()
    expect(stored[chatStorageKey('chat-2')]).toBeDefined()
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

    const store = await loadStore()
    expect(store.chatOrder).toEqual(['chat-1', 'chat-2', 'chat-3'])
    expect(Object.keys(store.chatsById)).toEqual(['chat-1', 'chat-2', 'chat-3'])
  })
})

function makeChat(id: string, messageIds: string[] = []): OpenTeamStore['chatsById'][string] {
  return {
    id,
    name: id,
    mode: 'independent',
    roleIds: [],
    messageIds,
    nextMessageSeq: messageIds.length + 1,
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
  }
}

function makeMessage(chatId: string, id: string, seq: number): GroupMessage {
  return {
    id,
    chatId,
    seq,
    type: 'user',
    content: `message-${seq}`,
    createdAt: seq,
    status: 'sent',
  }
}
