import { describe, expect, it } from 'vitest'
import { buildOrchestrationReviewPrompt, buildOrchestrationRolePrompt } from './orchestrationPrompts'
import type { GroupMessage, GroupRole, OrchestrationFlow, OrchestrationReviewResult } from './types'

describe('orchestration prompt builders', () => {
  it('builds role prompts from stage-node flow context', () => {
    const flow = makeFlow()
    const prompt = buildOrchestrationRolePrompt({
      userTask: 'Create a launch plan.',
      flow,
      currentStage: flow.stages[1],
      role: makeRole('role-writer', 'Writer', 'Drafts the plan', 'Write clearly.'),
      currentRound: 2,
      priorStageMessages: [makeMessage('msg-1', 'role-researcher', 'Researcher', 'Research summary', 'stage-research')],
      previousReviewResult: makeReviewResult(),
      maxContextChars: 6000,
    })

    expect(prompt).toContain('User task:\nCreate a launch plan.')
    expect(prompt).toContain('Flow steps:')
    expect(prompt).toContain('1. Research (roles, id: stage-research; roles: role-researcher)')
    expect(prompt).toContain('2. Draft (roles, id: stage-draft; roles: role-writer, role-editor)')
    expect(prompt).toContain('Current step: Draft (roles, id: stage-draft)')
    expect(prompt).not.toContain('Current round:')
    expect(prompt).toContain('Node task:\nTurn the research into a launch-ready draft.')
    expect(prompt).not.toContain('Flow stages:')
    expect(prompt).not.toContain('Current stage:')
    expect(prompt).not.toContain('Stage task:')
    expect(prompt).toContain('Your role: Writer')
    expect(prompt).toContain('Role responsibility:\nDrafts the plan')
    expect(prompt).toContain('Role persona:\nWrite clearly.')
    expect(prompt).toContain('Previous review instruction:\nAddress launch risks.')
    expect(prompt).toContain('[Researcher, step: stage-research, seq: 1]\nResearch summary')
  })

  it('gives same-stage parallel roles the same prior-stage context only', () => {
    const flow = makeFlow()
    const priorStageMessages = [makeMessage('msg-1', 'role-researcher', 'Researcher', 'Shared prior context', 'stage-research')]
    const writerPrompt = buildOrchestrationRolePrompt({
      userTask: 'Create a launch plan.',
      flow,
      currentStage: flow.stages[1],
      role: makeRole('role-writer', 'Writer'),
      currentRound: 1,
      priorStageMessages,
    })
    const editorPrompt = buildOrchestrationRolePrompt({
      userTask: 'Create a launch plan.',
      flow,
      currentStage: flow.stages[1],
      role: makeRole('role-editor', 'Editor'),
      currentRound: 1,
      priorStageMessages,
    })

    expect(writerPrompt).toContain('Shared prior context')
    expect(editorPrompt).toContain('Shared prior context')
    expect(writerPrompt).not.toContain('Editor output')
    expect(editorPrompt).not.toContain('Writer output')
  })

  it('builds review prompts with review instructions and JSON-only schema', () => {
    const flow = makeFlow()
    const prompt = buildOrchestrationReviewPrompt({
      userTask: 'Create a launch plan.',
      flow,
      currentStage: flow.stages[2],
      reviewCriteria: 'Plan must include risks and owner.',
      currentRound: 1,
      currentRoundOutputs: [makeMessage('msg-2', 'role-writer', 'Writer', 'Draft output', 'stage-draft')],
    })

    expect(prompt).toContain('Review criteria:\nPlan must include risks and owner.')
    expect(prompt).not.toContain('Outputs to review:')
    expect(prompt).not.toContain('Draft output')
    expect(prompt).not.toContain('Current round:')
    expect(prompt).toContain('Decision enum: pass | continue | stop')
    expect(prompt).toContain('"nextRoundInstruction": "string; required and non-empty when decision is continue"')
    expect(prompt).toContain('Output only JSON')
  })

  it('trims long context while preserving task and latest prior output without round metadata', () => {
    const flow = makeFlow()
    const prompt = buildOrchestrationRolePrompt({
      userTask: 'Create a launch plan.',
      flow,
      currentStage: flow.stages[1],
      role: makeRole('role-writer', 'Writer'),
      currentRound: 1,
      priorStageMessages: [
        makeMessage('msg-old', 'role-researcher', 'Researcher', 'old '.repeat(500), 'stage-research'),
        makeMessage('msg-new', 'role-researcher', 'Researcher', 'Latest prior output', 'stage-research'),
      ],
      maxContextChars: 900,
    })

    expect(prompt.length).toBeLessThanOrEqual(900)
    expect(prompt).toContain('User task:\nCreate a launch plan.')
    expect(prompt).not.toContain('Current round:')
    expect(prompt).toContain('Latest prior output')
  })
})

function makeFlow(): OrchestrationFlow {
  return {
    id: 'flow-1',
    chatId: 'chat-1',
    name: 'Launch flow',
    stages: [
      { id: 'stage-research', kind: 'roles', name: 'Research', roleIds: ['role-researcher'] },
      { id: 'stage-draft', kind: 'roles', name: 'Draft', roleIds: ['role-writer', 'role-editor'], description: 'Turn the research into a launch-ready draft.' },
      { id: 'stage-review', kind: 'review', name: 'Review', roleIds: [], review: { reviewerRoleIds: ['role-reviewer'], instructions: 'Check completeness.' } },
    ],
    maxRounds: 3,
    createdAt: 1,
    updatedAt: 1,
  }
}

function makeRole(id: string, name: string, description?: string, systemPrompt?: string): GroupRole {
  return {
    id,
    chatId: 'chat-1',
    name,
    description,
    systemPrompt,
    status: 'ready',
    contextCursor: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

function makeMessage(id: string, roleId: string, roleName: string, content: string, orchestrationStageId: string): GroupMessage {
  return {
    id,
    chatId: 'chat-1',
    seq: 1,
    type: 'assistant',
    content,
    roleId,
    roleName,
    orchestrationStageId,
    createdAt: 1,
    status: 'received',
  }
}

function makeReviewResult(): OrchestrationReviewResult {
  return {
    round: 1,
    stageRunId: 'stage-run-1',
    reviewerRoleId: 'role-reviewer',
    messageId: 'msg-review',
    decision: 'continue',
    reason: 'Missing launch risks.',
    failedCriteria: ['risks'],
    nextRoundInstruction: 'Address launch risks.',
    rawJson: '{"decision":"continue"}',
    createdAt: 1,
  }
}
