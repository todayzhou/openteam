import type { GroupMessage, GroupRole, OrchestrationFlow, OrchestrationReviewResult, OrchestrationStage } from './types'

export interface BuildOrchestrationRolePromptInput {
  userTask: string
  flow: OrchestrationFlow
  currentStage: OrchestrationStage
  role: GroupRole
  currentRound: number
  maxRounds?: number
  priorStageMessages?: GroupMessage[]
  previousReviewResult?: OrchestrationReviewResult
  previousReviewInstruction?: string
  maxContextChars?: number
}

export interface BuildOrchestrationReviewPromptInput {
  userTask: string
  flow: OrchestrationFlow
  currentStage: OrchestrationStage
  reviewCriteria?: string
  currentRound: number
  maxRounds?: number
  currentRoundOutputs: GroupMessage[]
  maxContextChars?: number
}

const DEFAULT_MAX_CONTEXT_CHARS = 6000

export function buildOrchestrationRolePrompt(input: BuildOrchestrationRolePromptInput): string {
  const flowText = formatFlowStages(input.flow)
  const priorContext = formatMessageList(input.priorStageMessages ?? [])
  const previousReviewInstruction = input.previousReviewInstruction ?? input.previousReviewResult?.nextRoundInstruction
  const previousReview = input.previousReviewResult ? formatPreviousReview(input.previousReviewResult) : undefined

  return trimPromptSections([
    `User task:\n${input.userTask}`,
    `Flow steps:\n${flowText}`,
    `Current round: ${input.currentRound} / ${input.maxRounds ?? input.flow.maxRounds}`,
    `Current step: ${input.currentStage.name} (${input.currentStage.kind}, id: ${input.currentStage.id})`,
    input.currentStage.description ? `Node task:\n${input.currentStage.description}` : undefined,
    `Your role: ${input.role.name}`,
    input.role.description ? `Role responsibility:\n${input.role.description}` : undefined,
    input.role.systemPrompt ? `Role persona:\n${input.role.systemPrompt}` : undefined,
    previousReviewInstruction ? `Previous review instruction for this round:\n${previousReviewInstruction}` : undefined,
    previousReview ? `Previous review result:\n${previousReview}` : undefined,
    priorContext ? `Prior completed step messages:\n${priorContext}` : 'Prior completed step messages:\nNone.',
    'Respond only for your assigned role in the current step. Use the completed prior-step context, but do not assume access to live outputs from peers running in the same step.',
  ], input.maxContextChars)
}

export function buildOrchestrationReviewPrompt(input: BuildOrchestrationReviewPromptInput): string {
  const outputs = formatMessageList(input.currentRoundOutputs)
  return trimPromptSections([
    `User task:\n${input.userTask}`,
    `Review criteria:\n${input.reviewCriteria?.trim() || input.currentStage.review?.instructions?.trim() || 'Decide whether the current round output satisfies the user task.'}`,
    `Current round: ${input.currentRound} / ${input.maxRounds ?? input.flow.maxRounds}`,
    `Current step: ${input.currentStage.name} (${input.currentStage.kind}, id: ${input.currentStage.id})`,
    input.currentStage.description ? `Node task:\n${input.currentStage.description}` : undefined,
    `Current-round outputs:\n${outputs || 'None.'}`,
    'Decision enum: pass | continue | stop',
    `Output only JSON matching this schema:\n${reviewSchema()}`,
    'Use decision "continue" only when another round is needed. When decision is "continue", nextRoundInstruction must be a non-empty instruction for the next round. Do not include markdown, prose, or code fences.',
  ], input.maxContextChars)
}

function formatFlowStages(flow: OrchestrationFlow): string {
  return flow.stages.map((stage, index) => {
    const roleText = stage.roleIds.length > 0 ? stage.roleIds.join(', ') : 'none'
    const reviewText = stage.review?.instructions ? `; review: ${stage.review.instructions}` : ''
    return `${index + 1}. ${stage.name} (${stage.kind}, id: ${stage.id}; roles: ${roleText}${reviewText})`
  }).join('\n')
}

function formatMessageList(messages: GroupMessage[]): string {
  return messages
    .map(message => {
      const source = message.roleName ?? message.roleId ?? message.type
      const step = message.orchestrationStageId ? `, step: ${message.orchestrationStageId}` : ''
      return `[${source}${step}, seq: ${message.seq}]\n${message.content}`
    })
    .join('\n\n')
}

function formatPreviousReview(result: OrchestrationReviewResult): string {
  return [
    `decision: ${result.decision}`,
    `reason: ${result.reason}`,
    `failedCriteria: ${result.failedCriteria.length > 0 ? result.failedCriteria.join('; ') : 'none'}`,
    result.nextRoundInstruction ? `nextRoundInstruction: ${result.nextRoundInstruction}` : undefined,
  ].filter((line): line is string => Boolean(line)).join('\n')
}

function reviewSchema(): string {
  return JSON.stringify({
    decision: 'pass | continue | stop',
    reason: 'non-empty string',
    failedCriteria: ['string'],
    nextRoundInstruction: 'string; required and non-empty when decision is continue',
  }, null, 2)
}

function trimPromptSections(sections: Array<string | undefined>, maxContextChars = DEFAULT_MAX_CONTEXT_CHARS): string {
  const required = sections.filter((section): section is string => Boolean(section?.trim()))
  const prompt = required.join('\n\n')
  if (prompt.length <= maxContextChars) return prompt

  const suffix = '\n\n[Earlier context was omitted to fit the context limit.]\n'
  const preservedHead = required.slice(0, 4).join('\n\n')
  const preservedTail = required.slice(4).join('\n\n')
  const remaining = maxContextChars - preservedHead.length - suffix.length
  if (remaining <= 0) return preservedHead.slice(0, maxContextChars)
  return `${preservedHead}${suffix}${preservedTail.slice(-remaining).trimStart()}`
}
