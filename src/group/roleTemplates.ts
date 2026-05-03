import type { ChatSite, GroupChat, GroupRole, OpenTeamStore, RoleTemplate } from './types'

export interface RoleTemplateInput {
  name: string
  description?: string
  systemPrompt?: string
  defaultChatSite?: ChatSite
}

export interface GroupRoleInput {
  chatId: string
  templateId?: string
  chatSite?: ChatSite
  name?: string
  description?: string
  systemPrompt?: string
  avatarColor?: string
}

export type GroupRoleBatchInput =
  | {
      source: 'library'
      roleTemplateId: string
      chatSite?: ChatSite
      avatarColor?: string
    }
  | {
      source: 'temporary'
      name: string
      description?: string
      systemPrompt: string
      chatSite?: ChatSite
      avatarColor?: string
    }

type PreparedGroupRoleBatchItem = Omit<GroupRoleInput, 'chatId'> & {
  name: string
  systemPrompt: string
}

interface GraphemeSegment {
  segment: string
}

interface GraphemeSegmenter {
  segment(value: string): Iterable<GraphemeSegment>
}

interface IntlWithSegmenter {
  Segmenter?: new (locale: string | undefined, options: { granularity: 'grapheme' }) => GraphemeSegmenter
}

export function validateRoleName(name: string, existingNames: string[] = []): string | undefined {
  const trimmed = name.trim()
  if (!trimmed) return '人员名称不能为空'
  if (countUserPerceivedCharacters(trimmed) > 10) return '人员名称不能超过 10 个字'
  if (/\s/.test(trimmed)) return '人员名称不能包含空白字符'
  if (trimmed.includes('@')) return '人员名称不能包含 @'
  if (trimmed.toLowerCase() === 'all') return '人员名称不能是 all'
  if (existingNames.some(existingName => existingName.toLowerCase() === trimmed.toLowerCase())) return `人员名称已存在：${trimmed}`
  return undefined
}

export function assertValidRoleName(name: string, existingRoles: GroupRole[], currentRoleId?: string): string {
  const trimmed = name.trim()
  const existingNames = existingRoles
    .filter(role => role.id !== currentRoleId)
    .map(role => role.name)
  const error = validateRoleName(trimmed, existingNames)
  if (error) throw new Error(error)
  return trimmed
}

export function createRoleTemplate(
  store: OpenTeamStore,
  input: RoleTemplateInput,
  id: string,
  now: number,
): RoleTemplate {
  const name = assertValidRoleName(input.name, [])
  const systemPrompt = assertValidSystemPrompt(input.systemPrompt)
  const template: RoleTemplate = {
    id,
    name,
    defaultChatSite: input.defaultChatSite ?? store.settings.defaultChatSite,
    systemPrompt,
    createdAt: now,
    updatedAt: now,
  }

  const description = input.description?.trim()
  if (description) template.description = description

  store.roleTemplatesById[id] = template
  if (!store.roleTemplateOrder.includes(id)) store.roleTemplateOrder.push(id)
  return template
}

export function updateRoleTemplate(
  store: OpenTeamStore,
  templateId: string,
  patch: RoleTemplateInput,
  now: number,
): RoleTemplate {
  const template = store.roleTemplatesById[templateId]
  if (!template) throw new Error(`找不到人员库人员：${templateId}`)

  template.name = assertValidRoleName(patch.name, [])
  template.defaultChatSite = patch.defaultChatSite ?? template.defaultChatSite ?? store.settings.defaultChatSite
  template.systemPrompt = assertValidSystemPrompt(patch.systemPrompt)
  template.updatedAt = now

  const description = patch.description?.trim()
  if (description) {
    template.description = description
  } else {
    delete template.description
  }

  return template
}

export function deleteRoleTemplate(store: OpenTeamStore, templateId: string): void {
  const usage = getRoleTemplateUsage(store, templateId)
  if (usage.usedByChatIds.length > 0) {
    throw new Error('该人员库人员已被群聊使用，不能删除')
  }

  delete store.roleTemplatesById[templateId]
  store.roleTemplateOrder = store.roleTemplateOrder.filter(id => id !== templateId)
}

export function getRoleTemplateUsage(store: OpenTeamStore, templateId: string): { usedByRoleIds: string[]; usedByChatIds: string[] } {
  const usedByRoleIds: string[] = []
  const usedByChatIds = new Set<string>()

  for (const role of Object.values(store.rolesById)) {
    if (role.templateId !== templateId) continue
    usedByRoleIds.push(role.id)
    usedByChatIds.add(role.chatId)
  }

  return { usedByRoleIds, usedByChatIds: [...usedByChatIds] }
}

