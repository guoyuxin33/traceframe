import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value: vi.fn(),
})

Object.defineProperty(window, 'requestAnimationFrame', {
  configurable: true,
  value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0),
})

// xterm's canvas renderer is not available in jsdom. Component tests replace
// this with an instrumented mock when they need to assert terminal I/O.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    loadAddon() {}
    open() {}
    reset() {}
    write() {}
    writeln() {}
    focus() {}
    clear() {}
    dispose() {}
    onData() { return { dispose() {} } }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))

afterEach(() => {
  cleanup()
  localStorage.clear()
})
