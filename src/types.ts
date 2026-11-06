export type AgentState = 'working' | 'done' | 'queued'

export interface Agent {
  id: string
  name: string
  role: string
  model: string
  state: AgentState
  progress: number
  parent?: string
  task: string
  color: 'cyan' | 'amber' | 'magenta' | 'green'
}

export interface Session {
  id: string
  title: string
  summary: string
  contextSummary?: string
  compactedMessageCount?: number
  time: string
  branch: string
  workspacePath?: string
  archived?: boolean
  createdAt?: number
  updatedAt?: number
  unread?: number
  active?: boolean
}

export interface Message {
  id: string
  sessionId?: string
  author: string
  role: 'user' | 'agent' | 'system'
  time: string
  body: string
  meta?: string
  steps?: string[]
  createdAt?: number
}

export interface Provider {
  id: string
  name: string
  endpoint: string
  model: string
  adapter: 'cc-switch-responses' | 'openai-responses' | 'openai-chat' | 'anthropic' | 'google'
  connected: boolean
  latency: number
  detail?: string
  apiKey?: string
  availableModels?: string[]
  catalogModels?: string[]
}

export type MemoryScope = 'session' | 'project' | 'global'

export interface MemoryRecord {
  id: string
  title: string
  detail: string
  type: 'Decision' | 'Preference' | 'Project' | 'Constraint'
  scope: MemoryScope
  time: string
  sessionId?: string
  workspacePath?: string
  createdAt?: number
}

export interface RuntimeEventRecord {
  id: string
  sessionId: string
  runId: string
  sequence: number
  type: string
  payload: Record<string, unknown>
  timestamp: number
}
