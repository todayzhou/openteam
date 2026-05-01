import type { GroupChat, GroupRole, OpenTeamStore, RoleTemplate } from './types'

export interface RoleTemplateInput {
  name: string
  description?: string
  systemPrompt?: string
}

export interface GroupRoleInput {
  chatId: string
  templateId?: string
  name?: string
  description?: string
  systemPrompt?: string
}

export function validateRoleName(name: string, existingNames: string[] = []): string | undefined {
  const trimmed = name.trim()
  if (!trimmed) return '角色名称不能为空'
  if (/\s/.test(trimmed)) return '角色名称不能包含空白字符'
  if (trimmed.includes('@')) return '角色名称不能包含 @'
  if (trimmed.toLowerCase() === 'all') return '角色名称不能是 all'
  if (existingNames.some(existingName => existingName.toLowerCase() === trimmed.toLowerCase())) return `角色名称已存在：${trimmed}`
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
  const template: RoleTemplate = {
    id,
    name,
    systemPrompt: input.systemPrompt?.trim() ?? '',
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
  if (!template) throw new Error(`找不到角色模板：${templateId}`)

  template.name = assertValidRoleName(patch.name, [])
  template.systemPrompt = patch.systemPrompt?.trim() ?? ''
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
  delete store.roleTemplatesById[templateId]
  store.roleTemplateOrder = store.roleTemplateOrder.filter(id => id !== templateId)
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
  if (input.templateId && !template) throw new Error(`找不到角色模板：${input.templateId}`)

  const name = assertValidRoleName(input.name ?? template?.name ?? '', getChatRoles(store, chat))
  const role: GroupRole = {
    id,
    chatId: input.chatId,
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
  if (systemPrompt) role.systemPrompt = systemPrompt

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
  if (!role) throw new Error(`找不到角色：${roleId}`)

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
  if (patch.systemPrompt !== undefined) {
    const systemPrompt = patch.systemPrompt.trim()
    if (systemPrompt) {
      role.systemPrompt = systemPrompt
    } else {
      delete role.systemPrompt
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

function getChatRoles(store: OpenTeamStore, chat: GroupChat): GroupRole[] {
  return chat.roleIds
    .map(roleId => store.rolesById[roleId])
    .filter((role): role is GroupRole => Boolean(role))
}
