/**
 * The published `./worker` slot is one dispatcher. It validates the role the
 * Host passes and rewrites the invocation so the selected role module keeps its
 * own argv contract (the TTS configuration JSON stays at `argv[2]`).
 */
import { describe, expect, it } from 'vitest'
import {
  isDispatcherInvocation,
  roleInvocation,
  workerRole,
} from '../src/engine/worker.ts'

describe('workerRole', () => {
  it('accepts the two engine roles and rejects everything else', () => {
    expect(workerRole('asr')).toBe('asr')
    expect(workerRole('tts')).toBe('tts')
    expect(workerRole(undefined)).toBeUndefined()
    expect(workerRole('')).toBeUndefined()
    expect(workerRole('ASR')).toBeUndefined()
    expect(workerRole('asr-worker')).toBeUndefined()
  })
})

describe('roleInvocation', () => {
  it('selects the ASR role module and drops the role argument', () => {
    const invocation = roleInvocation('asr', 'file:///pkg/lib/worker.js',
      ['/electron', '/pkg/lib/worker.js', 'asr'])
    expect(invocation.moduleUrl.pathname).toBe('/pkg/lib/asr-worker.js')
    expect(invocation.argv).toEqual(['/electron', '/pkg/lib/asr-worker.js'])
  })

  it('selects the TTS role module and keeps the configuration at argv[2]', () => {
    const config = JSON.stringify({ modelDirectory: '/models/kokoro', voice: 'af_heart' })
    const invocation = roleInvocation('tts', 'file:///pkg/lib/worker.js',
      ['/electron', '/pkg/lib/worker.js', 'tts', config])
    expect(invocation.moduleUrl.pathname).toBe('/pkg/lib/tts-worker.js')
    expect(invocation.argv).toEqual(['/electron', '/pkg/lib/tts-worker.js', config])
  })

  it('falls back to the running executable when argv carries no program name', () => {
    expect(roleInvocation('asr', 'file:///pkg/lib/worker.js', []).argv[0]).toBe(process.execPath)
  })
})

describe('isDispatcherInvocation', () => {
  it('runs only when argv[1] resolves to the dispatcher module', () => {
    const url = new URL('../src/engine/worker.ts', import.meta.url).href
    expect(isDispatcherInvocation([process.execPath, new URL(url).pathname], url)).toBe(true)
    expect(isDispatcherInvocation([process.execPath, '/pkg/lib/index.js'], url)).toBe(false)
    expect(isDispatcherInvocation([process.execPath], url)).toBe(false)
    expect(isDispatcherInvocation([process.execPath, '/missing/worker.js'], url)).toBe(false)
  })
})
