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
  time: string
  branch: string
  unread?: number
  active?: boolean
}

export interface Message {
  id: string
  author: string
  role: 'user' | 'agent' | 'system'
  time: string
  body: string
  meta?: string
  steps?: string[]
}

export interface Provider {
  id: string
  name: string
  endpoint: string
  model: string
  connected: boolean
  latency: number
}
