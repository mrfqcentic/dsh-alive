/** Binding storage over the real json backend: per-record durability, corrupt documents, and domain lifecycle. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { createVoiceBindingStorage } from '../src/binding/storage.ts'
import type { BindingRecord } from '../src/binding/types.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const RECORD: BindingRecord = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  updatedAt: '2026-10-23T12:00:00.000Z',
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-voice-binding-'))
  roots.push(root)
  return root
}

async function host(): Promise<{ ctx: Context; root: string }> {
  const root = await tempRoot()
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  ctx.provide('storageDomain', new DomainFacility(ctx, { backend: 'json' }))
  return { ctx, root }
}

const recordPath = (root: string): string => join(root, 'voice_binding', 'binding', 'current.json')

describe('json backend', () => {
  it('writes, reads, and clears one durable record', async () => {
    const { ctx, root } = await host()
    const storage = createVoiceBindingStorage(ctx)

    expect(await storage.read()).toBeNull()
    await storage.write(RECORD)
    expect(await storage.read()).toEqual(RECORD)
    expect(JSON.parse(await readFile(recordPath(root), 'utf8'))).toEqual({ version: 1, record: RECORD })

    await storage.clear()
    expect(await storage.read()).toBeNull()
  })

  it('reads a malformed record document as absent and replaces it on the next write', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'voice_binding', 'binding'), { recursive: true })
    await writeFile(recordPath(root), '{not json', 'utf8')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    ctx.storage.backend.register('json', new JsonStorageBackend(root))
    ctx.provide('storageDomain', new DomainFacility(ctx, { backend: 'json' }))

    const storage = createVoiceBindingStorage(ctx)
    expect(await storage.read()).toBeNull()
    await storage.write(RECORD)
    expect(await storage.read()).toEqual(RECORD)
  })

  it('backs up a schema-invalid record and opens with no binding', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'voice_binding', 'binding'), { recursive: true })
    await writeFile(recordPath(root), `${JSON.stringify({ version: 1, record: { sessionId: 42 } })}\n`, 'utf8')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    ctx.storage.backend.register('json', new JsonStorageBackend(root))
    ctx.provide('storageDomain', new DomainFacility(ctx, { backend: 'json' }))

    const storage = createVoiceBindingStorage(ctx)
    expect(await storage.read()).toBeNull()
    const documents = await readdir(join(root, 'voice_binding', 'binding'))
    expect(documents.some(entry => entry.startsWith('current.json.bak.'))).toBe(true)
  })

  it('releases the domain with the owning context', async () => {
    const { ctx } = await host()
    const storage = createVoiceBindingStorage(ctx)
    await storage.write(RECORD)
    await ctx.fiber.dispose()

    await expect(storage.read()).rejects.toThrow("domain 'voice_binding' is closed")
  })

  it('refuses a domain that finishes opening after the owning context is gone', async () => {
    let finishOpen: (domain: unknown) => void = () => {}
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('storageDomain', {
      open: () => new Promise((resolve) => { finishOpen = resolve }),
    } as never)
    const storage = createVoiceBindingStorage(ctx)

    const pending = storage.read()
    await ctx.fiber.dispose()
    const close = vi.fn(async () => {})
    finishOpen({ table: () => ({ get: () => undefined }), close })

    await expect(pending).rejects.toThrow('voice binding storage is closed')
    expect(close).toHaveBeenCalledOnce()
  })
})

describe('open failures', () => {
  it('retries the open instead of caching a rejected attempt', async () => {
    const table = {
      record: null as BindingRecord | null,
      get() {
        return this.record ?? undefined
      },
      async put(_key: string, value: BindingRecord) {
        this.record = value
      },
    }
    const open = vi.fn()
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValue({ table: () => table, close: vi.fn(async () => {}) })
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('storageDomain', { open } as never)
    const storage = createVoiceBindingStorage(ctx)

    await expect(storage.read()).rejects.toThrow('storage unavailable')
    await storage.write(RECORD)
    expect(open).toHaveBeenCalledTimes(2)
    expect(await storage.read()).toEqual(RECORD)
  })
})
