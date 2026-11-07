import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { useConversationAutoscroll } from './useConversationAutoscroll'

function AutoscrollHarness({ sessionId, revision }: { sessionId: string; revision: string }) {
  const { streamRef, streamEndRef, following, onScroll, scrollToLatest } = useConversationAutoscroll(sessionId, revision)
  return <div>
    <div data-testid="stream" ref={streamRef} onScroll={onScroll}>
      <div ref={streamEndRef} />
    </div>
    <output>{following ? 'following' : 'paused'}</output>
    <button type="button" onClick={scrollToLatest}>Latest</button>
  </div>
}

describe('useConversationAutoscroll', () => {
  it('does not jump on new content while the user reads upward, then resumes with Latest', async () => {
    const user = userEvent.setup()
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    const view = render(<AutoscrollHarness sessionId="session-1" revision="message-1" />)
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))

    const stream = screen.getByTestId('stream')
    Object.defineProperties(stream, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    })
    fireEvent.scroll(stream)
    expect(screen.getByText('paused')).toBeVisible()

    view.rerender(<AutoscrollHarness sessionId="session-1" revision="message-2" />)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(stream.scrollTop).toBe(100)

    await user.click(screen.getByRole('button', { name: 'Latest' }))
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
    expect(stream.scrollTop).toBe(1_000)
    expect(screen.getByText('following')).toBeVisible()
  })

  it('resumes following when the active session changes', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    const view = render(<AutoscrollHarness sessionId="session-1" revision="message-1" />)
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))

    const stream = screen.getByTestId('stream')
    Object.defineProperties(stream, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    })
    fireEvent.scroll(stream)
    expect(screen.getByText('paused')).toBeVisible()

    view.rerender(<AutoscrollHarness sessionId="session-2" revision="message-1" />)
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2))
    expect(screen.getByText('following')).toBeVisible()
  })
})
