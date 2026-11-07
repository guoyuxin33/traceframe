import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApprovalReviewPanel, PermissionModeControl } from './ApprovalReview'
import type { ApprovalBatch } from './types'

const pendingBatch: ApprovalBatch = {
  id: 'approval-1',
  sessionId: 'session-1',
  runId: 'run-1',
  workspacePath: '/tmp/project',
  permissionMode: 'request-approval',
  status: 'pending',
  files: [{
    id: 'file-1',
    batchId: 'approval-1',
    path: 'src/main.ts',
    status: 'pending',
    diff: '--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n',
    startLine: 1,
    endLine: 1,
    decisionReason: '',
  }],
  decisions: [],
  createdAt: 100,
}

describe('PermissionModeControl', () => {
  it('exposes both approval and full access modes', () => {
    const onChange = vi.fn()
    render(<PermissionModeControl value="request-approval" onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('Full access'))
    expect(onChange).toHaveBeenCalledWith('full-access')
  })
})

describe('ApprovalReviewPanel', () => {
  it('shows the exact diff and can accept a single file', async () => {
    const loadBatches = vi.fn().mockResolvedValue([pendingBatch])
    const decide = vi.fn().mockResolvedValue({
      ...pendingBatch,
      status: 'accepted',
      files: [{ ...pendingBatch.files[0], status: 'accepted' }],
      resolvedAt: 200,
    })
    render(<ApprovalReviewPanel sessionId="session-1" loadBatches={loadBatches} decide={decide} />)
    await screen.findByText('src/main.ts')
    expect(screen.getByLabelText('File changes')).toHaveTextContent('-old')
    expect(screen.getByLabelText('File changes')).toHaveTextContent('+new')

    fireEvent.click(screen.getByRole('button', { name: 'Accept file' }))
    await waitFor(() => expect(decide).toHaveBeenCalledWith({
      batchId: 'approval-1',
      paths: ['src/main.ts'],
      decision: 'accept',
    }))
    expect(await screen.findByText('Accepted')).toBeVisible()
  })

  it('supports rejecting the whole pending batch', async () => {
    const decide = vi.fn().mockResolvedValue({
      ...pendingBatch,
      status: 'rejected',
      files: [{ ...pendingBatch.files[0], status: 'rejected' }],
      resolvedAt: 200,
    })
    render(<ApprovalReviewPanel sessionId="session-1" loadBatches={async () => [pendingBatch]} decide={decide} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Reject all' }))
    await waitFor(() => expect(decide).toHaveBeenCalledWith({ batchId: 'approval-1', decision: 'reject' }))
  })

  it('supports rejecting a single file without deciding the rest of the batch', async () => {
    const secondFile = {
      ...pendingBatch.files[0],
      id: 'file-2',
      path: 'src/other.ts',
    }
    const batch = { ...pendingBatch, files: [pendingBatch.files[0], secondFile] }
    const decide = vi.fn().mockResolvedValue({
      ...batch,
      files: [
        { ...pendingBatch.files[0], status: 'rejected' as const },
        secondFile,
      ],
    })
    render(<ApprovalReviewPanel sessionId="session-1" loadBatches={async () => [batch]} decide={decide} />)

    const rejectButtons = await screen.findAllByRole('button', { name: 'Reject file' })
    fireEvent.click(rejectButtons[0])

    await waitFor(() => expect(decide).toHaveBeenCalledWith({
      batchId: 'approval-1',
      paths: ['src/main.ts'],
      decision: 'reject',
    }))
    expect(await screen.findByText('rejected')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Accept file' })).toBeEnabled()
  })

  it('accepts every pending file and reports the updated batch', async () => {
    const secondFile = {
      ...pendingBatch.files[0],
      id: 'file-2',
      path: 'src/other.ts',
    }
    const batch = { ...pendingBatch, files: [pendingBatch.files[0], secondFile] }
    const accepted = {
      ...batch,
      status: 'accepted' as const,
      files: batch.files.map((file) => ({ ...file, status: 'accepted' as const })),
      resolvedAt: 200,
    }
    const decide = vi.fn().mockResolvedValue(accepted)
    const onChanged = vi.fn()
    render(<ApprovalReviewPanel
      sessionId="session-1"
      loadBatches={async () => [batch]}
      decide={decide}
      onChanged={onChanged}
    />)

    fireEvent.click(await screen.findByRole('button', { name: 'Accept all' }))

    await waitFor(() => expect(decide).toHaveBeenCalledWith({ batchId: 'approval-1', decision: 'accept' }))
    expect(onChanged).toHaveBeenCalledWith(accepted)
    expect(await screen.findByText('Accepted')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Accept all' })).not.toBeInTheDocument()
  })

  it('keeps a failed decision actionable so the user can retry', async () => {
    const accepted = {
      ...pendingBatch,
      status: 'accepted' as const,
      files: [{ ...pendingBatch.files[0], status: 'accepted' as const }],
      resolvedAt: 200,
    }
    const decide = vi.fn()
      .mockRejectedValueOnce(new Error('Workspace changed after review'))
      .mockResolvedValueOnce(accepted)
    render(<ApprovalReviewPanel sessionId="session-1" loadBatches={async () => [pendingBatch]} decide={decide} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Reject file' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Workspace changed after review')

    fireEvent.click(screen.getByRole('button', { name: 'Accept file' }))
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Accepted')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps full-access changes inspectable without offering a second decision', async () => {
    const fullAccessBatch: ApprovalBatch = {
      ...pendingBatch,
      permissionMode: 'full-access',
      status: 'accepted',
      files: [{
        ...pendingBatch.files[0],
        status: 'accepted',
        decisionReason: 'Full access mode',
      }],
      decisions: [{
        id: 'audit-1',
        batchId: pendingBatch.id,
        fileId: pendingBatch.files[0].id,
        path: pendingBatch.files[0].path,
        decision: 'accept',
        reason: 'Full access mode',
        actor: 'policy',
        createdAt: 100,
      }],
      resolvedAt: 100,
    }
    render(<ApprovalReviewPanel sessionId="session-1" loadBatches={async () => [fullAccessBatch]} />)

    const user = userEvent.setup()
    const file = await screen.findByText('src/main.ts')
    await user.click(file.closest('summary')!)
    expect(screen.getByText('Full access mode')).toBeVisible()
    expect(screen.getByLabelText('File changes')).toHaveTextContent('+new')
    expect(screen.queryByRole('button', { name: /Accept|Reject/ })).not.toBeInTheDocument()
  })

  it('renders only the batch requested by an inline timeline event', async () => {
    const otherBatch: ApprovalBatch = {
      ...pendingBatch,
      id: 'approval-2',
      files: [{ ...pendingBatch.files[0], id: 'file-2', batchId: 'approval-2', path: 'src/other.ts' }],
    }
    render(<ApprovalReviewPanel
      sessionId="session-1"
      batchId="approval-1"
      loadBatches={async () => [otherBatch, pendingBatch]}
    />)

    expect(await screen.findByText('src/main.ts')).toBeVisible()
    expect(screen.queryByText('src/other.ts')).not.toBeInTheDocument()
  })
})
