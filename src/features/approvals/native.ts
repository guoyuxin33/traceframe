import { invoke } from '@tauri-apps/api/core'
import type { ApprovalBatch, ApprovalDecisionRequest } from './types'

export function getApprovalBatches(sessionId: string) {
  return invoke<ApprovalBatch[]>('approval_batches', { sessionId })
}

export function decideApproval(request: ApprovalDecisionRequest) {
  return invoke<ApprovalBatch>('approval_decide', { request })
}
