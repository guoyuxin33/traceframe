import type { RuntimeEventRecord } from '../../types'
import type { McpApprovalItem } from './types'

function eventKey(runId: string, approvalRequestId: string) {
  return `${runId}\u0000${approvalRequestId}`
}

function nonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null
}

export function parseMcpArguments(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function formatMcpArguments(value: string) {
  const parsed = parseMcpArguments(value)
  if (parsed === value) return value
  return JSON.stringify(parsed, null, 2)
}

export function mcpApprovalItemKey(item: Pick<McpApprovalItem, 'runId' | 'approvalRequestId'>) {
  return eventKey(item.runId, item.approvalRequestId)
}

export function mcpApprovalItemsFromEvents(
  events: RuntimeEventRecord[],
  { includeResolved = false }: { includeResolved?: boolean } = {},
) {
  const ordered = [...events].sort((left, right) => (
    left.sequence - right.sequence
    || left.timestamp - right.timestamp
    || left.id.localeCompare(right.id)
  ))
  const seenEventIds = new Set<string>()
  const items = new Map<string, McpApprovalItem>()
  const deferredResolutions = new Map<string, { approve: boolean; reason: string; timestamp: number }>()

  ordered.forEach((event) => {
    const eventIdentity = `${event.runId}\u0000${event.id}`
    if (seenEventIds.has(eventIdentity)) return
    seenEventIds.add(eventIdentity)
    if (event.type !== 'mcp.approval.requested' && event.type !== 'mcp.approval.resolved') return

    const approvalRequestId = nonEmptyString(event.payload.approvalRequestId)
    const runId = nonEmptyString(event.runId)
    if (!approvalRequestId || !runId) return
    const key = eventKey(runId, approvalRequestId)

    if (event.type === 'mcp.approval.requested') {
      const serverLabel = nonEmptyString(event.payload.serverLabel)
      const toolName = nonEmptyString(event.payload.name)
      const argumentsText = typeof event.payload.arguments === 'string' ? event.payload.arguments : null
      if (!serverLabel || !toolName || argumentsText === null) return

      const existing = items.get(key)
      if (existing && existing.status !== 'pending') return
      const resolution = deferredResolutions.get(key)
      items.set(key, {
        approvalRequestId,
        runId,
        serverLabel,
        toolName,
        arguments: argumentsText,
        parsedArguments: parseMcpArguments(argumentsText),
        requestedAt: existing?.requestedAt ?? event.timestamp,
        status: resolution ? (resolution.approve ? 'approved' : 'rejected') : 'pending',
        reason: resolution?.reason ?? '',
        resolvedAt: resolution?.timestamp,
      })
      return
    }

    if (typeof event.payload.approve !== 'boolean') return
    const resolution = {
      approve: event.payload.approve,
      reason: typeof event.payload.reason === 'string' ? event.payload.reason : '',
      timestamp: event.timestamp,
    }
    deferredResolutions.set(key, resolution)
    const existing = items.get(key)
    if (!existing) return
    items.set(key, {
      ...existing,
      status: resolution.approve ? 'approved' : 'rejected',
      reason: resolution.reason,
      resolvedAt: resolution.timestamp,
    })
  })

  return [...items.values()]
    .filter((item) => includeResolved || item.status === 'pending')
    .sort((left, right) => right.requestedAt - left.requestedAt || mcpApprovalItemKey(left).localeCompare(mcpApprovalItemKey(right)))
}
