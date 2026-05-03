import { describe, expect, it } from 'vitest'
import { extractGeminiConversationId, extractSupportedConversationId, getSafeGeminiUrl, getSafeSupportedChatUrl, isSafeGeminiUrl, isSafeSupportedChatUrl } from './conversationUrl'
import { buildUnsyncedContext, getContextCursorAfterAck, getUnsyncedMessagesForRole } from './contextSync'
import { parseGroupMentions } from './mentionParser'
import { buildInitPrompt, buildPrompt } from './promptBuilder'
import { createGroupRole, createGroupRolesBatch, createRoleTemplate, deleteRoleTemplate, updateGroupRole, updateRoleTemplate, validateRoleName } from './roleTemplates'
import { createDefaultStore } from './store'
import type { GroupChat, GroupMessage, GroupRole } from './types'

describe('role template utilities', () => {
  it('creates, updates, deletes templates, and creates independent group role instances', () => {
    const store = createDefaultStore()
    store.chatsById['chat-1'] = makeChat('chat-1')

    const template = createRoleTemplate(
      store,
      { name: '工程师', description: '关注技术实现', systemPrompt: '从工程角度分析' },
      'template-1',
      1,
    )
    expect(template).toMatchObject({ id: 'template-1', name: '工程师' })

    updateRoleTemplate(store, 'template-1', { name: '架构师', systemPrompt: '关注架构' }, 2)
    const role = createGroupRole(store, { chatId: 'chat-1', templateId: 'template-1' }, 'role-1', 3)
    updateRoleTemplate(store, 'template-1', { name: '技术负责人', systemPrompt: '关注技术决策' }, 4)

    expect(role).toMatchObject({ name: '架构师', systemPrompt: '关注架构', templateId: 'template-1' })
    expect(store.chatsById['chat-1'].roleIds).toEqual(['role-1'])

    expect(() => deleteRoleTemplate(store, 'template-1')).toThrow('该人员库人员已被群聊使用，不能删除')
    expect(store.roleTemplateOrder).toEqual(['template-1'])
    expect(store.rolesById['role-1']).toBe(role)
  })

  it('deletes unused templates', () => {
    const store = createDefaultStore()
    createRoleTemplate(store, { name: '工程师', systemPrompt: '从工程角度分析' }, 'template-1', 1)

    deleteRoleTemplate(store, 'template-1')

    expect(store.roleTemplateOrder).toEqual([])
    expect(store.roleTemplatesById['template-1']).toBeUndefined()
  })

  it('applies the default chat site to new roles', () => {
    const store = createDefaultStore()
    store.settings.defaultChatSite = 'chatgpt'
    store.chatsById['chat-1'] = makeChat('chat-1')

    const role = createGroupRole(store, { chatId: 'chat-1', name: '工程师', systemPrompt: '从工程角度分析' }, 'role-1', 1)

    expect(role.chatSite).toBe('chatgpt')
  })

  it('uses a role template default site when creating library people', () => {
    const store = createDefaultStore()
    store.settings.defaultChatSite = 'gemini'
    store.chatsById['chat-1'] = makeChat('chat-1')
    const template = createRoleTemplate(store, { name: '研究员', systemPrompt: '关注调研', defaultChatSite: 'claude' }, 'template-1', 1)

    const role = createGroupRole(store, { chatId: 'chat-1', templateId: template.id }, 'role-1', 2)

    expect(template).toMatchObject({ defaultChatSite: 'claude' })
    expect(role.chatSite).toBe('claude')
  })

  it('creates group roles in a validated batch without saving temporary people as templates', () => {
    const store = createDefaultStore()
    store.chatsById['chat-1'] = makeChat('chat-1')
    createRoleTemplate(store, { name: '工程师', systemPrompt: '从工程角度分析', defaultChatSite: 'claude' }, 'template-1', 1)

    const roles = createGroupRolesBatch(store, 'chat-1', [
      { source: 'library', roleTemplateId: 'template-1' },
      { source: 'temporary', name: '法务', description: '关注合规', systemPrompt: '从法务角度分析', chatSite: 'gemini' },
    ], () => `role-${store.chatsById['chat-1'].roleIds.length + 1}`, 2)

    expect(roles).toHaveLength(2)
    expect(roles[0]).toMatchObject({ templateId: 'template-1', name: '工程师', systemPrompt: '从工程角度分析', chatSite: 'claude' })
    expect(roles[1]).toMatchObject({ name: '法务', systemPrompt: '从法务角度分析', chatSite: 'gemini' })
    expect(roles[1].templateId).toBeUndefined()
    expect(store.roleTemplateOrder).toEqual(['template-1'])
    expect(Object.keys(store.roleTemplatesById)).toEqual(['template-1'])
  })

  it('validates an entire role batch before writing', () => {
    const store = createDefaultStore()
    store.chatsById['chat-1'] = makeChat('chat-1')
    createRoleTemplate(store, { name: '工程师', systemPrompt: '从工程角度分析' }, 'template-1', 1)

    expect(() => createGroupRolesBatch(store, 'chat-1', [
      { source: 'library', roleTemplateId: 'template-1' },
      { source: 'temporary', name: '', systemPrompt: 'invalid' },
    ], () => 'role-new', 2)).toThrow('人员名称不能为空')

    expect(store.chatsById['chat-1'].roleIds).toEqual([])
    expect(store.rolesById).toEqual({})
  })

  it('prevents direct persona edits on existing group people', () => {
    const store = createDefaultStore()
    store.chatsById['chat-1'] = makeChat('chat-1')
    const role = createGroupRole(store, { chatId: 'chat-1', name: '法务', systemPrompt: '从法务角度分析' }, 'role-1', 1)

    expect(() => updateGroupRole(store, 'role-1', { systemPrompt: '修改后的人设' }, 2)).toThrow('群聊内人员人设不可编辑')
    expect(role.systemPrompt).toBe('从法务角度分析')
  })

  it('resets conversation bindings when a role switches chat site', () => {
    const store = createDefaultStore()
    store.chatsById['chat-1'] = makeChat('chat-1')
    const role = createGroupRole(store, { chatId: 'chat-1', name: '法务', systemPrompt: '从法务角度分析' }, 'role-1', 1)
    role.chatSite = 'gemini'
    role.geminiConversationId = 'conv-1'
    role.geminiConversationUrl = 'https://gemini.google.com/app/conv-1'
    role.lastPromptMessageId = 'msg-1'
    role.lastReplyAt = 10
    role.contextCursor = 3
    role.status = 'ready'

    updateGroupRole(store, 'role-1', { chatSite: 'chatgpt' }, 2)

    expect(role.chatSite).toBe('chatgpt')
    expect(role.geminiConversationId).toBeUndefined()
    expect(role.geminiConversationUrl).toBeUndefined()
    expect(role.lastPromptMessageId).toBeUndefined()
    expect(role.lastReplyAt).toBeUndefined()
    expect(role.contextCursor).toBe(0)
    expect(role.status).toBe('pending')
  })

  it('validates role names', () => {
    expect(validateRoleName('')).toBe('人员名称不能为空')
    expect(validateRoleName('超过十个字符的人员名称')).toBe('人员名称不能超过 10 个字')
    expect(validateRoleName('A B')).toBe('人员名称不能包含空白字符')
    expect(validateRoleName('@A')).toBe('人员名称不能包含 @')
    expect(validateRoleName('all')).toBe('人员名称不能是 all')
    expect(validateRoleName('工程师', ['工程师'])).toBe('人员名称已存在：工程师')
    expect(validateRoleName('工程师')).toBeUndefined()
  })
})

