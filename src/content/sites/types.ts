export interface ConversationSnapshot {
  conversationId?: string
  conversationUrl?: string
}

export interface ChatSiteAdapter {
  readonly id: string
  getConversationSnapshot(): ConversationSnapshot
  getConversationId(): string
  getResponseContainers(): Element[]
  getAllAssistantReplies(): string[]
  readResponseText(node: Node): string
  findResponseContainer(element: Element | null): Element | null
  isGenerating(): boolean
  fillAndSend(content: string, autoSend?: boolean): Promise<void>
  collectPromptDiagnostics(): Record<string, unknown>
}
