import { formatContextMessage, type UnsyncedContextResult } from './contextSync'
import type { GroupChat, GroupMessage, GroupRole, MessageReference } from './types'

export interface BuildPromptInput {
  chat: GroupChat
  role: GroupRole
  userMessage: GroupMessage
  roles: GroupRole[]
  unsyncedContext?: UnsyncedContextResult
  unsyncedMessages?: GroupMessage[]
  maxContextChars?: number
  reference?: MessageReference
}

export function buildPrompt(input: BuildPromptInput): string {
  return input.chat.mode === 'collaborative'
    ? buildCollaborativePrompt(input)
    : buildIndependentPrompt(input)
}

export function buildIndependentPrompt(input: BuildPromptInput): string {
  const reference = input.reference ?? input.userMessage.references?.[0]
  return joinSections([
    `你是「${input.role.name}」。`,
    buildRoleBlock(input.role),
    buildReferenceBlock(reference),
    `用户消息：\n${input.userMessage.content}`,
    `请以「${input.role.name}」身份回复。${reference ? '请明确说明你同意或不同意哪里，以及下一步建议。' : ''}`,
  ])
}

export function buildCollaborativePrompt(input: BuildPromptInput): string {
  const reference = input.reference ?? input.userMessage.references?.[0]

  return joinSections([
    '你正在一个 AI 群聊中。',
    buildMemberList(input.roles),
    `你的身份是「${input.role.name}」。`,
    buildRoleBlock(input.role),
    buildContextBlock(input),
    buildReferenceBlock(reference),
    `用户最新消息：\n${input.userMessage.content}`,
    `请以「${input.role.name}」身份回复。你可以参考、补充或反驳其他成员观点。${reference ? '请明确回应用户引用的观点。' : ''}`,
  ])
}

export function buildInitializationPrompt(chat: GroupChat, role: GroupRole, roles: GroupRole[]): string {
  if (chat.mode === 'collaborative') {
    return joinSections([
      '你正在一个 AI 群聊中。',
      buildMemberList(roles),
      `你的身份是「${role.name}」。`,
      buildRoleBlock(role),
      '请保持你的角色视角。你可以回应、补充或反驳其他成员的观点。当用户引用某位成员的发言时，请明确回应那条观点。',
    ])
  }

  return joinSections([
    `你是「${role.name}」。`,
    buildRoleBlock(role),
    '用户会给你任务。请始终保持你的角色视角，独立回答，不需要假设还有其他 AI 成员。',
  ])
}

export function buildInitPrompt(chat: GroupChat, role: GroupRole, roles: GroupRole[]): string {
  return buildInitializationPrompt(chat, role, roles)
}

export function buildReinitializationPrompt(chat: GroupChat, role: GroupRole, roles: GroupRole[]): string {
  return buildInitializationPrompt(chat, role, roles)
}

export function buildReinitPrompt(chat: GroupChat, role: GroupRole, roles: GroupRole[]): string {
  return buildReinitializationPrompt(chat, role, roles)
}

export function buildMemberList(roles: GroupRole[]): string {
  const members = roles.map(role => `- ${role.name}${role.description ? `：${role.description}` : ''}`).join('\n')
  return `群聊成员：\n${members}`
}

function buildRoleBlock(role: GroupRole): string {
  return joinSections([
    role.description ? `你的职责：\n${role.description}` : undefined,
    role.systemPrompt ? `角色设定：\n${role.systemPrompt}` : undefined,
  ])
}

function buildContextBlock(input: BuildPromptInput): string {
  if (input.unsyncedContext) {
    return joinSections([
      input.unsyncedContext.omittedEarlyContext ? '部分早期上下文已省略。' : undefined,
      input.unsyncedContext.contextText
        ? `你上次之后，群聊里有这些新内容：\n${input.unsyncedContext.contextText}`
        : '你上次之后，群聊里没有需要同步的新内容。',
    ])
  }

  const messages = input.unsyncedMessages ?? []
  if (messages.length === 0) return ''

  const maxContextChars = input.maxContextChars ?? 6000
  const context = messages.map(formatContextMessage).join('\n\n')
  if (context.length <= maxContextChars) {
    return `你上次之后，群聊里有这些新内容：\n${context}`
  }

  return `[部分早期上下文已省略]\n\n你上次之后，群聊里有这些新内容：\n${context.slice(-maxContextChars).trimStart()}`
}

function buildReferenceBlock(reference: MessageReference | undefined): string {
  if (!reference) return ''
  const source = reference.roleName ? `「${reference.roleName}」的观点` : '一条消息'
  return `用户引用了${source}：\n「${reference.contentSnapshot}」\n请明确回应这条引用。`
}

function joinSections(sections: Array<string | undefined>): string {
  return sections.filter((section): section is string => Boolean(section?.trim())).join('\n\n')
}
