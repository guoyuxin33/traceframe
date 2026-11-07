import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  PREVIEW_AUTO_LOAD_RETRY_LIMIT,
  PreviewPanel,
  buildElementPrompt,
  normalizePreviewUrl,
  parseCommandArguments,
  sanitizeTerminalCommand,
  validatePreviewSelectionMessage,
  type PreviewElementContext,
} from './PreviewPanel'
import type { PreviewNativeApi, PreviewProcessState } from './previewNative'

const stopped: PreviewProcessState = { phase: 'stopped', pid: null, url: null, startedAt: null, error: null }
const running: PreviewProcessState = { phase: 'running', pid: 2314, url: 'http://127.0.0.1:5173/', startedAt: 1_700_000_000_000, error: null }
const previewProxy = {
  proxyUrl: 'http://127.0.0.1:43123/preview/session/',
  sourceUrl: running.url!,
}

const selectedElement: PreviewElementContext = {
  tag: 'button',
  id: 'save',
  classes: ['primary', 'wide'],
  selector: 'main > button#save',
  text: 'Save changes',
  outerHTML: '<button id="save" class="primary wide">Save changes</button>',
  rect: { x: 12, y: 40, width: 160, height: 32 },
  url: 'http://127.0.0.1:5173/settings',
}

function previewApi(overrides: Partial<PreviewNativeApi> = {}): PreviewNativeApi {
  return {
    start: vi.fn().mockResolvedValue(running),
    restart: vi.fn().mockResolvedValue(running),
    stop: vi.fn().mockResolvedValue(stopped),
    status: vi.fn().mockResolvedValue(stopped),
    logs: vi.fn().mockResolvedValue([]),
    openProxy: vi.fn().mockResolvedValue(previewProxy),
    ...overrides,
  }
}

function selectionMessage(marker: string, payload: PreviewElementContext = selectedElement) {
  return {
    marker,
    source: 'traceframe-preview',
    version: 1,
    type: 'element.selected',
    payload,
  }
}

describe('preview helpers', () => {
  it('normalizes local addresses and parses quoted command arguments', () => {
    expect(normalizePreviewUrl('127.0.0.1:4173/app')).toBe('http://127.0.0.1:4173/app')
    expect(() => normalizePreviewUrl('file:///tmp/index.html')).toThrow(/HTTP/)
    expect(parseCommandArguments('run dev --host "127.0.0.1" --title \'hello world\'')).toEqual([
      'run', 'dev', '--host', '127.0.0.1', '--title', 'hello world',
    ])
    expect(() => parseCommandArguments('run "dev')).toThrow(/未闭合/)
    expect(sanitizeTerminalCommand('npm run build\nnpx vercel --prod\r\n')).toBe('npm run build npx vercel --prod')
  })

  it('only accepts bounded element messages from the expected proxy and project origins', () => {
    const valid = {
      data: selectionMessage('fixed-marker'),
      origin: 'http://127.0.0.1:43123',
      source: window,
    }
    const validate = (event: Pick<MessageEvent, 'data' | 'origin' | 'source'>) => validatePreviewSelectionMessage(
      event,
      window,
      'fixed-marker',
      'http://127.0.0.1:43123',
      'http://127.0.0.1:5173/',
    )
    expect(validate(valid)).toEqual(selectedElement)
    expect(validate({ ...valid, origin: 'http://127.0.0.1:5173' })).toBeNull()
    expect(validatePreviewSelectionMessage(valid, window, 'wrong-marker', 'http://127.0.0.1:43123', running.url!)).toBeNull()
    expect(validate({ ...valid, source: null })).toBeNull()
    expect(validate({
      ...valid,
      data: selectionMessage('fixed-marker', { ...selectedElement, url: 'http://127.0.0.1:9000/settings' }),
    })).toBeNull()
    expect(validatePreviewSelectionMessage({
      ...valid,
      data: selectionMessage('fixed-marker', { ...selectedElement, outerHTML: 'x'.repeat(20_001) }),
    }, window, 'fixed-marker', 'http://127.0.0.1:43123', running.url!)).toBeNull()
  })

  it('builds a structured prompt without submitting it', () => {
    const prompt = buildElementPrompt(selectedElement, 'Keep the keyboard focus ring.')
    expect(prompt).toContain('main > button#save')
    expect(prompt).toContain(selectedElement.outerHTML)
    expect(prompt).toContain('Keep the keyboard focus ring.')
    expect(prompt).toContain('重启并刷新')
  })
})

