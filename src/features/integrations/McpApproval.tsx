import { Check, LoaderCircle, Server, ShieldCheck, ShieldX, Wrench, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { RuntimeEventRecord } from '../../types'
import { decideMcpApproval } from './native'
import { formatMcpArguments, mcpApprovalItemKey, mcpApprovalItemsFromEvents } from './mcpApprovals'
import type { McpApprovalDecisionRequest, McpApprovalItem } from './types'
import './integrations.css'

function statusLabel(item: McpApprovalItem) {
  if (item.status === 'approved') return 'Allowed'
  if (item.status === 'rejected') return 'Rejected'
  return 'Approval required'
}

export function McpApproval({
  events,
  showResolved = false,
  decide = decideMcpApproval,
  onDecided,
}: {
  events: RuntimeEventRecord[]
  showResolved?: boolean
  decide?: (request: McpApprovalDecisionRequest) => Promise<boolean>
  onDecided?: (item: McpApprovalItem, approve: boolean) => void
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [submittedKeys, setSubmittedKeys] = useState<Set<string>>(() => new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const approvals = useMemo(
    () => mcpApprovalItemsFromEvents(events, { includeResolved: showResolved })
      .filter((item) => !submittedKeys.has(mcpApprovalItemKey(item))),
    [events, showResolved, submittedKeys],
  )

  const decideItem = async (item: McpApprovalItem, approve: boolean) => {
    const key = mcpApprovalItemKey(item)
    setBusyKey(key)
    setErrors((current) => ({ ...current, [key]: '' }))
    try {
      const accepted = await decide({
        runId: item.runId,
        approvalRequestId: item.approvalRequestId,
        approve,
      })
      if (!accepted) throw new Error('This tool call is no longer awaiting approval')
      setSubmittedKeys((current) => new Set(current).add(key))
      onDecided?.(item, approve)
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [key]: error instanceof Error ? error.message : String(error),
      }))
    } finally {
      setBusyKey(null)
    }
  }

  if (!approvals.length) return null

  return <div className="mcp-approval-list" aria-label="MCP tool approvals">
    {approvals.map((item) => {
      const key = mcpApprovalItemKey(item)
      const busy = busyKey === key
      const pending = item.status === 'pending'
      return <article className={`mcp-approval is-${item.status}`} aria-label={`Approval for ${item.serverLabel} ${item.toolName}`} key={key}>
        <header className="mcp-approval-header">
          <span className="mcp-approval-mark">{pending ? <Wrench size={14} /> : item.status === 'approved' ? <ShieldCheck size={14} /> : <ShieldX size={14} />}</span>
          <span className="mcp-approval-title"><strong>{item.toolName}</strong><small><Server size={11} />{item.serverLabel}</small></span>
          <span className="mcp-approval-status">{statusLabel(item)}</span>
        </header>
        <div className="mcp-approval-context"><span>Run</span><code>{item.runId}</code><span>Request</span><code>{item.approvalRequestId}</code></div>
        <details className="mcp-approval-arguments" open>
          <summary>Arguments</summary>
          <pre aria-label={`Arguments for ${item.toolName}`}>{formatMcpArguments(item.arguments)}</pre>
        </details>
        {errors[key] ? <p className="mcp-approval-error" role="alert">{errors[key]}</p> : null}
        {pending ? <footer className="mcp-approval-actions">
          <button type="button" className="is-reject" disabled={busy} onClick={() => void decideItem(item, false)}><X size={13} />Reject</button>
          <button type="button" className="is-allow" disabled={busy} onClick={() => void decideItem(item, true)}>{busy ? <LoaderCircle className="is-spinning" size={13} /> : <Check size={13} />}Allow tool</button>
        </footer> : item.reason ? <p className="mcp-approval-reason">{item.reason}</p> : null}
      </article>
    })}
  </div>
}
