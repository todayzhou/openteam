import { ROLE_NAME_MAX_CHARACTERS } from './roleTemplates'

export interface GeneratedPersonDraft {
  name: string
  description: string
  systemPrompt: string
}

export interface RoleTemplatePersonaPromptInput {
  description: string
}

export function buildRoleTemplatePersonaPrompt(input: RoleTemplatePersonaPromptInput): string {
  return [
    '你是 OpenTeam 的人员库人设生成器。',
    '只能返回 JSON，不能返回 Markdown，不能解释，不能使用代码块。',
    '',
    '目标：根据用户的一段描述，生成一个适合加入 AI 群聊的可复用人员。',
    '',
    '硬性要求：',
    `1. name 是简短人员名称，最多 ${ROLE_NAME_MAX_CHARACTERS} 个字。`,
    '2. description 是一句话职责摘要。',
    '3. systemPrompt 是可直接发给模型的人设提示词，要写清楚身份、工作方式、输出习惯和边界。',
    '4. systemPrompt 使用中文，避免空泛口号，尽量可执行。',
    '',
    '返回 JSON schema：',
    JSON.stringify({
      name: '增长顾问',
      description: '负责从获客、转化和复盘角度给建议。',
      systemPrompt: '你是增长顾问。先判断目标和约束，再给出可执行建议。',
    }, null, 2),
    '',
    '用户描述：',
    input.description.trim(),
  ].join('\n')
}

export function parseGeneratedPersonDraft(text: string): GeneratedPersonDraft {
  try {
    const parsed = JSON.parse(extractJsonObject(text))
    if (!isRecord(parsed)) throw new Error('not object')
    const name = truncateRoleName(readString(parsed.name))
    const description = readString(parsed.description)
    const systemPrompt = readString(parsed.systemPrompt)
    if (!name || !systemPrompt) throw new Error('missing required fields')
    return { name, description, systemPrompt }
  } catch {
    throw new Error('AI 生成人设返回格式无效')
  }
}

function truncateRoleName(value: string): string {
  return Array.from(value.trim()).slice(0, ROLE_NAME_MAX_CHARACTERS).join('')
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function extractJsonObject(text: string): string {
  const source = text.trim()
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('missing json object')
  return source.slice(start, end + 1)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
