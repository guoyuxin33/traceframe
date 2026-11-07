import type { Message, RuntimeEventRecord } from '../../types'

export type ConversationTimelineItem =
  | { kind: 'message'; id: string; timestamp: number; message: Message }
  | { kind: 'run'; id: string; timestamp: number; events: RuntimeEventRecord[]; stepStart?: number; stepEnd?: number }

function messageTimestamp(message: Message, fallback: number) {
  return typeof message.createdAt === 'number' ? message.createdAt : fallback
}

export function conversationTimeline(messages: Message[], events: RuntimeEventRecord[]) {
  const timestampedMessages = messages.filter((message) => typeof message.createdAt === 'number')
  const hasMessageTimestamps = timestampedMessages.length === messages.length
  const messageItems: ConversationTimelineItem[] = messages.map((message, index) => ({
    kind: 'message',
    id: `message:${message.id}`,
    timestamp: messageTimestamp(message, Number.MIN_SAFE_INTEGER + index),
    message,
  }))

  const byRun = new Map<string, RuntimeEventRecord[]>()
  events.forEach((event) => byRun.set(event.runId, [...(byRun.get(event.runId) ?? []), event]))
  const runItems: ConversationTimelineItem[] = [...byRun.entries()].flatMap(([runId, runEvents], index) => {
    const ordered = runEvents.sort((left, right) => left.sequence - right.sequence || left.timestamp - right.timestamp)
    if (!hasMessageTimestamps) return [{
      kind: 'run' as const,
      id: `run:${runId}`,
      timestamp: Number.MAX_SAFE_INTEGER - byRun.size + index,
      events: ordered,
    }]

    const runStart = Math.min(...ordered.map((event) => event.timestamp))
    const runEnd = Math.max(...ordered.map((event) => event.timestamp))
    const guidanceBoundaries = messages
      .filter((message) => message.role === 'user' && typeof message.createdAt === 'number' && message.createdAt > runStart && message.createdAt < runEnd)
      .map((message) => message.createdAt as number)
      .sort((left, right) => left - right)
      .filter((timestamp, boundaryIndex, boundaries) => timestamp !== boundaries[boundaryIndex - 1])
    const boundaries = [runStart, ...guidanceBoundaries]

    return boundaries.flatMap((stepStart, segmentIndex) => {
      const stepEnd = boundaries[segmentIndex + 1]
      const hasEvents = ordered.some((event) => event.timestamp >= stepStart && (stepEnd === undefined || event.timestamp < stepEnd))
      if (!hasEvents) return []
      return [{
        kind: 'run' as const,
        id: `run:${runId}:${segmentIndex}`,
        timestamp: stepStart,
        events: ordered,
        stepStart,
        stepEnd,
      }]
    })
  })

  return [...messageItems, ...runItems].sort((left, right) => {
    if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp
    if (left.kind !== right.kind) return left.kind === 'message' ? -1 : 1
    return left.id.localeCompare(right.id)
  })
}
