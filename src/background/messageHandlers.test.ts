import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { GroupChat, GroupRole, OpenTeamStore, RuntimeFrameBinding } from '../group/types'

function createStoreWithReadyRole(): OpenTeamStore {
  const store = createDefaultStore()
  const chat: GroupChat = {
    id: 'chat-1',
    name: '架构评审',
    mode: 'independent',
    roleIds: ['role-1'],
    messageIds: [],
    nextMessageSeq: 1,
    status: 'ready',
    createdAt: 0,
    updatedAt: 0,
  }
  const role: GroupRole = {
    id: 'role-1',
    chatId: chat.id,
    name: '工程师',
    systemPrompt: '从工程角度分析问题',
    status: 'ready',
    contextCursor: 0,
    createdAt: 0,
    updatedAt: 0,
  }
  store.currentChatId = chat.id
  store.chatOrder = [chat.id]
  store.chatsById[chat.id] = chat
  store.rolesById[role.id] = role
  return store
}

describe('background message handlers', () => {
  it('exposes group message route and sends prompts through injected delivery', async () => {
    vi.resetModules()
    let draftStore: OpenTeamStore | undefined
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const store = createStoreWithReadyRole()
          const result = await mutator(store)
          draftStore = store
          return { store, result }
        }),
      }
    })

    const { MESSAGE_ROUTE_TYPES, createMessageHandlers } = await import('./messageHandlers')
    const binding: RuntimeFrameBinding = { chatId: 'chat-1', roleId: 'role-1', tabId: 101, frameId: 7, ready: true, lastSeenAt: 0 }
    const broadcastStoreUpdated = vi.fn()
    const sendPrompt = vi.fn()
    const routes = createMessageHandlers({
      broadcastStoreUpdated,
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn(() => binding),
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt,
    })

    expect(MESSAGE_ROUTE_TYPES).toEqual([
      'GROUP_ROLE_RETRY_REPLY',
      'GROUP_ROLE_STOP_REPLY',
      'GROUP_NOTE_SAVE',
      'GROUP_MESSAGE_HIGHLIGHT_CREATE',
      'GROUP_MESSAGE_RESYNC_REPLY',
      'GROUP_MESSAGE_SEND',
      'TEAM_FRAME_ROLE_READY',
      'TEAM_ROLE_CONVERSATION_UPDATED',
      'TEAM_SEND_ACK',
      'TEAM_ROLE_STATUS',
      'TEAM_ROLE_REPLY',
      'TEAM_ROLE_REPLY_RESYNC',
      'TEAM_ROLE_ERROR',
    ])
    expect(routes.map(route => route.type)).toEqual(MESSAGE_ROUTE_TYPES)

    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')
    const response = await sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 帮我评审一下' }, {})

    expect(response).toMatchObject({
      ok: true,
      message: {
        id: 'msg-1',
        chatId: 'chat-1',
        content: '帮我评审一下',
        targetRoleIds: ['role-1'],
        mentionsAll: true,
        deliveryStatus: { 'role-1': 'pending' },
      },
      deliveries: [{ roleId: 'role-1' }],
    })
    expect(sendPrompt).toHaveBeenCalledWith(expect.objectContaining({
      roleId: 'role-1',
      tabId: 101,
      frameId: 7,
      message: expect.objectContaining({
        type: 'TEAM_SEND_PROMPT',
        chatId: 'chat-1',
        roleId: 'role-1',
        messageId: 'msg-1',
        replyAttemptId: 'attempt-1',
        includesPersona: true,
        content: expect.stringContaining('帮我评审一下'),
      }),
    }))
    expect(draftStore?.rolesById['role-1']).toMatchObject({
      status: 'thinking',
      lastPromptMessageId: 'msg-1',
      replyAttemptId: 'attempt-1',
    })
    expect(broadcastStoreUpdated).toHaveBeenCalledWith(expect.objectContaining({
      messagesById: expect.objectContaining({ 'msg-1': expect.any(Object) }),
    }))
  })

  it('stores no-mention messages without delivering prompts to group roles', async () => {
    vi.resetModules()
    let draftStore: OpenTeamStore | undefined
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const store = createStoreWithReadyRole()
          const result = await mutator(store)
          draftStore = store
          return { store, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const binding: RuntimeFrameBinding = { chatId: 'chat-1', roleId: 'role-1', tabId: 101, frameId: 7, ready: true, lastSeenAt: 0 }
    const broadcastStoreUpdated = vi.fn()
    const sendPrompt = vi.fn()
    const routes = createMessageHandlers({
      broadcastStoreUpdated,
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn(() => binding),
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt,
    })

    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')
    const response = await sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '先记一下这个背景' }, {})

    expect(response).toMatchObject({
      ok: true,
      message: {
        id: 'msg-1',
        chatId: 'chat-1',
        content: '先记一下这个背景',
        targetRoleIds: [],
        status: 'received',
        deliveryStatus: {},
      },
      deliveries: [],
    })
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(draftStore?.rolesById['role-1']?.status).toBe('ready')
    expect(draftStore?.rolesById['role-1']?.lastPromptMessageId).toBeUndefined()
    expect(draftStore?.rolesById['role-1']?.replyAttemptId).toBeUndefined()
    expect(broadcastStoreUpdated).toHaveBeenCalledWith(expect.objectContaining({
      messagesById: expect.objectContaining({ 'msg-1': expect.any(Object) }),
    }))
  })

  it('delivers external model roles through the API runtime without requiring an iframe', async () => {
    vi.resetModules()
    const startingStore = createStoreWithReadyRole()
    startingStore.settings.externalModelOrder = ['model-1']
    startingStore.settings.externalModelsById = {
      'model-1': {
        id: 'model-1',
        name: '本地 Qwen',
        format: 'openai',
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'sk-test',
        modelName: 'qwen-plus',
        createdAt: 1,
        updatedAt: 1,
      },
    }
    startingStore.rolesById['role-1'].modelSource = 'external'
    startingStore.rolesById['role-1'].externalModelId = 'model-1'
    delete startingStore.rolesById['role-1'].chatSite

    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const getByRole = vi.fn(() => undefined)
    const externalModelClient = {
      complete: vi.fn(async () => ({ content: 'API 回复内容' })),
    }
    const broadcastStoreUpdated = vi.fn()
    let messageIdSeq = 0
    const routes = createMessageHandlers({
      broadcastStoreUpdated,
      externalModelClient,
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => prefix === 'msg' ? `${prefix}-${++messageIdSeq}` : `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole,
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
    })

    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')
    const response = await sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 用 API 回答' }, {})

    expect(response).toMatchObject({
      ok: true,
      deliveries: [{ roleId: 'role-1', modelSource: 'external' }],
    })
    expect(getByRole).not.toHaveBeenCalledWith('chat-1', 'role-1')
    expect(externalModelClient.complete).toHaveBeenCalledWith(expect.objectContaining({
      model: expect.objectContaining({ id: 'model-1', modelName: 'qwen-plus' }),
      prompt: expect.stringContaining('用 API 回答'),
    }))
    expect(broadcastStoreUpdated).toHaveBeenLastCalledWith(expect.objectContaining({
      messagesById: expect.objectContaining({
        'msg-1': expect.objectContaining({ status: 'received' }),
        'msg-2': expect.objectContaining({
          type: 'assistant',
          content: 'API 回复内容',
          roleId: 'role-1',
        }),
      }),
    }))
  })

  it('streams external model replies into a pending assistant message', async () => {
    vi.resetModules()
    const startingStore = createStoreWithReadyRole()
    startingStore.settings.externalModelOrder = ['model-1']
    startingStore.settings.externalModelsById = {
      'model-1': {
        id: 'model-1',
        name: '流式模型',
        format: 'openai',
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'sk-test',
        modelName: 'qwen-plus',
        createdAt: 1,
        updatedAt: 1,
      },
    }
    startingStore.rolesById['role-1'].modelSource = 'external'
    startingStore.rolesById['role-1'].externalModelId = 'model-1'

    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const externalModelClient = {
      stream: vi.fn(async function* () {
        yield '第一段'
        yield '第二段'
      }),
    }
    const broadcasts: OpenTeamStore[] = []
    let messageIdSeq = 0
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(async (store: OpenTeamStore) => {
        broadcasts.push(structuredClone(store))
      }),
      externalModelClient: externalModelClient as never,
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => prefix === 'msg' ? `${prefix}-${++messageIdSeq}` : `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn(() => undefined),
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
    })

    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')
    const response = await sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 流式回答' }, {}) as { store: OpenTeamStore } | undefined

    expect(externalModelClient.stream).toHaveBeenCalledWith(expect.objectContaining({
      model: expect.objectContaining({ id: 'model-1' }),
      prompt: expect.stringContaining('流式回答'),
    }))
    expect(broadcasts.some(store => store.messagesById['msg-2']?.status === 'pending')).toBe(true)
    expect(broadcasts.some(store => store.messagesById['msg-2']?.content === '第一段')).toBe(true)
    const finalStore = broadcasts[broadcasts.length - 1]
    expect(finalStore?.messagesById['msg-2']).toMatchObject({
      type: 'assistant',
      content: '第一段第二段',
      status: 'received',
      roleId: 'role-1',
    })
    expect(finalStore?.messagesById['msg-1']).toMatchObject({
      status: 'received',
      deliveryStatus: { 'role-1': 'received' },
    })
    expect(response?.store.messagesById['msg-2']).toMatchObject({
      content: '第一段第二段',
      status: 'received',
    })
    expect(response?.store.rolesById['role-1']).toMatchObject({ status: 'ready' })
  })

  it('stops an active external model stream without requiring an iframe', async () => {
    vi.resetModules()
    const startingStore = createStoreWithReadyRole()
    startingStore.rolesById['role-1'].modelSource = 'external'
    startingStore.rolesById['role-1'].externalModelId = 'model-1'
    startingStore.rolesById['role-1'].status = 'thinking'
    startingStore.rolesById['role-1'].lastPromptMessageId = 'msg-1'
    startingStore.rolesById['role-1'].replyAttemptId = 'attempt-1'
    startingStore.messagesById['msg-1'] = {
      id: 'msg-1',
      chatId: 'chat-1',
      seq: 1,
      type: 'user',
      content: '请回答',
      targetRoleIds: ['role-1'],
      createdAt: 1,
      status: 'pending',
      deliveryStatus: { 'role-1': 'pending' },
    }
    startingStore.chatsById['chat-1'].messageIds = ['msg-1']
    startingStore.chatsById['chat-1'].nextMessageSeq = 2

    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const abort = vi.fn()
    const getByRole = vi.fn(() => undefined)
    const sendRoleMessage = vi.fn()
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      externalModelClient: { complete: vi.fn() },
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-stopped`),
      now: vi.fn(() => 200),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole,
      },
      sendRoleMessage,
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
      externalModelRuns: {
        abort,
        register: vi.fn(),
        unregister: vi.fn(),
      },
    } as never)

    const stopRoute = routes.find(route => route.type === 'GROUP_ROLE_STOP_REPLY')
    const response = await stopRoute?.handler({ type: 'GROUP_ROLE_STOP_REPLY', chatId: 'chat-1', roleId: 'role-1' }, {})

    expect(response).toMatchObject({ ok: true, messageId: 'msg-1' })
    expect(abort).toHaveBeenCalledWith('chat-1', 'role-1', 'attempt-1')
    expect(getByRole).not.toHaveBeenCalled()
    expect(sendRoleMessage).not.toHaveBeenCalled()
    expect(currentStore.rolesById['role-1']).toMatchObject({
      status: 'stopped',
      replyAttemptId: 'stopped-stopped',
    })
  })

  it('finalizes the visible external assistant message even when abort does not reach the stream', async () => {
    vi.resetModules()
    const startingStore = createStoreWithReadyRole()
    startingStore.rolesById['role-1'].modelSource = 'external'
    startingStore.rolesById['role-1'].externalModelId = 'model-1'
    startingStore.rolesById['role-1'].status = 'thinking'
    startingStore.rolesById['role-1'].lastPromptMessageId = 'msg-1'
    startingStore.rolesById['role-1'].replyAttemptId = 'attempt-1'
    startingStore.messagesById['msg-1'] = {
      id: 'msg-1',
      chatId: 'chat-1',
      seq: 1,
      type: 'user',
      content: '请回答',
      targetRoleIds: ['role-1'],
      createdAt: 1,
      status: 'sent',
      deliveryStatus: { 'role-1': 'sent' },
    }
    startingStore.messagesById['msg-2'] = {
      id: 'msg-2',
      chatId: 'chat-1',
      seq: 2,
      type: 'assistant',
      content: '已经收到的流式内容',
      roleId: 'role-1',
      roleName: '工程师',
      createdAt: 2,
      status: 'pending',
    }
    startingStore.chatsById['chat-1'].messageIds = ['msg-1', 'msg-2']
    startingStore.chatsById['chat-1'].nextMessageSeq = 3

    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const abort = vi.fn()
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      externalModelClient: { complete: vi.fn() },
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-stopped`),
      now: vi.fn(() => 200),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn(() => undefined),
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
      externalModelRuns: {
        abort,
        register: vi.fn(),
        unregister: vi.fn(),
      },
    } as never)

    const stopRoute = routes.find(route => route.type === 'GROUP_ROLE_STOP_REPLY')
    const response = await stopRoute?.handler({ type: 'GROUP_ROLE_STOP_REPLY', chatId: 'chat-1', roleId: 'role-1' }, {}) as { store: OpenTeamStore }

    expect(abort).toHaveBeenCalledWith('chat-1', 'role-1', 'attempt-1')
    expect(response.store.messagesById['msg-2']).toMatchObject({
      content: '已经收到的流式内容',
      status: 'received',
    })
    expect(response.store.messagesById['msg-1']).toMatchObject({
      status: 'received',
      deliveryStatus: { 'role-1': 'received' },
    })
    expect(response.store.rolesById['role-1'].lastPromptMessageId).toBeUndefined()
    expect(response.store.rolesById['role-1'].replyAttemptId).toBeUndefined()
  })

  it('keeps a stopped external stream in its existing assistant message', async () => {
    vi.resetModules()
    const startingStore = createStoreWithReadyRole()
    startingStore.settings.externalModelOrder = ['model-1']
    startingStore.settings.externalModelsById = {
      'model-1': {
        id: 'model-1',
        name: '流式模型',
        format: 'openai',
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'sk-test',
        modelName: 'qwen-plus',
        createdAt: 1,
        updatedAt: 1,
      },
    }
    startingStore.rolesById['role-1'].modelSource = 'external'
    startingStore.rolesById['role-1'].externalModelId = 'model-1'

    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    let firstChunkConsumed!: () => void
    const firstChunkStored = new Promise<void>(resolve => {
      firstChunkConsumed = resolve
    })
    const externalModelClient = {
      stream: vi.fn(async function* () {
        yield '第一段'
        firstChunkConsumed()
        await new Promise<void>(() => undefined)
      }),
    }
    let messageIdSeq = 0
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      externalModelClient: externalModelClient as never,
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => prefix === 'msg' ? `${prefix}-${++messageIdSeq}` : `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn(() => undefined),
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
    })

    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')
    const stopRoute = routes.find(route => route.type === 'GROUP_ROLE_STOP_REPLY')
    const sendPromise = sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 流式回答' }, {}) as Promise<{ store: OpenTeamStore }>
    await firstChunkStored
    const stopResponse = await stopRoute?.handler({ type: 'GROUP_ROLE_STOP_REPLY', chatId: 'chat-1', roleId: 'role-1' }, {}) as { store: OpenTeamStore }

    expect(stopResponse.store.messagesById['msg-2']).toMatchObject({
      type: 'assistant',
      content: '第一段',
      status: 'received',
      roleId: 'role-1',
    })
    expect(stopResponse.store.rolesById['role-1'].lastPromptMessageId).toBeUndefined()
    expect(stopResponse.store.rolesById['role-1'].replyAttemptId).toBeUndefined()

    const responseOrTimeout = await Promise.race([
      sendPromise,
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 25)),
    ])

    expect(currentStore.chatsById['chat-1'].messageIds).toEqual(['msg-1', 'msg-2'])
    expect(responseOrTimeout).not.toBe('timeout')
    const response = responseOrTimeout as { store: OpenTeamStore }
    expect(response.store.messagesById['msg-2']).toMatchObject({
      type: 'assistant',
      content: '第一段',
      status: 'received',
      roleId: 'role-1',
    })
    expect(response.store.rolesById['role-1']).toMatchObject({ status: 'stopped' })
    expect(response.store.rolesById['role-1'].lastPromptMessageId).toBeUndefined()
    expect(response.store.rolesById['role-1'].replyAttemptId).toBeUndefined()
  })

  it('retries external model replies by discarding the selected assistant message and streaming again', async () => {
    vi.resetModules()
    const startingStore = createStoreWithReadyRole()
    startingStore.settings.externalModelOrder = ['model-1']
    startingStore.settings.externalModelsById = {
      'model-1': {
        id: 'model-1',
        name: 'OpenRouter Claude',
        format: 'openai',
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'sk-test',
        modelName: 'anthropic/claude-sonnet',
        createdAt: 1,
        updatedAt: 1,
      },
    }
    startingStore.rolesById['role-1'].modelSource = 'external'
    startingStore.rolesById['role-1'].externalModelId = 'model-1'
    startingStore.messagesById['msg-user'] = {
      id: 'msg-user',
      chatId: 'chat-1',
      seq: 1,
      type: 'user',
      content: '重新回答这个问题',
      targetRoleIds: ['role-1'],
      createdAt: 1,
      status: 'received',
      deliveryStatus: { 'role-1': 'received' },
    }
    startingStore.messagesById['msg-old-reply'] = {
      id: 'msg-old-reply',
      chatId: 'chat-1',
      seq: 2,
      type: 'assistant',
      content: '旧 API 回复',
      roleId: 'role-1',
      roleName: '工程师',
      createdAt: 2,
      status: 'received',
    }
    startingStore.chatsById['chat-1'].messageIds = ['msg-user', 'msg-old-reply']
    startingStore.chatsById['chat-1'].nextMessageSeq = 3

    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    let messageIdSeq = 0
    const externalModelClient = {
      stream: vi.fn(async function* () {
        yield '新的 API 回复'
      }),
      complete: vi.fn(),
    }
    const getByRole = vi.fn(() => undefined)
    const sendRoleMessage = vi.fn()
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      externalModelClient,
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => prefix === 'msg' ? `${prefix}-new-${++messageIdSeq}` : `${prefix}-retry`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole,
      },
      sendRoleMessage,
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
    })

    const retryRoute = routes.find(route => route.type === 'GROUP_ROLE_RETRY_REPLY')
    const response = await retryRoute?.handler({ type: 'GROUP_ROLE_RETRY_REPLY', chatId: 'chat-1', roleId: 'role-1', messageId: 'msg-old-reply' }, {}) as { ok: boolean; store: OpenTeamStore }

    expect(response.ok).toBe(true)
    expect(response.store.messagesById['msg-old-reply']).toBeUndefined()
    expect(response.store.chatsById['chat-1'].messageIds).toEqual(['msg-user', 'msg-new-1'])
    expect(response.store.messagesById['msg-new-1']).toMatchObject({
      type: 'assistant',
      roleId: 'role-1',
      content: '新的 API 回复',
      status: 'received',
    })
    expect(response.store.messagesById['msg-user']).toMatchObject({
      status: 'received',
      deliveryStatus: { 'role-1': 'received' },
    })
    expect(externalModelClient.stream).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('重新回答这个问题'),
    }))
    expect(getByRole).not.toHaveBeenCalled()
    expect(sendRoleMessage).not.toHaveBeenCalled()
  })
})
