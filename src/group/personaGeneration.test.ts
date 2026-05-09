import { describe, expect, it } from 'vitest'
import { buildRoleTemplatePersonaPrompt, parseGeneratedPersonDraft } from './personaGeneration'

describe('role template persona generation', () => {
  it('builds a strict JSON prompt from the user description', () => {
    const prompt = buildRoleTemplatePersonaPrompt({ description: '一个擅长小红书增长的内容顾问' })

    expect(prompt).toContain('一个擅长小红书增长的内容顾问')
    expect(prompt).toContain('只能返回 JSON')
    expect(prompt).toContain('"name"')
    expect(prompt).toContain('"description"')
    expect(prompt).toContain('"systemPrompt"')
  })

  it('parses generated persona JSON and trims the role name to the supported length', () => {
    const generated = parseGeneratedPersonDraft(`\`\`\`json
{
  "name": "${'增长顾问'.repeat(20)}",
  "description": "负责从获客、转化和复盘角度给建议。",
  "systemPrompt": "你是增长顾问。先判断目标和约束，再给出可执行建议。"
}
\`\`\``)

    expect(Array.from(generated.name)).toHaveLength(50)
    expect(generated.name).toBe('增长顾问'.repeat(12) + '增长')
    expect(generated.description).toBe('负责从获客、转化和复盘角度给建议。')
    expect(generated.systemPrompt).toContain('先判断目标和约束')
  })

  it('rejects invalid model output without a persona prompt', () => {
    expect(() => parseGeneratedPersonDraft('{"name":"观察员"}')).toThrow('AI 生成人设返回格式无效')
  })
})
