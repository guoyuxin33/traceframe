import { useCallback, useEffect, useRef, useState } from 'react'

const FOLLOW_THRESHOLD_PX = 72

export function useConversationAutoscroll(sessionId: string, contentRevision: string) {
  const streamRef = useRef<HTMLDivElement>(null)
  const streamEndRef = useRef<HTMLDivElement>(null)
  const followingRef = useRef(true)
  const previousSessionRef = useRef(sessionId)
  const [following, setFollowing] = useState(true)

  const scrollToLatest = useCallback(() => {
    const stream = streamRef.current
    if (stream) stream.scrollTop = stream.scrollHeight
    streamEndRef.current?.scrollIntoView({ block: 'nearest' })
    followingRef.current = true
    setFollowing(true)
  }, [])

  useEffect(() => {
    const sessionChanged = previousSessionRef.current !== sessionId
    previousSessionRef.current = sessionId
    if (sessionChanged) {
      followingRef.current = true
      setFollowing(true)
    }
    if (followingRef.current) scrollToLatest()
  }, [contentRevision, scrollToLatest, sessionId])

  const onScroll = useCallback(() => {
    const stream = streamRef.current
    if (!stream) return
    const nearBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight <= FOLLOW_THRESHOLD_PX
    if (nearBottom === followingRef.current) return
    followingRef.current = nearBottom
    setFollowing(nearBottom)
  }, [])

  return { streamRef, streamEndRef, following, onScroll, scrollToLatest }
}
