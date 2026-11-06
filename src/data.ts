import type { Agent, MemoryRecord, Message, Provider, Session } from './types'

// Current general-purpose text and code models from the official OpenAI model catalog.
export const OFFICIAL_OPENAI_TEXT_MODELS = [
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-6.1-terra',
  'gpt-6-luna',
  'gpt-5.6-sol',
]

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
    body: '已读取认证模块与最近 12 次相关提交。当前风险点是浏览器端 refresh token、并发 401 风暴、旧 cookie 迁移。我将按顺序委派安全、后端与测试检查。',
    meta: 'gpt-6.1-sol · 2.8k tokens',
    steps: ['读取 src/auth 与 middleware', '委派安全检查', '整合后端与测试结果'],
  },
  {
    id: 'm3',
    author: 'Cipher · security',
    role: 'agent',
    time: '14:29:42',
    body: '发现 refresh token 被写入 localStorage。正在迁移到 HttpOnly / SameSite=Lax cookie，并保留 7 天兼容窗口。',
    meta: 'gpt-6.1-sol · delegated specialist · running',
  },
]

export const initialAgents: Agent[] = [
  { id: 'root', name: 'Orchestrator', role: 'Lead agent', model: 'gpt-6.1-sol', state: 'working', progress: 68, task: '协调串行委派并审查结果', color: 'cyan' },
  { id: 'security', name: 'Cipher', role: 'Security', model: 'gpt-6.1-sol', state: 'working', progress: 74, parent: 'root', task: '检查 refresh token 边界', color: 'magenta' },
  { id: 'backend', name: 'Forge', role: 'Backend', model: 'gpt-6.1-sol', state: 'queued', progress: 0, parent: 'root', task: '等待安全检查完成', color: 'amber' },
  { id: 'test', name: 'Probe', role: 'Test', model: 'gpt-6.1-sol', state: 'done', progress: 100, parent: 'root', task: '完成并发 401 测试审计', color: 'green' },
]

export const initialSessionMessages: Record<string, Message[]> = {
  s1: initialMessages,
  s2: [
    {
      id: 's2-m1',
      author: 'You',
      role: 'user',
      time: '13:52:08',
      body: '定位 analytics 页面首屏延迟，先给出慢查询和瀑布图证据，再决定是否改缓存。',
      meta: 'scope: analytics/*',
    },
    {
      id: 's2-m2',
      author: 'Orchestrator',
      role: 'agent',
      time: '13:52:19',
      body: '已建立性能调查清单。当前先读取查询计划、请求瀑布和最近的 dashboard 提交，不会在证据齐全前改缓存策略。',
      meta: 'Configured provider · investigation',
    },
  ],
  s3: [
    {
      id: 's3-m1',
      author: 'You',
      role: 'user',
      time: '11:41:02',
      body: '补齐 Stripe webhook 的重放保护，要求重复事件不产生第二次记账。',
      meta: 'scope: billing/webhooks/*',
    },
  ],
  s4: [
    {
      id: 's4-m1',
      author: 'You',
      role: 'user',
      time: '09:16:44',
      body: '核对桌面端三个主题的 token，找出仍在直接写颜色值的组件。',
      meta: 'scope: src/styles.css',
    },
  ],
}

export const initialSessionAgents: Record<string, Agent[]> = {
  s1: initialAgents,
  s2: [
    { id: 'root-s2', name: 'Orchestrator', role: 'Lead agent', model: 'Unassigned', state: 'working', progress: 42, task: '汇总性能证据', color: 'cyan' },
    { id: 'query-s2', name: 'Index', role: 'Database', model: 'o3', state: 'working', progress: 61, parent: 'root-s2', task: '分析慢查询计划', color: 'amber' },
    { id: 'trace-s2', name: 'Relay', role: 'Trace', model: 'Gemini 2.5 Pro', state: 'queued', progress: 0, parent: 'root-s2', task: '等待浏览器瀑布数据', color: 'green' },
  ],
  s3: [
    { id: 'root-s3', name: 'Orchestrator', role: 'Lead agent', model: 'Claude Sonnet 4.5', state: 'working', progress: 27, task: '核对 webhook 契约', color: 'cyan' },
    { id: 'ledger-s3', name: 'Ledger', role: 'Backend', model: 'Unassigned', state: 'queued', progress: 0, parent: 'root-s3', task: '实现幂等写入', color: 'magenta' },
  ],
  s4: [
    { id: 'root-s4', name: 'Orchestrator', role: 'Lead agent', model: 'Claude Sonnet 4.5', state: 'done', progress: 100, task: '完成 token 清单', color: 'cyan' },
  ],
}

export const initialMemories: MemoryRecord[] = [
  { id: 'mem-auth', title: 'Auth architecture', detail: 'Refresh tokens remain server-only', type: 'Decision', scope: 'session', time: '2m', sessionId: 's1' },
  { id: 'mem-tests', title: 'Testing preference', detail: 'Use fake timers for rotation tests', type: 'Preference', scope: 'session', time: '18m', sessionId: 's1' },
  { id: 'mem-errors', title: 'Repository convention', detail: 'API routes return typed errors', type: 'Project', scope: 'project', time: '2h' },
  { id: 'mem-cookie', title: 'Migration constraint', detail: 'Support legacy cookie for 7 days', type: 'Constraint', scope: 'global', time: '2m' },
]

export const initialProviders: Provider[] = [
  { id: 'cc-switch', name: 'CC Switch', endpoint: 'http://127.0.0.1:15721/v1', model: '', adapter: 'cc-switch-responses', connected: false, latency: 0 },
  { id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: '', adapter: 'openai-responses', connected: false, latency: 0, catalogModels: OFFICIAL_OPENAI_TEXT_MODELS },
  { id: 'anthropic', name: 'Anthropic', endpoint: 'https://api.anthropic.com/v1', model: '', adapter: 'anthropic', connected: false, latency: 0 },
  { id: 'google', name: 'Google AI', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '', adapter: 'openai-chat', connected: false, latency: 0 },
  { id: 'ollama', name: 'Ollama / Local', endpoint: 'http://127.0.0.1:11434/v1', model: '', adapter: 'openai-chat', connected: false, latency: 0 },
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
