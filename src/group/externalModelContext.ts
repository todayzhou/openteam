import { formatContextMessage } from './contextSync'
import { buildPrompt } from './promptBuilder'
import type { GroupChat, GroupMessage, GroupRole, OpenTeamStore } from './types'

export interface ExternalModelPromptResult {
  content: string
  memoryPatch?: ExternalMemoryPatch
}

export interface BuildExternalModelPromptOptions {
  responseInstruction?: string
}

export type ExternalMemoryPatch =
  | { scope: 'role'; id: string; summary: string; summarizedThroughSeq: number }
  | { scope: 'chat'; id: string; summary: string; summarizedThroughSeq: number }

export function buildExternalModelPrompt(
  store: OpenTeamStore,
  chat: GroupChat,
  role: GroupRole,
  userMessage: GroupMessage,
  roles: GroupRole[],
  options: BuildExternalModelPromptOptions = {},
): ExternalModelPromptResult {
  const scopedMessages = externalContextMessages(store, chat, role, userMessage)
  const scope = chat.mode === 'collaborative' ? 'chat' : 'role'
  const memory = scope === 'chat' ? store.externalChatMemoriesById?.[chat.id] : store.externalRoleMemoriesById?.[role.id]
  const contextAfterMemory = scopedMessages.filter(message => message.seq > (memory?.summarizedThroughSeq ?? 0) && message.id !== userMessage.id)
  const budget = Math.max(240, store.settings.maxContextChars)
  const directPrompt = buildPromptWithExternalContext(chat, role, userMessage, roles, contextAfterMemory, budget, options)
  const withSummary = joinSections([
    memory?.summary ? `历史摘要：\n${memory.summary}` : undefined,
    directPrompt,
  ])
  if (withSummary.length <= budget) return { content: withSummary }

  const compressible = contextAfterMemory.slice(0, Math.max(0, contextAfterMemory.length - 1))
  if (compressible.length === 0) {
    return { content: trimPromptFromStart(withSummary, budget) }
  }

  const summarizedMessages = contextAfterMemory
  const summarizedThroughSeq = summarizedMessages[summarizedMessages.length - 1]?.seq ?? memory?.summarizedThroughSeq ?? 0
  const summary = compressMessages(memory?.summary, summarizedMessages)
  const compressedPrompt = joinSections([
    summary ? `历史摘要：\n${summary}` : undefined,
    buildPromptWithExternalContext(chat, role, userMessage, roles, [], budget, options),
  ])

  return {
    content: trimPromptFromStart(compressedPrompt, budget),
    memoryPatch: scope === 'chat'
      ? { scope, id: chat.id, summary, summarizedThroughSeq }
      : { scope, id: role.id, summary, summarizedThroughSeq },
  }
}

function buildPromptWithExternalContext(
  chat: GroupChat,
  role: GroupRole,
  userMessage: GroupMessage,
  roles: GroupRole[],
  contextMessages: GroupMessage[],
  maxContextChars: number,
  options: BuildExternalModelPromptOptions,
): string {
  const basePrompt = buildPrompt({
    chat,
    role,
    userMessage,
    roles,
    unsyncedMessages: contextMessages,
    maxContextChars,
    reference: userMessage.references?.[0],
    includePersona: true,
    responseInstruction: options.responseInstruction,
  })
  if (chat.mode === 'collaborative' || contextMessages.length === 0) return basePrompt

  const context = contextMessages.map(formatContextMessage).join('\n\n')
  return joinSections([
    context ? `你和用户此前的上下文：\n${context}` : undefined,
    basePrompt,
  ])
}

function externalContextMessages(store: OpenTeamStore, chat: GroupChat, role: GroupRole, userMessage: GroupMessage): GroupMessage[] {
  const messages = chat.messageIds
    .map(messageId => store.messagesById[messageId])
    .filter((message): message is GroupMessage => Boolean(message))
    .filter(message => message.seq <= userMessage.seq)
    .sort((left, right) => left.seq - right.seq || left.createdAt - right.createdAt)

  if (chat.mode === 'collaborative') return messages

  return messages.filter(message => (
    message.id === userMessage.id ||
    message.roleId === role.id ||
    Boolean(message.targetRoleIds?.includes(role.id))
  ))
}

function compressMessages(previousSummary: string | undefined, messages: GroupMessage[]): string {
  const bullets = messages
    .filter(message => message.content.trim())
    .map(message => `- ${speakerLabel(message)}：${compactContent(message.content)}`)
  return joinSections([
    previousSummary,
    bullets.length > 0 ? bullets.join('\n') : undefined,
  ])
}

function compactContent(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized
}

function speakerLabel(message: GroupMessage): string {
  if (message.type === 'assistant') return message.roleName || '人员'
  if (message.type === 'system') return '系统'
  return '用户'
}

function trimPromptFromStart(prompt: string, budget: number): string {
  if (prompt.length <= budget) return prompt
  const head = prompt.slice(0, Math.floor(budget * 0.45)).trimEnd()
  const tail = prompt.slice(-Math.floor(budget * 0.55)).trimStart()
  return `${head}\n\n[中间上下文已省略]\n\n${tail}`
}

function joinSections(sections: Array<string | undefined>): string {
  return sections.filter((section): section is string => Boolean(section?.trim())).join('\n\n')
}
