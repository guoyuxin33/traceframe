export type McpApprovalPolicy = 'always' | 'never'

export interface SkillDescriptor {
  id: string
  name: string
  description: string
  path: string
  sourceRoot: string
  enabled: boolean
}

export interface RemoteMcpServer {
  id: string
  name: string
  serverLabel: string
  serverUrl: string
  description: string
  authorization?: string
  allowedTools: string[]
  approvalPolicy: McpApprovalPolicy
  enabled: boolean
}

export interface IntegrationSettingsValue {
  skillRoots: string[]
  skills: SkillDescriptor[]
  mcpServers: RemoteMcpServer[]
}

export interface McpHealth {
  ok: boolean
  reachable: boolean
  latency: number
  status?: number
  detail: string
}

export type McpApprovalStatus = 'pending' | 'approved' | 'rejected'

export interface McpApprovalItem {
  approvalRequestId: string
  runId: string
  serverLabel: string
  toolName: string
  arguments: string
  parsedArguments: unknown
  requestedAt: number
  status: McpApprovalStatus
  reason: string
  resolvedAt?: number
}

export interface McpApprovalDecisionRequest {
  runId: string
  approvalRequestId: string
  approve: boolean
  reason?: string
}

export const emptyIntegrationSettings: IntegrationSettingsValue = {
  skillRoots: [],
  skills: [],
  mcpServers: [],
}