describe('mention parser', () => {
  const roles = [makeRole('role-product', '产品'), makeRole('role-pm', '产品经理'), makeRole('role-eng', '工程师')]

  it('routes no-mention messages to all roles', () => {
    expect(parseGroupMentions('分析这个方案', roles)).toEqual({
      ok: true,
      content: '分析这个方案',
      targetRoleIds: ['role-product', 'role-pm', 'role-eng'],
      mentionedRoleIds: [],
    })
  })

  it('uses longest-match parsing for overlapping role names', () => {
    expect(parseGroupMentions('@产品经理 看一下', roles)).toEqual({
      ok: true,
      content: '看一下',
      targetRoleIds: ['role-pm'],
      mentionedRoleIds: ['role-pm'],
    })
  })

  it('routes multiple mentions and @all', () => {
    expect(parseGroupMentions('@工程师 @产品经理 评估风险', roles)).toEqual({
      ok: true,
      content: '评估风险',
      targetRoleIds: ['role-eng', 'role-pm'],
      mentionedRoleIds: ['role-eng', 'role-pm'],
    })
    expect(parseGroupMentions('@all @工程师 评估风险', roles)).toEqual({
      ok: true,
      content: '评估风险',
      targetRoleIds: ['role-product', 'role-pm', 'role-eng'],
      mentionedRoleIds: ['role-eng'],
    })
  })

  it('keeps unknown mentions in the message and falls back to all roles', () => {
    expect(parseGroupMentions('@不存在 继续评估', roles)).toEqual({
      ok: true,
      content: '@不存在 继续评估',
      targetRoleIds: ['role-product', 'role-pm', 'role-eng'],
      mentionedRoleIds: [],
    })
  })
})

