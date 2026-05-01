import type { GroupRole } from './types'

export type ParsedGroupMention =
  | {
      ok: true
      content: string
      targetRoleIds: string[]
      mentionedRoleIds: string[]
    }
  | {
      ok: false
      error: string
    }

export function parseGroupMentions(raw: string, roles: GroupRole[]): ParsedGroupMention {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, error: '消息内容不能为空' }

  const allRoleIds = roles.map(role => role.id)
  if (!trimmed.includes('@')) {
    return { ok: true, content: trimmed, targetRoleIds: allRoleIds, mentionedRoleIds: [] }
  }

  const sortedRoles = [...roles].sort((left, right) => right.name.length - left.name.length)
  const targetRoleIds = new Set<string>()
  let targetsAll = false
  let content = ''
  let index = 0

  while (index < trimmed.length) {
    if (trimmed[index] !== '@') {
      content += trimmed[index]
      index += 1
      continue
    }

    if (mentionMatches(trimmed, index, 'all')) {
      targetsAll = true
      index += 4
      continue
    }

    const role = sortedRoles.find(candidate => mentionMatches(trimmed, index, candidate.name))
    if (!role) {
      content += trimmed[index]
      index += 1
      continue
    }

    targetRoleIds.add(role.id)
    index += role.name.length + 1
  }

  const parsedContent = compactContent(content)
  if (!parsedContent) return { ok: false, error: '消息内容不能为空' }

  return {
    ok: true,
    content: parsedContent,
    targetRoleIds: targetsAll ? allRoleIds : targetRoleIds.size > 0 ? [...targetRoleIds] : allRoleIds,
    mentionedRoleIds: [...targetRoleIds],
  }
}

function mentionMatches(raw: string, atIndex: number, target: string): boolean {
  if (!raw.startsWith(`@${target}`, atIndex)) return false
  const next = raw[atIndex + target.length + 1]
  return next === undefined || /\s|[，。！？,.!?;；:：]/.test(next)
}

function compactContent(raw: string): string {
  return raw.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}
