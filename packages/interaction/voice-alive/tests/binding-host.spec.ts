/** Host wiring: the Audio workspace, registry lookups, and the binding installed on the voice service. */
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import VoiceAliveService, { MODELS_ACTION_PATH, MODELS_EVENTS_PATH, MODELS_SNAPSHOT_PATH } from '../src/index.ts'
import { createVoiceBindingDeps, VOICE_WORKSPACE_TITLE, voiceWorkspaceDirectory } from '../src/binding/harness.ts'
import type { BindingRecord } from '../src/binding/types.ts'

const contexts: Context[] = []
const homes: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

interface FakeTable {
  record: BindingRecord | null
}

interface Fakes {
  readonly ctx: Context
  readonly home: string
  readonly table: FakeTable
  readonly entities: Map<string, { id: string; path: string; title: string }>
  readonly live: Set<string>
  readonly stored: Set<string>
  readonly archived: string[]
  readonly createWorkspace: ReturnType<typeof vi.fn>
  readonly createSession: ReturnType<typeof vi.fn>
  /** Fetch routes the voice row registers with Connection, in registration order. */
  readonly routes: Array<{ readonly path: string; readonly fetch: (request: Request) => Promise<Response> }>
}

async function fakes(options: { profile?: boolean } = {}): Promise<Fakes> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-voice-home-'))
  homes.push(home)
  const ctx = new Context()
  contexts.push(ctx)
  const table: FakeTable = { record: null }
  const entities = new Map<string, { id: string; path: string; title: string }>()
  entities.set('ws-1', { id: 'ws-1', path: '/projects/one', title: 'One' })
  const live = new Set<string>()
  const stored = new Set<string>()
  const archived: string[] = []

  const domain = {
    table: () => ({
      get: () => table.record ?? undefined,
      put: async (_key: string, value: BindingRecord) => { table.record = value },
      delete: async () => {
        const existed = table.record !== null
        table.record = null
        return existed
      },
    }),
    close: async () => {},
  }
  const createWorkspace = vi.fn(async (path: string, title?: string) => {
    for (const entity of entities.values()) {
      if (entity.path === path) return entity
    }
    const entity = { id: `ws-${entities.size + 1}`, path, title: title ?? 'Untitled' }
    entities.set(entity.id, entity)
    return entity
  })
  const createSession = vi.fn(async () => ({ sessionId: 'session-created' }))

  if (options.profile !== false) {
    ctx.provide('profileContext', { home } as never)
  }
  ctx.provide('storageDomain', { open: async () => domain } as never)
  ctx.provide('workspaceRegistry', {
    get: (id: string) => entities.get(id),
    create: createWorkspace,
    archivedSessionIds: archived,
  } as never)
  ctx.provide('sessions', {
    get: (id: string) => (live.has(id) ? { id } : undefined),
  } as never)
  ctx.provide('sessionPersistence', {
    stat: async (id: string) => (stored.has(id) ? { header: { id } } : undefined),
  } as never)
  ctx.provide('sessionController', { create: createSession } as never)
  const routes: Array<{ readonly path: string; readonly fetch: (request: Request) => Promise<Response> }> = []
  ctx.provide('connection', {
    fetch: {
      register: (route: { readonly path: string; readonly fetch: (request: Request) => Promise<Response> }) => {
        routes.push(route)
        return async () => { routes.splice(routes.indexOf(route), 1) }
      },
    },
  } as never)

  return { ctx, home, table, entities, live, stored, archived, createWorkspace, createSession, routes }
}

