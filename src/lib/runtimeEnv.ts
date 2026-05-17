function readWindowRuntimeEnv(key: string | undefined): string {
  if (!key || typeof window === 'undefined') return ''
  return String.prototype.trim.call(window.__GPT_IMAGE_RUNTIME_ENV__?.[key] ?? '')
}

export function readRuntimeEnv(value: string | undefined, key?: string): string {
  return String.prototype.trim.call(value ?? '') || readWindowRuntimeEnv(key)
}