export function createGroupRole(
  store: OpenTeamStore,
  input: GroupRoleInput,
  id: string,
  now: number,
): GroupRole {
  const chat = store.chatsById[input.chatId]
  if (!chat) throw new Error(`找不到群聊：${input.chatId}`)

  const template = input.templateId ? store.roleTemplatesById[input.templateId] : undefined
  if (input.templateId && !template) throw new Error(`找不到人员库人员：${input.templateId}`)

  const name = assertValidRoleName(input.name ?? template?.name ?? '', getChatRoles(store, chat))
  const role: GroupRole = {
    id,
    chatId: input.chatId,
    chatSite: input.chatSite ?? template?.defaultChatSite ?? store.settings.defaultChatSite,
    name,
    status: 'pending',
    contextCursor: 0,
    createdAt: now,
    updatedAt: now,
  }

  if (input.templateId) role.templateId = input.templateId

  const description = (input.description ?? template?.description)?.trim()
  if (description) role.description = description

  const systemPrompt = (input.systemPrompt ?? template?.systemPrompt)?.trim()
  if (!systemPrompt) throw new Error('人设不能为空')
  role.systemPrompt = systemPrompt

  const avatarColor = input.avatarColor?.trim()
  if (avatarColor) role.avatarColor = avatarColor

  store.rolesById[id] = role
  chat.roleIds.push(id)
  chat.updatedAt = now
  return role
}

export function updateGroupRole(
  store: OpenTeamStore,
  roleId: string,
  patch: Partial<GroupRoleInput>,
  now: number,
): GroupRole {
  const role = store.rolesById[roleId]
  if (!role) throw new Error(`找不到人员：${roleId}`)

  const chat = store.chatsById[role.chatId]
  if (!chat) throw new Error(`找不到群聊：${role.chatId}`)

  if (patch.name !== undefined) role.name = assertValidRoleName(patch.name, getChatRoles(store, chat), roleId)
  if (patch.description !== undefined) {
    const description = patch.description.trim()
    if (description) {
      role.description = description
    } else {
      delete role.description
    }
  }
  if (patch.systemPrompt !== undefined) throw new Error('群聊内人员人设不可编辑')
  if (patch.chatSite !== undefined && patch.chatSite !== role.chatSite) {
    role.chatSite = patch.chatSite
    role.contextCursor = 0
    role.status = 'pending'
    delete role.geminiConversationId
    delete role.geminiConversationUrl
    delete role.lastPromptMessageId
    delete role.lastReplyAt
  }
  if (patch.avatarColor !== undefined) {
    const avatarColor = patch.avatarColor.trim()
    if (avatarColor) {
      role.avatarColor = avatarColor
    } else {
      delete role.avatarColor
    }
  }

  role.updatedAt = now
  chat.updatedAt = now
  return role
}

export function deleteGroupRole(store: OpenTeamStore, roleId: string, now: number): void {
  const role = store.rolesById[roleId]
  if (!role) return

  const chat = store.chatsById[role.chatId]
  if (chat) {
    chat.roleIds = chat.roleIds.filter(id => id !== roleId)
    chat.updatedAt = now
  }
  delete store.rolesById[roleId]
}

export function createGroupRolesBatch(
  store: OpenTeamStore,
  chatId: string,
  items: GroupRoleBatchInput[],
  idFactory: () => string,
  now: number,
): GroupRole[] {
  if (items.length === 0) throw new Error('添加人员列表不能为空')

  const chat = store.chatsById[chatId]
  if (!chat) throw new Error(`找不到群聊：${chatId}`)

  const existingNames = getChatRoles(store, chat).map(role => role.name)
  const prepared = items.map((item, index) => prepareBatchItem(store, item, index))
  const names = [...existingNames]
  for (const item of prepared) {
    const error = validateRoleName(item.name, names)
    if (error) throw new Error(error)
    names.push(item.name)
  }

  return prepared.map(item => createGroupRole(store, { chatId, ...item }, idFactory(), now))
}

function prepareBatchItem(store: OpenTeamStore, item: GroupRoleBatchInput, index: number): PreparedGroupRoleBatchItem {
  if (item.source === 'library') {
    const template = store.roleTemplatesById[item.roleTemplateId]
    if (!template) throw new Error(`找不到人员库人员：${item.roleTemplateId}`)
    return {
      templateId: item.roleTemplateId,
      chatSite: item.chatSite ?? template.defaultChatSite,
      name: assertValidRoleName(template.name, []),
      description: template.description,
      systemPrompt: assertValidSystemPrompt(template.systemPrompt),
      avatarColor: item.avatarColor,
    }
  }

  if (item.source === 'temporary') {
    return {
      chatSite: item.chatSite,
      name: assertValidRoleName(item.name, []),
      description: item.description,
      systemPrompt: assertValidSystemPrompt(item.systemPrompt),
      avatarColor: item.avatarColor,
    }
  }

  throw new Error(`第 ${index + 1} 个添加项无效`)
}

function assertValidSystemPrompt(systemPrompt: string | undefined): string {
  const trimmed = systemPrompt?.trim() ?? ''
  if (!trimmed) throw new Error('人设不能为空')
  return trimmed
}

function countUserPerceivedCharacters(value: string): number {
  const Segmenter = (Intl as IntlWithSegmenter).Segmenter
  if (!Segmenter) return [...value].length
  return [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length
}

function getChatRoles(store: OpenTeamStore, chat: GroupChat): GroupRole[] {
  return chat.roleIds
    .map(roleId => store.rolesById[roleId])
    .filter((role): role is GroupRole => Boolean(role))
}
