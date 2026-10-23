/**
 * Voice instruction asset failures: a missing or empty `instructions.md` must
 * stop the row instead of speaking with no policy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fs = vi.hoisted(() => ({ readFile: vi.fn<(path: URL, encoding: string) => Promise<string>>() }))

vi.mock('node:fs/promises', () => ({ readFile: fs.readFile }))

const { loadVoiceInstructions } = await import('../src/instructions.ts')

beforeEach(() => {
  fs.readFile.mockReset()
})

describe('voice instruction asset', () => {
  it('reads the packaged policy verbatim', async () => {
    fs.readFile.mockResolvedValue('Speak briefly.\n')
    await expect(loadVoiceInstructions()).resolves.toBe('Speak briefly.\n')
    expect(fs.readFile.mock.calls[0]?.[0]).toBeInstanceOf(URL)
  })

  it('reports an unreadable asset with its path and cause', async () => {
    const cause = new Error('ENOENT')
    fs.readFile.mockRejectedValue(cause)

    const failure: unknown = await loadVoiceInstructions().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain('voice instructions are unreadable at')
    expect(failure).toHaveProperty('cause', cause)
  })

  it('rejects an empty asset', async () => {
    fs.readFile.mockResolvedValue('  \n')

    const failure: unknown = await loadVoiceInstructions().catch((error: unknown) => error)
    expect(String(failure)).toContain('voice instructions are empty at')
  })
})