describe('host wiring', () => {
  it('resolves registered workspaces only', async () => {
    const f = await fakes()
    const deps = createVoiceBindingDeps(f.ctx)

    expect(deps.workspaces.get('ws-1')).toEqual({ workspaceId: 'ws-1', path: '/projects/one' })
    expect(deps.workspaces.get('ws-unknown')).toBeUndefined()
  })

  it('classifies archived, live, persisted, and unknown sessions', async () => {
    const f = await fakes()
    const deps = createVoiceBindingDeps(f.ctx)
    f.live.add('live-session')
    f.stored.add('persisted-session')

    expect(await deps.sessions.status('archived-session')).toBe('missing')
    f.archived.push('archived-session')
    expect(await deps.sessions.status('archived-session')).toBe('archived')
    expect(await deps.sessions.status('live-session')).toBe('active')
    expect(await deps.sessions.status('persisted-session')).toBe('active')
    expect(await deps.sessions.status('unknown-session')).toBe('missing')
  })

  it('creates the Audio workspace once and returns its registration', async () => {
    const f = await fakes()
    const deps = createVoiceBindingDeps(f.ctx)

    const workspace = await deps.workspaces.ensure()

    expect(workspace.path).toBe(voiceWorkspaceDirectory(f.home))
    expect((await stat(voiceWorkspaceDirectory(f.home))).isDirectory()).toBe(true)
    expect(f.createWorkspace).toHaveBeenCalledWith(voiceWorkspaceDirectory(f.home), VOICE_WORKSPACE_TITLE)
    expect(await deps.workspaces.ensure()).toEqual(workspace)
    expect(f.createWorkspace).toHaveBeenCalledTimes(2)
    expect(f.entities.size).toBe(2)
  })

  it('refuses to create the Audio workspace outside a dsh profile', async () => {
    const f = await fakes({ profile: false })
    const deps = createVoiceBindingDeps(f.ctx)

    await expect(deps.workspaces.ensure()).rejects.toThrow('profileContext is absent')
    expect(f.createWorkspace).not.toHaveBeenCalled()
  })

  it('creates a session through the session controller', async () => {
    const f = await fakes()
    const deps = createVoiceBindingDeps(f.ctx)

    expect(await deps.sessions.create({ workspaceId: 'ws-1', path: '/projects/one' }))
      .toBe('session-created')
    expect(f.createSession).toHaveBeenCalledWith({ workspaceId: 'ws-1' })
  })

  it('reports recoverable failures through the host logger', async () => {
    const f = await fakes()
    const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
    const deps = createVoiceBindingDeps(f.ctx)

    deps.warn?.('voice binding: test message')

    expect(warn).toHaveBeenCalledWith('voice binding: test message')
  })
})

describe('service installation', () => {
  it('installs the binding and restores on activation', async () => {
    const f = await fakes()
    await f.ctx.plugin(VoiceAliveService)

    const binding = f.ctx.voiceAlive.binding
    expect(binding.state).toBe('bound')
    expect(binding.sessionId).toBe('session-created')
    expect(f.createSession).toHaveBeenCalledWith({ workspaceId: 'ws-2' })
    expect(f.table.record).toMatchObject({ sessionId: 'session-created', workspaceId: 'ws-2' })
  })

  it('keeps the row active when the startup restore fails', async () => {
    const f = await fakes()
    f.createSession.mockRejectedValueOnce(new Error('no agent factory'))
    const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})

    await f.ctx.plugin(VoiceAliveService)

    expect(f.ctx.voiceAlive.binding.state).toBe('unbound')
    expect(warn).toHaveBeenCalledWith('voice binding: startup restore failed: Error: no agent factory')
  })

  it('claims the model routes with Connection and releases them with the row', async () => {
    const f = await fakes()
    await f.ctx.plugin(VoiceAliveService)
    await f.ctx.voiceAlive.modelEndpoints

    expect(f.routes.map(route => route.path)).toEqual([
      MODELS_SNAPSHOT_PATH,
      MODELS_EVENTS_PATH,
      MODELS_ACTION_PATH,
    ])

    // The snapshot route resolves the lazy profile store the row owns.
    const snapshot = await f.routes[0]!.fetch(new Request(`http://127.0.0.1${MODELS_SNAPSHOT_PATH}`))
    expect(snapshot.status).toBe(200)
    const body: unknown = await snapshot.json()
    if (typeof body !== 'object' || body === null || !('rows' in body)) throw new Error('the snapshot has no rows')
    expect(Array.isArray(body.rows)).toBe(true)

    await f.ctx.fiber.dispose()
    expect(f.routes).toHaveLength(0)
  })

  it('refuses the binding before the host services are active', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const service = new VoiceAliveService(ctx)

    expect(() => service.binding).toThrow('voice binding is not installed')
  })
})
