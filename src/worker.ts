const API_PROXY_PREFIX = '/api-proxy'

interface AssetsBinding {
  fetch(request: Request): Promise<Response>
}

interface Env {
  ASSETS: AssetsBinding
  API_PROXY_URL?: string
  DEFAULT_API_URL?: string
  ENABLE_API_PROXY?: string
  LOCK_API_PROXY?: string
}

function readBoolean(value: string | undefined): boolean {
  return String.prototype.trim.call(value ?? '').toLowerCase() === 'true'
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function isApiProxyEnabled(env: Env): boolean {
  return readBoolean(env.ENABLE_API_PROXY)
}

function normalizeTargetBase(value: string | undefined): string | null {
  const trimmed = String.prototype.trim.call(value ?? '').replace(/\/+$/, '')
  if (!trimmed) return null

  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}

function createRuntimeEnv(env: Env): Record<string, string> {
  const proxyAvailable = isApiProxyEnabled(env)
  const config: Record<string, string> = {
    VITE_API_PROXY_AVAILABLE: proxyAvailable ? 'true' : 'false',
    VITE_API_PROXY_LOCKED: proxyAvailable && readBoolean(env.LOCK_API_PROXY) ? 'true' : 'false',
  }
  const defaultApiUrl = normalizeTargetBase(env.DEFAULT_API_URL)
  if (defaultApiUrl) config.VITE_DEFAULT_API_URL = defaultApiUrl
  return config
}

function createTargetUrl(requestUrl: URL, targetBase: string): URL | null {
  const proxyPath = requestUrl.pathname.slice(API_PROXY_PREFIX.length).replace(/^\/+/, '')
  if (!proxyPath || proxyPath.startsWith('//') || proxyPath.includes('\\') || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(proxyPath)) {
    return null
  }

  const targetUrl = new URL(proxyPath, `${targetBase}/`)
  targetUrl.search = requestUrl.search
  return targetUrl
}

function createProxyRequest(request: Request, targetUrl: URL): Request {
  const headers = new Headers(request.headers)
  for (const header of ['connection', 'host', 'keep-alive', 'origin', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']) {
    headers.delete(header)
  }

  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    redirect: 'follow',
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body
    init.duplex = 'half'
  }

  return new Request(targetUrl.toString(), init)
}

async function handleApiProxy(request: Request, env: Env): Promise<Response> {
  if (!isApiProxyEnabled(env)) return jsonError('API proxy is disabled', 404)
  if (!['GET', 'POST', 'OPTIONS'].includes(request.method)) return jsonError('Method not allowed', 405)
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 })

  const targetBase = normalizeTargetBase(env.API_PROXY_URL)
  if (!targetBase) return jsonError('API_PROXY_URL is not configured', 502)

  const targetUrl = createTargetUrl(new URL(request.url), targetBase)
  if (!targetUrl) return jsonError('API proxy path is invalid', 403)

  return fetch(createProxyRequest(request, targetUrl))
}

async function serveAsset(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request)
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!contentType.includes('text/html')) return response

  const runtimeConfig = JSON.stringify(createRuntimeEnv(env)).replace(/</g, '\\u003c')
  const runtimeScript = `<script>window.__GPT_IMAGE_RUNTIME_ENV__=${runtimeConfig};</script>`
  const html = await response.text()
  const body = html.includes('</head>')
    ? html.replace('</head>', `${runtimeScript}</head>`)
    : `${runtimeScript}${html}`
  const headers = new Headers(response.headers)
  headers.delete('Content-Length')
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === API_PROXY_PREFIX || url.pathname.startsWith(`${API_PROXY_PREFIX}/`)) {
      return handleApiProxy(request, env)
    }
    return serveAsset(request, env)
  },
}
