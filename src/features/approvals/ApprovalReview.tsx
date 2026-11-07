import { Check, CheckCheck, ChevronDown, FileDiff, LoaderCircle, ShieldAlert, ShieldCheck, X, XCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { decideApproval, getApprovalBatches } from './native'
import type { ApprovalBatch, ApprovalDecision, ApprovalDecisionRequest, PermissionMode } from './types'
import './approvals.css'

function decisionLabel(decision: ApprovalDecision) {
  return decision === 'accept' ? 'Accept' : 'Reject'
}

function statusLabel(status: ApprovalBatch['status']) {
  if (status === 'partially-accepted') return 'Partially accepted'
  return status[0].toUpperCase() + status.slice(1)
}

export function PermissionModeControl({ value, disabled = false, onChange }: {
  value: PermissionMode
  disabled?: boolean
  onChange: (value: PermissionMode) => void
}) {
  return <fieldset className="permission-mode" disabled={disabled} aria-label="AI file access">
    <legend>AI file access</legend>
    <label className={value === 'request-approval' ? 'is-active' : ''}>
      <input aria-label="Request approval" type="radio" name="permission-mode" value="request-approval" checked={value === 'request-approval'} onChange={() => onChange('request-approval')} />
      <ShieldAlert size={14} />
      <span><strong>Request approval</strong><small>Pause after edits for file-by-file review</small></span>
    </label>
    <label className={value === 'full-access' ? 'is-active' : ''}>
      <input aria-label="Full access" type="radio" name="permission-mode" value="full-access" checked={value === 'full-access'} onChange={() => onChange('full-access')} />
      <ShieldCheck size={14} />
      <span><strong>Full access</strong><small>Keep edits automatically and record the diff</small></span>
    </label>
  </fieldset>
}

function DiffLines({ diff }: { diff: string }) {
  return <pre className="approval-diff" aria-label="File changes">{diff.split('\n').map((line, index) => {
    const kind = line.startsWith('+') && !line.startsWith('+++')
      ? 'is-added'
      : line.startsWith('-') && !line.startsWith('---')
        ? 'is-removed'
        : line.startsWith('@@')
          ? 'is-hunk'
          : ''
    return <span className={kind} key={`${index}:${line.slice(0, 24)}`}>{line || ' '}</span>
  })}</pre>
}

function ApprovalBatchView({ batch, busy, onDecide }: {
  batch: ApprovalBatch
  busy: boolean
  onDecide: (request: ApprovalDecisionRequest) => Promise<void>
}) {
  const pending = batch.files.filter((file) => file.status === 'pending')
  return <section className={`approval-batch is-${batch.status}`} aria-label={`Approval for run ${batch.runId}`}>
    <header className="approval-batch-header">
      <span className="approval-batch-mark">{batch.status === 'pending' ? <ShieldAlert size={15} /> : <ShieldCheck size={15} />}</span>
      <span><strong>{pending.length ? `${pending.length} file${pending.length === 1 ? '' : 's'} awaiting review` : statusLabel(batch.status)}</strong><small>{batch.permissionMode === 'full-access' ? 'Full access' : 'Request approval'} · {batch.runId}</small></span>
      <code>{batch.files.length}</code>
    </header>
    {batch.files.map((file) => <details className={`approval-file is-${file.status}`} open={file.status === 'pending'} key={file.id}>
      <summary>
        <ChevronDown className="approval-disclosure" size={13} />
        <FileDiff size={13} />
        <span><strong>{file.path}</strong><small>Lines {file.startLine}-{file.endLine}</small></span>
        <em>{file.status}</em>
      </summary>
      <DiffLines diff={file.diff} />
      {file.status === 'pending' ? <footer className="approval-file-actions">
        <button type="button" disabled={busy} className="is-reject" onClick={() => onDecide({ batchId: batch.id, paths: [file.path], decision: 'reject' })}><X size={13} />Reject file</button>
        <button type="button" disabled={busy} className="is-accept" onClick={() => onDecide({ batchId: batch.id, paths: [file.path], decision: 'accept' })}><Check size={13} />Accept file</button>
      </footer> : file.decisionReason ? <p className="approval-decision-note">{file.decisionReason}</p> : null}
    </details>)}
    {pending.length ? <footer className="approval-batch-actions">
      <button type="button" disabled={busy} className="is-reject" onClick={() => onDecide({ batchId: batch.id, decision: 'reject' })}>{busy ? <LoaderCircle className="is-spinning" size={13} /> : <XCircle size={13} />}Reject all</button>
      <button type="button" disabled={busy} className="is-accept" onClick={() => onDecide({ batchId: batch.id, decision: 'accept' })}>{busy ? <LoaderCircle className="is-spinning" size={13} /> : <CheckCheck size={13} />}Accept all</button>
    </footer> : null}
  </section>
}

export function ApprovalReview({ batches, busyBatchId = null, onDecide }: {
  batches: ApprovalBatch[]
  busyBatchId?: string | null
  onDecide: (request: ApprovalDecisionRequest) => Promise<void>
}) {
  const ordered = useMemo(() => [...batches].sort((left, right) => right.createdAt - left.createdAt), [batches])
  if (!ordered.length) return <div className="approval-empty"><ShieldCheck size={16} /><span>No AI file changes to review</span></div>
  return <div className="approval-review">{ordered.map((batch) => <ApprovalBatchView batch={batch} busy={busyBatchId === batch.id} onDecide={onDecide} key={batch.id} />)}</div>
}

export function ApprovalReviewPanel({ sessionId, batchId, refreshToken = '', loadBatches = getApprovalBatches, decide = decideApproval, onChanged }: {
  sessionId: string
  batchId?: string
  refreshToken?: string
  loadBatches?: (sessionId: string) => Promise<ApprovalBatch[]>
  decide?: (request: ApprovalDecisionRequest) => Promise<ApprovalBatch>
  onChanged?: (batch: ApprovalBatch) => void
}) {
  const [batches, setBatches] = useState<ApprovalBatch[]>([])
  const [busyBatchId, setBusyBatchId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setError(null)
    void loadBatches(sessionId).then((next) => {
      if (active) setBatches(batchId ? next.filter((batch) => batch.id === batchId) : next)
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { active = false }
  }, [batchId, loadBatches, refreshToken, sessionId])

  const onDecide = useCallback(async (request: ApprovalDecisionRequest) => {
    setBusyBatchId(request.batchId)
    setError(null)
    try {
      const updated = await decide(request)
      setBatches((current) => [updated, ...current.filter((batch) => batch.id !== updated.id)])
      onChanged?.(updated)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyBatchId(null)
    }
  }, [decide, onChanged])

  return <div className="approval-panel">
    {error ? <p className="approval-error" role="alert">{error}</p> : null}
    <ApprovalReview batches={batches} busyBatchId={busyBatchId} onDecide={onDecide} />
  </div>
}

export { decisionLabel }