describe('context sync utilities', () => {
  it('returns unsynced messages in chat order while excluding current user message and own role messages', () => {
    const chat = makeChat('chat-1')
    chat.messageIds = ['msg-1', 'msg-2', 'msg-3', 'msg-4']
    chat.nextMessageSeq = 5
    const role = makeRole('role-a', 'A')
    role.contextCursor = 1
    const userMessage = makeMessage('msg-4', 4, 'user', 'current')
    const messages = [
      makeMessage('msg-1', 1, 'user', 'old'),
      { ...makeMessage('msg-2', 2, 'assistant', 'own'), roleId: 'role-a', roleName: 'A' },
      { ...makeMessage('msg-3', 3, 'assistant', 'other'), roleId: 'role-b', roleName: 'B' },
      userMessage,
    ]

    expect(getUnsyncedMessagesForRole(chat, role, messages, userMessage).map(message => message.id)).toEqual(['msg-3'])
    expect(getContextCursorAfterAck(chat)).toBe(4)
  })

  it('does not sync user messages that were directed to other roles', () => {
    const chat = makeChat('chat-1')
    chat.messageIds = ['msg-1', 'msg-2']
    chat.roleIds = ['role-a', 'role-b']
    const role = makeRole('role-b', 'B')
    const messageForA = { ...makeMessage('msg-1', 1, 'user', 'only for A'), targetRoleIds: ['role-a'] }
    const currentUserMessage = { ...makeMessage('msg-2', 2, 'user', 'current for B'), targetRoleIds: ['role-b'] }

    const context = buildUnsyncedContext(chat, role, [messageForA, currentUserMessage], currentUserMessage)

    expect(context.messages).toEqual([])
    expect(context.contextText).toBe('')
  })

  it('formats truncated unsynced context and reports the latest message cursor', () => {
    const chat = makeChat('chat-1')
    chat.messageIds = ['msg-1', 'msg-2', 'msg-3']
    const role = makeRole('role-a', 'A')
    const currentUserMessage = makeMessage('msg-3', 3, 'user', 'current')
    const messages = [
      makeMessage('msg-1', 1, 'user', 'first user turn'),
      { ...makeMessage('msg-2', 2, 'assistant', 'assistant context'), roleId: 'role-b', roleName: 'B' },
      currentUserMessage,
    ]

    const context = buildUnsyncedContext(chat, role, messages, currentUserMessage, 12)

    expect(context.messages.map(message => message.id)).toEqual(['msg-1', 'msg-2'])
    expect(context.contextText).toBe('tant context')
    expect(context.omittedEarlyContext).toBe(true)
    expect(context.latestSeq).toBe(3)
    expect(getContextCursorAfterAck(chat, messages)).toBe(3)
  })
})

describe('prompt builder', () => {
  it('builds independent prompts with references and without other role context', () => {
    const chat = makeChat('chat-1')
    const role = makeRole('role-a', '工程师')
    role.description = '关注技术风险'
    const userMessage = makeMessage('msg-1', 1, 'user', '你怎么看？')
    userMessage.references = [{ messageId: 'msg-ref', roleName: '产品经理', contentSnapshot: '需要两周上线' }]

    const prompt = buildPrompt({ chat, role, userMessage, roles: [role] })

    expect(prompt).toContain('你是「工程师」')
    expect(prompt).toContain('用户引用了「产品经理」的观点')
    expect(prompt).toContain('你怎么看？')
    expect(prompt).not.toContain('群聊成员')
  })

  it('skips persona in ordinary prompts when requested', () => {
    const chat = makeChat('chat-1')
    const role = makeRole('role-a', '工程师')
    role.description = '关注技术风险'
    role.systemPrompt = '这是完整人设'
    const userMessage = makeMessage('msg-1', 1, 'user', '你怎么看？')

    const prompt = buildPrompt({ chat, role, userMessage, roles: [role], includePersona: false })

    expect(prompt).toContain('你是「工程师」')
    expect(prompt).toContain('你的职责')
    expect(prompt).not.toContain('这是完整人设')
  })

  it('builds collaborative init and message prompts with members and truncated context', () => {
    const chat = { ...makeChat('chat-1'), mode: 'collaborative' as const }
    const roleA = makeRole('role-a', '工程师')
    const roleB = makeRole('role-b', '产品经理')
    roleB.description = '关注用户价值'
    const userMessage = makeMessage('msg-3', 3, 'user', '继续讨论')
    const unsyncedMessages = [{ ...makeMessage('msg-2', 2, 'assistant', '很长的上下文内容'), roleId: 'role-b', roleName: '产品经理' }]

    expect(buildInitPrompt(chat, roleA, [roleA, roleB])).toContain('群聊成员')

    const prompt = buildPrompt({
      chat,
      role: roleA,
      userMessage,
      roles: [roleA, roleB],
      unsyncedMessages,
      maxContextChars: 4,
    })
    expect(prompt).toContain('群聊成员')
    expect(prompt).toContain('[部分早期上下文已省略]')
    expect(prompt).toContain('继续讨论')
  })
})

