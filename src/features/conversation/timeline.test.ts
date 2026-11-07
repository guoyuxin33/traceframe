import { describe, expect, it } from 'vitest'
import type { Message, RuntimeEventRecord } from '../../types'
import { conversationTimeline } from './timeline'

function message(id: string, role: Message['role'], createdAt: number): Message {
  return { id, author: role, role, time: 'now', body: id, createdAt }
}

function event(sequence: number, type: RuntimeEventRecord['type'], timestamp: number, runId = 'run-1'): RuntimeEventRecord {
  return { id: `${runId}:${sequence}`, sessionId: 'session-1', runId, sequence, type, payload: {}, timestamp }
}

describe('conversationTimeline', () => {
  it('places ordered tool activity between its user request and agent response', () => {
    const items = conversationTimeline(
      [message('request', 'user', 100), message('response', 'agent', 500)],
      [
        event(4, 'tool.completed', 350),
        event(1, 'run.created', 200),
        event(5, 'run.completed', 400),
        event(3, 'file.changed', 300),
        event(2, 'tool.started', 250),
      ],
    )

    expect(items.map((item) => item.id)).toEqual(['message:request', 'run:run-1:0', 'message:response'])
    const run = items[1]
    expect(run.kind).toBe('run')
    if (run.kind === 'run') expect(run.events.map((item) => item.sequence)).toEqual([1, 2, 3, 4, 5])
  })

  it('starts a new execution segment after inline active-run guidance', () => {
    const items = conversationTimeline(
      [
        message('request', 'user', 100),
        message('guidance', 'user', 300),
        message('response', 'agent', 600),
      ],
      [
        event(1, 'run.created', 200),
        event(2, 'tool.started', 250),
        event(3, 'run.steered', 320),
        event(4, 'tool.completed', 400),
        event(5, 'run.completed', 500),
      ],
    )

    expect(items.map((item) => item.id)).toEqual([
      'message:request',
      'run:run-1:0',
      'message:guidance',
      'run:run-1:1',
      'message:response',
    ])
    expect(items[1]).toMatchObject({ kind: 'run', stepStart: 200, stepEnd: 300 })
    expect(items[3]).toMatchObject({ kind: 'run', stepStart: 300, stepEnd: undefined })
  })

  it('keeps independent runs beside the messages that started them', () => {
    const items = conversationTimeline(
      [
        message('request-1', 'user', 100),
        message('response-1', 'agent', 300),
        message('request-2', 'user', 400),
        message('response-2', 'agent', 600),
      ],
      [
        event(1, 'run.created', 150, 'run-1'),
        event(2, 'run.completed', 250, 'run-1'),
        event(1, 'run.created', 450, 'run-2'),
        event(2, 'run.completed', 550, 'run-2'),
      ],
    )

    expect(items.map((item) => item.id)).toEqual([
      'message:request-1',
      'run:run-1:0',
      'message:response-1',
      'message:request-2',
      'run:run-2:0',
      'message:response-2',
    ])
  })

  it('falls back to stable message-first ordering when legacy messages have no timestamps', () => {
    const legacy = [
      { ...message('request', 'user', 100), createdAt: undefined },
      { ...message('response', 'agent', 500), createdAt: undefined },
    ]
    const items = conversationTimeline(legacy, [event(1, 'run.created', 200)])

    expect(items.map((item) => item.id)).toEqual(['message:request', 'message:response', 'run:run-1'])
  })
})
