import type { OrchestrationReviewResult, OrchestrationStage } from './types'

export interface BuildOrchestrationRoleMessageContentInput {
  userTask: string
  currentStage: OrchestrationStage
  previousReviewResult?: OrchestrationReviewResult
}

export interface BuildOrchestrationReviewMessageContentInput {
  userTask: string
  currentStage: OrchestrationStage
  reviewCriteria?: string
}

export function buildOrchestrationRoleMessageContent(input: BuildOrchestrationRoleMessageContentInput): string {
  const previousInstruction = input.previousReviewResult?.nextRoundInstruction?.trim()
  return joinSections([
    `当前任务：\n${input.userTask}`,
    input.currentStage.description ? `当前节点任务：\n${input.currentStage.description}` : undefined,
    previousInstruction ? `上次审核未通过要求：\n${previousInstruction}` : undefined,
  ])
}

export function buildOrchestrationReviewMessageContent(input: BuildOrchestrationReviewMessageContentInput): string {
  return joinSections([
    `当前任务：\n${input.userTask}`,
    input.currentStage.description ? `当前审核节点任务：\n${input.currentStage.description}` : undefined,
    `审核标准：\n${input.reviewCriteria?.trim() || input.currentStage.review?.instructions?.trim() || '判断当前结果是否满足任务要求。'}`,
    buildOrchestrationReviewResponseInstruction(),
  ])
}

export function buildOrchestrationReviewResponseInstruction(): string {
  return joinSections([
    '你必须只返回合法 JSON，不要 Markdown，不要解释文字，不要代码块。',
    `JSON 格式必须匹配：\n${reviewSchema()}`,
    'decision 只能是 pass 或 fail。不通过时使用 fail，并在 nextRoundInstruction 写清楚下一轮要改什么。',
  ])
}

function reviewSchema(): string {
  return JSON.stringify({
    decision: 'pass | fail',
    reason: '审核说明',
    failedCriteria: ['未满足的标准'],
    nextRoundInstruction: 'decision 为 fail 时必填，否则为空字符串',
  }, null, 2)
}

function joinSections(sections: Array<string | undefined>): string {
  return sections.filter((section): section is string => Boolean(section?.trim())).join('\n\n')
}
