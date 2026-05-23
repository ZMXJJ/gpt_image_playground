const API_PROXY_PREFIX = '/api-proxy'
const ALLOWED_PROXY_PATH = /^(?:v1\/)?(?:images\/generations|images\/edits|responses)$/

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

function isAllowedProxyPath(proxyPath: string): boolean {
  return ALLOWED_PROXY_PATH.test(proxyPath.replace(/^\/+/, ''))
}

function createTargetUrl(requestUrl: URL, targetBase: string): URL | null {
  const proxyPath = requestUrl.pathname.slice(API_PROXY_PREFIX.length).replace(/^\/+/, '')
  if (!proxyPath || proxyPath.startsWith('//') || proxyPath.includes('\\') || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(proxyPath)) {
    return null
  }
  if (!isAllowedProxyPath(proxyPath)) return null

  const targetUrl = new URL(proxyPath, `${targetBase}/`)
  targetUrl.search = requestUrl.search
  return targetUrl
}

function createProxyRequest(request: Request, targetUrl: URL): Request {
  const headers = new Headers(request.headers)
  for (const header of ['connection', 'host', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']) {
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

// Cloudflare returns HTTP 524 if the Worker does not start a response within ~120s.
const UPSTREAM_HEADER_TIMEOUT_MS = 100_000
const PROXY_KEEPALIVE_INTERVAL_MS = 25_000

function passthroughResponse(upstream: Response): Response {
  const headers = new Headers(upstream.headers)
  headers.delete('content-length')
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  })
}

async function pipeBody(source: Response, controller: ReadableStreamDefaultController<Uint8Array>) {
  if (!source.body) return
  const reader = source.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) controller.enqueue(value)
  }
}

function createKeepaliveProxyResponse(upstreamPromise: Promise<Response>): Response {
  const encoder = new TextEncoder()
  let keepAliveTimer: ReturnType<typeof setInterval> | undefined

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode('\n'))
      keepAliveTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode('\n'))
        } catch {
          // Stream may already be closed.
        }
      }, PROXY_KEEPALIVE_INTERVAL_MS)

      try {
        const upstream = await upstreamPromise
        clearInterval(keepAliveTimer)
        await pipeBody(upstream, controller)
      } catch {
        controller.enqueue(encoder.encode(JSON.stringify({ error: { message: 'Upstream request failed' } })))
      } finally {
        clearInterval(keepAliveTimer)
        controller.close()
      }
    },
    cancel() {
      clearInterval(keepAliveTimer)
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

async function proxyUpstream(request: Request, targetUrl: URL): Promise<Response> {
  const upstreamPromise = fetch(createProxyRequest(request, targetUrl))
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timeoutId = setTimeout(() => resolve('timeout'), UPSTREAM_HEADER_TIMEOUT_MS)
  })

  const raced = await Promise.race([
    upstreamPromise.then((response) => ({ kind: 'response' as const, response })),
    timeoutPromise.then(() => ({ kind: 'timeout' as const })),
  ])

  clearTimeout(timeoutId)

  if (raced.kind === 'response') {
    return passthroughResponse(raced.response)
  }

  return createKeepaliveProxyResponse(upstreamPromise)
}

async function handleApiProxy(request: Request, env: Env): Promise<Response> {
  if (!isApiProxyEnabled(env)) return jsonError('API proxy is disabled', 404)
  if (!['POST', 'OPTIONS'].includes(request.method)) return jsonError('Method not allowed', 405)
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 })

  const targetBase = normalizeTargetBase(env.API_PROXY_URL)
  if (!targetBase) return jsonError('API_PROXY_URL is not configured', 502)

  const targetUrl = createTargetUrl(new URL(request.url), targetBase)
  if (!targetUrl) return jsonError('API proxy path is invalid', 403)

  return proxyUpstream(request, targetUrl)
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
