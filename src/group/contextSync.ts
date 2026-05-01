import type { GroupChat, GroupMessage, GroupRole } from './types'

export interface UnsyncedContextResult {
  messages: GroupMessage[]
  contextText: string
  omittedEarlyContext: boolean
  latestSeq: number
}

export function getUnsyncedMessagesForRole(
  chat: GroupChat,
  role: GroupRole,
  messages: GroupMessage[],
  userMessage: GroupMessage,
): GroupMessage[] {
  const messageById = new Map(messages.map(message => [message.id, message]))

  return chat.messageIds
    .map(messageId => messageById.get(messageId))
    .filter((message): message is GroupMessage => Boolean(message))
    .filter(message => message.seq > role.contextCursor && message.id !== userMessage.id && message.roleId !== role.id)
}

export function buildUnsyncedContext(
  chat: GroupChat,
  role: GroupRole,
  messages: GroupMessage[],
  userMessage: GroupMessage,
  maxContextChars = 6000,
): UnsyncedContextResult {
  const unsyncedMessages = getUnsyncedMessagesForRole(chat, role, messages, userMessage)
  const formatted = unsyncedMessages.map(formatContextMessage).join('\n\n')
  const truncated = truncateLatest(formatted, maxContextChars)

  return {
    messages: unsyncedMessages,
    contextText: truncated.text,
    omittedEarlyContext: truncated.omitted,
    latestSeq: getLatestMessageSeq(chat, messages),
  }
}

export function getLatestMessageSeq(chat: GroupChat, messages: GroupMessage[]): number {
  const messageById = new Map(messages.map(message => [message.id, message]))
  return chat.messageIds.reduce((latest, messageId) => {
    const message = messageById.get(messageId)
    return message ? Math.max(latest, message.seq) : latest
  }, 0)
}

export function getContextCursorAfterAck(chat: GroupChat, messages?: GroupMessage[]): number {
  return messages ? getLatestMessageSeq(chat, messages) : chat.nextMessageSeq - 1
}

export function formatContextMessage(message: GroupMessage): string {
  const speaker = message.type === 'assistant'
    ? message.roleName ?? '角色'
    : message.type === 'user'
      ? '用户'
      : '系统'
  return `${speaker}：${message.content}`
}

function truncateLatest(text: string, maxChars: number): { text: string; omitted: boolean } {
  if (maxChars <= 0) return { text: '', omitted: text.length > 0 }
  if (text.length <= maxChars) return { text, omitted: false }
  return { text: text.slice(text.length - maxChars).trimStart(), omitted: true }
}
