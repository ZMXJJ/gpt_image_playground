import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from './worker'

function createEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    ASSETS: {
      fetch: vi.fn().mockResolvedValue(new Response('<!doctype html><html><head></head><body></body></html>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })),
    },
    ...overrides,
  }
}

describe('worker API proxy', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('proxies same-origin API requests to the configured upstream target', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    }))
    const request = new Request('https://app.example.com/api-proxy/images/generations', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-key',
        'Content-Type': 'application/json',
        Origin: 'https://app.example.com',
      },
      body: JSON.stringify({ prompt: 'test' }),
    })

    const response = await worker.fetch(request, createEnv({
      ENABLE_API_PROXY: 'true',
      API_PROXY_URL: 'https://api.example.com/v1',
    }))

    expect(response.status).toBe(200)
    const proxiedRequest = fetchMock.mock.calls[0][0] as Request
    expect(proxiedRequest.url).toBe('https://api.example.com/v1/images/generations')
    expect(proxiedRequest.method).toBe('POST')
    expect(proxiedRequest.headers.get('Authorization')).toBe('Bearer test-key')
  })

  it('rejects disallowed proxy paths', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const response = await worker.fetch(new Request('https://app.example.com/api-proxy/custom/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test' }),
    }), createEnv({
      ENABLE_API_PROXY: 'true',
      API_PROXY_URL: 'https://api.example.com/v1',
    }))

    expect(response.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects GET proxy requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const response = await worker.fetch(new Request('https://app.example.com/api-proxy/images/generations'), createEnv({
      ENABLE_API_PROXY: 'true',
      API_PROXY_URL: 'https://api.example.com/v1',
    }))

    expect(response.status).toBe(405)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects absolute proxy paths so the Worker cannot become an open proxy', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const response = await worker.fetch(new Request('https://app.example.com/api-proxy/https://evil.example.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test' }),
    }), createEnv({
      ENABLE_API_PROXY: 'true',
      API_PROXY_URL: 'https://api.example.com/v1',
    }))

    expect(response.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('streams keepalive chunks when upstream takes longer than the Cloudflare header timeout', async () => {
    vi.useFakeTimers()

    let resolveUpstream: ((response: Response) => void) | undefined
    const upstreamPromise = new Promise<Response>((resolve) => {
      resolveUpstream = resolve
    })
    vi.spyOn(globalThis, 'fetch').mockReturnValue(upstreamPromise)

    const request = new Request('https://app.example.com/api-proxy/images/generations', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt: 'test' }),
    })

    const responsePromise = worker.fetch(request, createEnv({
      ENABLE_API_PROXY: 'true',
      API_PROXY_URL: 'https://api.example.com/v1',
    }))

    await vi.advanceTimersByTimeAsync(100_000)
    const response = await responsePromise
    expect(response.status).toBe(200)

    resolveUpstream?.(new Response(JSON.stringify({ data: [{ b64_json: 'abc' }] }), {
      headers: { 'Content-Type': 'application/json' },
    }))

    const text = await response.text()
    expect(text.replace(/\n/g, '')).toContain('b64_json')

    vi.useRealTimers()
  })

  it('injects runtime proxy settings into HTML assets', async () => {
    const response = await worker.fetch(new Request('https://app.example.com/'), createEnv({
      ENABLE_API_PROXY: 'true',
      LOCK_API_PROXY: 'true',
      DEFAULT_API_URL: 'https://api.example.com/v1',
    }))

    const html = await response.text()
    expect(html).toContain('window.__GPT_IMAGE_RUNTIME_ENV__')
    expect(html).toContain('"VITE_API_PROXY_AVAILABLE":"true"')
    expect(html).toContain('"VITE_API_PROXY_LOCKED":"true"')
    expect(html).toContain('"VITE_DEFAULT_API_URL":"https://api.example.com/v1"')
  })
})
