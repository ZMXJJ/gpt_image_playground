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
    expect(proxiedRequest.headers.has('Origin')).toBe(false)
  })

  it('rejects absolute proxy paths so the Worker cannot become an open proxy', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const response = await worker.fetch(new Request('https://app.example.com/api-proxy/https://evil.example.com'), createEnv({
      ENABLE_API_PROXY: 'true',
      API_PROXY_URL: 'https://api.example.com/v1',
    }))

    expect(response.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
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
