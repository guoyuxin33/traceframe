import type { Agent, Message, Provider, Session } from './types'

export const initialSessions: Session[] = [
  { id: 's1', title: 'Auth flow rebuild', summary: 'OAuth callback + session refresh', time: 'NOW', branch: 'feat/auth-v2', unread: 3, active: true },
  { id: 's2', title: 'Dashboard latency', summary: 'Trace slow queries in analytics', time: '18m', branch: 'perf/dashboard' },
  { id: 's3', title: 'Billing webhook', summary: 'Handle retry and idempotency', time: '2h', branch: 'fix/stripe-hook' },
  { id: 's4', title: 'Design token sync', summary: 'Normalize theme primitives', time: '1d', branch: 'chore/tokens' },
]

export const initialMessages: Message[] = [
  {
    id: 'm1',
    author: 'You',
    role: 'user',
    time: '14:28:03',
    body: '重构认证流程。保留现有 API 契约，把 token refresh 移到服务端，并补齐并发请求测试。',
    meta: 'priority: high · scope: auth/*',
  },
  {
    id: 'm2',
    author: 'Orchestrator',
    role: 'agent',
    time: '14:28:11',
    body: '已读取认证模块与最近 12 次相关提交。当前风险点是浏览器端 refresh token、并发 401 风暴、旧 cookie 迁移。我已拆成 3 个并行任务。',
    meta: 'Claude Sonnet 4.5 · 2.8k tokens',
    steps: ['读取 src/auth 与 middleware', '建立 worktree feat/auth-v2', '派发 Security / Backend / Test 智能体'],
  },
  {
    id: 'm3',
    author: 'Cipher · security',
    role: 'agent',
    time: '14:29:42',
    body: '发现 refresh token 被写入 localStorage。正在迁移到 HttpOnly / SameSite=Lax cookie，并保留 7 天兼容窗口。',
    meta: 'o3 · isolated worktree · running',
  },
]

export const initialAgents: Agent[] = [
  { id: 'root', name: 'Orchestrator', role: 'Lead agent', model: 'Claude Sonnet 4.5', state: 'working', progress: 68, task: '协调任务与审查变更', color: 'cyan' },
  { id: 'security', name: 'Cipher', role: 'Security', model: 'o3', state: 'working', progress: 74, parent: 'root', task: '迁移 refresh token', color: 'magenta' },
  { id: 'backend', name: 'Forge', role: 'Backend', model: 'GPT-5 Codex', state: 'working', progress: 51, parent: 'root', task: '实现服务端 token rotation', color: 'amber' },
  { id: 'test', name: 'Probe', role: 'Test', model: 'Gemini 2.5 Pro', state: 'done', progress: 100, parent: 'root', task: '并发 401 测试矩阵', color: 'green' },
  { id: 'review', name: 'Sentry', role: 'Review', model: 'Claude Sonnet 4.5', state: 'queued', progress: 0, parent: 'root', task: '等待合并后审查', color: 'cyan' },
]

export const initialProviders: Provider[] = [
  { id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-5-codex', connected: true, latency: 184 },
  { id: 'anthropic', name: 'Anthropic', endpoint: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', connected: true, latency: 236 },
  { id: 'google', name: 'Google AI', endpoint: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-pro', connected: true, latency: 291 },
  { id: 'ollama', name: 'Ollama / Local', endpoint: 'http://127.0.0.1:11434', model: 'qwen3-coder:30b', connected: false, latency: 0 },
]

export const codeLines = [
  ['1', "import { cookies } from 'next/headers'"],
  ['2', "import { rotateToken } from '@/lib/auth/token'"],
  ['3', ''],
  ['4', 'const REFRESH_COOKIE = \'nexus_refresh\''],
  ['5', ''],
  ['6', 'export async function POST(request: Request) {'],
  ['7', '  const cookieStore = await cookies()'],
  ['8', '  const refreshToken = cookieStore.get(REFRESH_COOKIE)?.value'],
  ['9', ''],
  ['10', '  if (!refreshToken) {'],
  ['11', "    return Response.json({ error: 'unauthorized' }, { status: 401 })"],
  ['12', '  }'],
  ['13', ''],
  ['14', '  const session = await rotateToken(refreshToken)'],
  ['15', '  cookieStore.set(REFRESH_COOKIE, session.refreshToken, {'],
  ['16', '    httpOnly: true,'],
  ['17', '    sameSite: \'lax\','],
  ['18', '    secure: process.env.NODE_ENV === \'production\','],
  ['19', '    path: \'/\','],
  ['20', '    maxAge: 60 * 60 * 24 * 7,'],
  ['21', '  })'],
  ['22', ''],
  ['23', '  return Response.json({ accessToken: session.accessToken })'],
  ['24', '}'],
]

export const diffLines = [
  { type: 'context', old: '23', next: '23', text: 'export async function refreshSession() {' },
  { type: 'remove', old: '24', next: '', text: "  const token = localStorage.getItem('refresh_token')" },
  { type: 'remove', old: '25', next: '', text: "  if (!token) throw new AuthError('missing token')" },
  { type: 'add', old: '', next: '24', text: "  const response = await fetch('/api/auth/refresh', {" },
  { type: 'add', old: '', next: '25', text: "    method: 'POST'," },
  { type: 'add', old: '', next: '26', text: "    credentials: 'include'," },
  { type: 'add', old: '', next: '27', text: '  })' },
  { type: 'context', old: '26', next: '28', text: '' },
  { type: 'remove', old: '27', next: '', text: '  return api.post(\'/auth/refresh\', { token })' },
  { type: 'add', old: '', next: '29', text: '  if (!response.ok) throw new AuthError(\'refresh failed\')' },
  { type: 'add', old: '', next: '30', text: '  return response.json()' },
  { type: 'context', old: '28', next: '31', text: '}' },
]