describe('PreviewPanel', () => {
  it('starts, loads, selects an element, and stages its context for conversation', async () => {
    const user = userEvent.setup()
    const api = previewApi({ status: vi.fn().mockResolvedValueOnce(stopped).mockResolvedValue(running) })
    const onAddToConversation = vi.fn()
    render(<PreviewPanel workspacePath="/workspace/demo" api={api} onAddToConversation={onAddToConversation} />)

    const emptyFrame = screen.getByTitle('项目预览') as HTMLIFrameElement
    expect(emptyFrame.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-modals allow-popups')
    expect(emptyFrame.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(emptyFrame.srcdoc).toContain('项目预览')

    await user.click(screen.getByRole('button', { name: '启动' }))
    expect(api.start).toHaveBeenCalledWith({ workspacePath: '/workspace/demo', program: 'npm', args: ['run', 'dev'] })

    await waitFor(() => expect(api.openProxy).toHaveBeenCalledWith(
      'http://127.0.0.1:5173/',
      expect.stringMatching(/^[a-f\d]{32}$/),
    ))
    const frame = screen.getByTitle('项目预览') as HTMLIFrameElement
    expect(frame.getAttribute('src')).toBe(previewProxy.proxyUrl)
    expect(frame.getAttribute('sandbox')).toContain('allow-same-origin')

    await user.click(screen.getByRole('button', { name: '选择页面元素' }))
    expect(screen.getByRole('button', { name: '选择页面元素' })).toHaveAttribute('aria-pressed', 'true')

    const marker = frame.dataset.previewMarker
    expect(marker).toMatch(/^[a-f\d]{32}$/)
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: selectionMessage(marker!),
        origin: 'http://127.0.0.1:43123',
        source: frame.contentWindow,
      }))
    })
    expect(screen.getByText('main > button#save')).toBeVisible()

    await user.type(screen.getByRole('textbox', { name: '补充修改要求' }), 'Align it with the form fields.')
    expect(onAddToConversation).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '添加到对话' }))
    expect(onAddToConversation).toHaveBeenCalledWith(expect.stringContaining('Align it with the form fields.'), selectedElement)

    await user.click(screen.getByRole('button', { name: '停止' }))
    await waitFor(() => expect(api.stop).toHaveBeenCalledTimes(1))
    await user.click(screen.getByRole('button', { name: '重启并刷新' }))
    expect(api.restart).toHaveBeenCalledTimes(1)
    expect(api.start).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(api.openProxy).toHaveBeenCalledTimes(2))
  })

  it('retries the same URL after restart when the proxy is not ready for the first open', async () => {
    const user = userEvent.setup()
    const openProxy = vi.fn()
      .mockResolvedValueOnce(previewProxy)
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValue({ ...previewProxy, proxyUrl: 'http://127.0.0.1:43124/preview/session/' })
    const api = previewApi({
      status: vi.fn().mockResolvedValueOnce(stopped).mockResolvedValue(running),
      openProxy,
    })
    render(<PreviewPanel workspacePath="/workspace/demo" api={api} onAddToConversation={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '载入' }))
    let frame = screen.getByTitle('项目预览') as HTMLIFrameElement
    expect(frame.getAttribute('src')).toBe(previewProxy.proxyUrl)

    await user.click(screen.getByRole('button', { name: '重启' }))

    await waitFor(() => expect(openProxy).toHaveBeenCalledTimes(3), { timeout: 3_000 })
    frame = screen.getByTitle('项目预览') as HTMLIFrameElement
    await waitFor(() => expect(frame.getAttribute('src')).toBe('http://127.0.0.1:43124/preview/session/'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('preserves the loaded frame and element selection when restart is rejected', async () => {
    const user = userEvent.setup()
    const api = previewApi({ restart: vi.fn().mockRejectedValue(new Error('invalid command')) })
    render(<PreviewPanel workspacePath="/workspace/demo" api={api} onAddToConversation={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '载入' }))
    const frame = screen.getByTitle('项目预览') as HTMLIFrameElement
    await user.click(screen.getByRole('button', { name: '选择页面元素' }))
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: selectionMessage(frame.dataset.previewMarker!),
        origin: 'http://127.0.0.1:43123',
        source: frame.contentWindow,
      }))
    })
    expect(screen.getByText('main > button#save')).toBeVisible()

    await user.click(screen.getByRole('button', { name: '重启并刷新' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('invalid command')
    expect((screen.getByTitle('项目预览') as HTMLIFrameElement).getAttribute('src')).toBe(previewProxy.proxyUrl)
    expect(screen.getByText('main > button#save')).toBeVisible()
    expect(api.openProxy).toHaveBeenCalledTimes(1)
  })

  it('stops automatic preview loading after the bounded retry window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const openProxy = vi.fn().mockRejectedValue(new Error('connection refused'))
    const api = previewApi({
      status: vi.fn().mockResolvedValue(running),
      openProxy,
    })

    try {
      render(<PreviewPanel workspacePath="/workspace/demo" api={api} onAddToConversation={vi.fn()} />)
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      for (let attempt = 1; attempt < PREVIEW_AUTO_LOAD_RETRY_LIMIT; attempt += 1) {
        await act(async () => {
          vi.advanceTimersByTime(750)
          await Promise.resolve()
          await Promise.resolve()
        })
      }

      expect(openProxy).toHaveBeenCalledTimes(PREVIEW_AUTO_LOAD_RETRY_LIMIT)
      await act(async () => vi.advanceTimersByTime(10_000))
      expect(openProxy).toHaveBeenCalledTimes(PREVIEW_AUTO_LOAD_RETRY_LIMIT)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a proxy response that escapes the loopback preview boundary', async () => {
    const user = userEvent.setup()
    const api = previewApi({
      openProxy: vi.fn().mockResolvedValue({
        proxyUrl: 'https://preview.example/session/',
        sourceUrl: running.url!,
      }),
    })
    render(<PreviewPanel workspacePath="/workspace/demo" api={api} onAddToConversation={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '载入' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('预览代理必须使用本机回环地址')
    expect((screen.getByTitle('项目预览') as HTMLIFrameElement).getAttribute('src')).toBeNull()
  })

  it('ignores forged messages and only prefills editable run and deploy commands in Terminal', async () => {
    const user = userEvent.setup()
    const api = previewApi()
    const onOpenTerminalCommand = vi.fn()
    render(<PreviewPanel
      workspacePath="/workspace/demo"
      api={api}
      onAddToConversation={vi.fn()}
      onOpenTerminalCommand={onOpenTerminalCommand}
    />)

    await user.click(screen.getByRole('button', { name: '载入' }))
    const frame = screen.getByTitle('项目预览') as HTMLIFrameElement
    fireEvent(window, new MessageEvent('message', {
      data: selectionMessage(frame.dataset.previewMarker!),
      origin: 'https://forged.example',
      source: frame.contentWindow,
    }))
    expect(screen.queryByText('main > button#save')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '在终端中编辑启动命令' }))
    expect(onOpenTerminalCommand).toHaveBeenCalledWith('npm run dev')
    expect(api.start).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '配置启动命令' }))
    const deployInput = screen.getByRole('textbox', { name: '部署命令' })
    await user.clear(deployInput)
    await user.type(deployInput, 'npm run build && npx vercel --prod')
    await user.click(screen.getByRole('button', { name: '在终端准备部署' }))
    expect(onOpenTerminalCommand).toHaveBeenLastCalledWith('npm run build && npx vercel --prod')
    expect(api.start).not.toHaveBeenCalled()
  })

  it('explains the no-workspace state and updates the preview guidance when a workspace opens', () => {
    const api = previewApi()
    const view = render(<PreviewPanel workspacePath={null} api={api} onAddToConversation={vi.fn()} />)

    const frame = screen.getByTitle('项目预览') as HTMLIFrameElement
    expect(frame.srcdoc).toContain('先打开工作区，再启动项目预览。')
    expect(screen.getByText('已停止')).toBeVisible()
    expect(screen.getByText('尚未载入页面')).toBeVisible()
    expect(screen.getByRole('button', { name: '启动' })).toBeDisabled()

    view.rerender(<PreviewPanel workspacePath="/workspace/demo" api={api} onAddToConversation={vi.fn()} />)
    expect((screen.getByTitle('项目预览') as HTMLIFrameElement).srcdoc).toContain('启动项目后将在此自动载入本地开发地址。')
  })
})