describe('Gemini conversation URL utilities', () => {
  it('validates safe Gemini URLs and extracts conversation ids', () => {
    expect(isSafeGeminiUrl('https://gemini.google.com/app/abc123')).toBe(true)
    expect(isSafeGeminiUrl('https://evil.example/app/abc123')).toBe(false)
    expect(isSafeGeminiUrl('http://gemini.google.com/app/abc123')).toBe(false)
    expect(isSafeGeminiUrl('https://gemini.google.com.evil.example/app/abc123')).toBe(false)
    expect(getSafeGeminiUrl('https://evil.example/app/abc123')).toBe('https://gemini.google.com/')
    expect(extractGeminiConversationId('https://gemini.google.com/app/abc123?x=1')).toBe('abc123')
    expect(extractGeminiConversationId('https://gemini.google.com/app/abc123/share')).toBe('abc123')
    expect(extractGeminiConversationId('https://gemini.google.com/app/%E6%B5%8B%E8%AF%95')).toBe('测试')
    expect(extractGeminiConversationId('https://gemini.google.com/')).toBeUndefined()
  })

  it('accepts safe ChatGPT URLs as supported chat conversation URLs', () => {
    expect(isSafeSupportedChatUrl('https://chatgpt.com/c/abc123')).toBe(true)
    expect(isSafeSupportedChatUrl('https://chat.openai.com/c/abc123')).toBe(true)
    expect(isSafeSupportedChatUrl('https://claude.ai/chat/abc123')).toBe(true)
    expect(isSafeSupportedChatUrl('https://chat.deepseek.com/a/chat/s/abc123')).toBe(true)
    expect(isSafeSupportedChatUrl('https://chatgpt.com.evil.example/c/abc123')).toBe(false)
    expect(isSafeSupportedChatUrl('https://claude.ai.evil.example/chat/abc123')).toBe(false)
    expect(isSafeSupportedChatUrl('https://chat.deepseek.com.evil.example/a/chat/s/abc123')).toBe(false)
    expect(getSafeSupportedChatUrl('https://chatgpt.com/c/abc123')).toBe('https://chatgpt.com/c/abc123')
    expect(getSafeSupportedChatUrl('https://claude.ai/chat/abc123')).toBe('https://claude.ai/chat/abc123')
    expect(getSafeSupportedChatUrl('https://chat.deepseek.com/a/chat/s/abc123')).toBe('https://chat.deepseek.com/a/chat/s/abc123')
    expect(getSafeSupportedChatUrl('https://evil.example/c/abc123')).toBe('https://gemini.google.com/')
    expect(extractSupportedConversationId('https://chatgpt.com/c/%E6%B5%8B%E8%AF%95')).toBe('测试')
    expect(extractSupportedConversationId('https://claude.ai/chat/%E6%B5%8B%E8%AF%95')).toBe('测试')
    expect(extractSupportedConversationId('https://chat.deepseek.com/a/chat/s/%E6%B5%8B%E8%AF%95')).toBe('测试')
    expect(extractSupportedConversationId('https://chatgpt.com/')).toBeUndefined()
    expect(getSafeSupportedChatUrl('https://evil.example/chat/abc123')).toBe('https://gemini.google.com/')
  })
})

function makeChat(id: string): GroupChat {
  return {
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
}

function makeRole(id: string, name: string): GroupRole {
  return {
    id,
    chatId: 'chat-1',
    name,
    status: 'ready',
    contextCursor: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

function makeMessage(id: string, seq: number, type: GroupMessage['type'], content: string): GroupMessage {
  return {
    id,
    chatId: 'chat-1',
    seq,
    type,
    content,
    createdAt: 1,
    status: 'received',
  }
}
