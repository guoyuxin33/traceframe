export type PermissionMode = 'request-approval' | 'full-access'
export type ApprovalDecision = 'accept' | 'reject'
export type ApprovalFileStatus = 'pending' | 'accepted' | 'rejected'
export type ApprovalBatchStatus = 'pending' | 'accepted' | 'rejected' | 'partially-accepted'

export interface ApprovalFile {
  id: string
  batchId: string
  path: string
  status: ApprovalFileStatus
  diff: string
  startLine: number
  endLine: number
  decidedAt?: number
  decisionReason: string
}

export interface ApprovalAudit {
  id: string
  batchId: string
  fileId: string
  path: string
  decision: ApprovalDecision
  reason: string
  actor: string
  createdAt: number
}

export interface ApprovalBatch {
  id: string
  sessionId: string
  runId: string
  workspacePath: string
  permissionMode: PermissionMode
  status: ApprovalBatchStatus
  files: ApprovalFile[]
  decisions: ApprovalAudit[]
  createdAt: number
  resolvedAt?: number
}

export interface ApprovalDecisionRequest {
  batchId: string
  paths?: string[]
  decision: ApprovalDecision
  reason?: string
}
