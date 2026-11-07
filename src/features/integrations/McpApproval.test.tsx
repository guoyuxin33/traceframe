import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeEventRecord } from '../../types'
import { McpApproval } from './McpApproval'
import { mcpApprovalItemsFromEvents } from './mcpApprovals'
import { decideMcpApproval } from './native'

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }))

function runtimeEvent(
  id: string,
  runId: string,
  sequence: number,
  type: RuntimeEventRecord['type'],
  payload: Record<string, unknown>,
): RuntimeEventRecord {
  return { id, sessionId: 'session-1', runId, sequence, type, payload, timestamp: 1_000 + sequence }
}

function requested(id = 'approval-1', runId = 'run-1', sequence = 1, argumentsText = '{"query":"runtime events"}') {
  return runtimeEvent(`requested-${runId}-${id}`, runId, sequence, 'mcp.approval.requested', {
    approvalRequestId: id,
    serverLabel: 'docs_server',
    name: 'search_docs',
    arguments: argumentsText,
  })
}

function resolved(id = 'approval-1', runId = 'run-1', sequence = 2, approve = true) {
  return runtimeEvent(`resolved-${runId}-${id}`, runId, sequence, 'mcp.approval.resolved', {
    approvalRequestId: id,
    serverLabel: 'docs_server',
    name: 'search_docs',
    approve,
    reason: approve ? 'Allowed by user' : 'Rejected by user',
  })
}

describe('McpApproval', () => {
  it('shows the server, tool, and formatted arguments for a pending request', () => {
    render(<McpApproval events={[requested()]} />)
    expect(screen.getByText('search_docs')).toBeVisible()
    expect(screen.getByText('docs_server')).toBeVisible()
    expect(screen.getByLabelText('Arguments for search_docs')).toHaveTextContent('"query": "runtime events"')
  })

  it('forwards allow and reject decisions with the exact run-scoped request', async () => {
    const decide = vi.fn().mockResolvedValue(true)
    const { rerender } = render(<McpApproval events={[requested('allow-me')]} decide={decide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow tool' }))
    await waitFor(() => expect(decide).toHaveBeenCalledWith({
      runId: 'run-1',
      approvalRequestId: 'allow-me',
      approve: true,
    }))

    rerender(<McpApproval events={[requested('reject-me')]} decide={decide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    await waitFor(() => expect(decide).toHaveBeenCalledWith({
      runId: 'run-1',
      approvalRequestId: 'reject-me',
      approve: false,
    }))
  })

  it('invokes the registered native approval command', async () => {
    tauri.invoke.mockResolvedValueOnce(true)
    await expect(decideMcpApproval({ runId: 'run-7', approvalRequestId: 'approval-9', approve: false })).resolves.toBe(true)
    expect(tauri.invoke).toHaveBeenCalledWith('mcp_approval_decide', {
      request: { runId: 'run-7', approvalRequestId: 'approval-9', approve: false },
    })
  })

  it('keeps an expired request visible and explains why it was not decided', async () => {
    const decide = vi.fn().mockResolvedValue(false)
    render(<McpApproval events={[requested()]} decide={decide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow tool' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer awaiting approval')
    expect(screen.getByRole('button', { name: 'Allow tool' })).toBeEnabled()
  })

  it('hides resolved requests by default and makes included history read-only', () => {
    const events = [requested(), resolved()]
    const { rerender } = render(<McpApproval events={events} />)
    expect(screen.queryByLabelText('MCP tool approvals')).not.toBeInTheDocument()

    rerender(<McpApproval events={events} showResolved />)
    expect(screen.getByText('Allowed')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Allow tool' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument()
  })

  it('renders malformed argument JSON as raw text', () => {
    render(<McpApproval events={[requested('raw', 'run-1', 1, '{not-json')]} />)
    expect(screen.getByLabelText('Arguments for search_docs')).toHaveTextContent('{not-json')
  })

  it('keeps identical approval IDs independent across runs and deduplicates snapshots', () => {
    const first = requested('shared', 'run-1', 1)
    const second = requested('shared', 'run-2', 1, '{"query":"other"}')
    const items = mcpApprovalItemsFromEvents([first, first, second, resolved('shared', 'run-1', 2, false)])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ runId: 'run-2', approvalRequestId: 'shared', status: 'pending' })
  })

  it('ignores malformed approval events without breaking valid requests', () => {
    const malformed = runtimeEvent('malformed', 'run-1', 0, 'mcp.approval.requested', { approvalRequestId: 'bad' })
    expect(mcpApprovalItemsFromEvents([malformed, requested()])).toHaveLength(1)
  })
})
