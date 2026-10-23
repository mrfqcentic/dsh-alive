/** Session binding: durable record, startup restore, fallback, and serialized writes over fake storage and registries. */
import { describe, expect, it } from 'vitest'
import { createVoiceBinding } from '../src/binding/index.ts'
import type {
  BindingDeps,
  BindingRecord,
  BindingSessionStatus,
  BindingSessions,
  BindingStorage,
  BindingWorkspace,
  BindingWorkspaces,
} from '../src/binding/types.ts'

const AUDIO: BindingWorkspace = { workspaceId: 'ws-audio', path: '/voice/workspace' }
const OTHER: BindingWorkspace = { workspaceId: 'ws-other', path: '/projects/other' }

class MemoryStorage implements BindingStorage {
  record: BindingRecord | null = null
  readonly writes: BindingRecord[] = []
  reads = 0
  clears = 0
  failRead: unknown
  failWrite: unknown
  failClear: unknown

  async read(): Promise<BindingRecord | null> {
    this.reads += 1
    if (this.failRead !== undefined) throw this.failRead
    return this.record
  }

  async write(record: BindingRecord): Promise<void> {
    if (this.failWrite !== undefined) throw this.failWrite
    this.writes.push(record)
    this.record = record
  }

  async clear(): Promise<void> {
    if (this.failClear !== undefined) throw this.failClear
    this.clears += 1
    this.record = null
  }
}

class FakeWorkspaces implements BindingWorkspaces {
  readonly known = new Map<string, BindingWorkspace>([[AUDIO.workspaceId, AUDIO], [OTHER.workspaceId, OTHER]])
  ensureCalls = 0
  ensureError: Error | undefined

  get(workspaceId: string): BindingWorkspace | undefined {
    return this.known.get(workspaceId)
  }

  async ensure(): Promise<BindingWorkspace> {
    this.ensureCalls += 1
    if (this.ensureError !== undefined) throw this.ensureError
    this.known.set(AUDIO.workspaceId, AUDIO)
    return AUDIO
  }
}

class FakeSessions implements BindingSessions {
  readonly statuses = new Map<string, BindingSessionStatus>()
  createCalls = 0
  createError: Error | undefined
  private counter = 0

  async status(sessionId: string): Promise<BindingSessionStatus> {
    return this.statuses.get(sessionId) ?? 'missing'
  }

  async create(): Promise<string> {
    this.createCalls += 1
    if (this.createError !== undefined) throw this.createError
    this.counter += 1
    const id = `session-${this.counter}`
    this.statuses.set(id, 'active')
    return id
  }
}

interface Fixture {
  readonly storage: MemoryStorage
  readonly workspaces: FakeWorkspaces
  readonly sessions: FakeSessions
  readonly warnings: string[]
  readonly deps: BindingDeps
}

function fixture(options: { clock?: () => Date; warn?: boolean } = {}): Fixture {
  const storage = new MemoryStorage()
  const workspaces = new FakeWorkspaces()
  const sessions = new FakeSessions()
  const warnings: string[] = []
  const deps: BindingDeps = {
    storage,
    workspaces,
    sessions,
    ...(options.clock === undefined ? {} : { now: options.clock }),
    ...(options.warn === false ? {} : { warn: (message: string) => { warnings.push(message) } }),
  }
  return { storage, workspaces, sessions, warnings, deps }
}

function fixedClock(): () => Date {
  let tick = 0
  return () => new Date(Date.UTC(2026, 9, 23, 12, 0, 0, tick++))
}

function stored(record: Partial<BindingRecord> = {}): BindingRecord {
  return {
    sessionId: 'stored-session',
    workspaceId: 'ws-other',
    updatedAt: '2026-10-23T11:00:00.000Z',
    ...record,
  }
}

describe('first run and restart', () => {
  it('creates the Audio workspace and one session, then records the binding', async () => {
    const f = fixture({ clock: fixedClock() })
    const binding = createVoiceBinding(f.deps)

    expect(binding.state).toBe('unbound')
    expect(binding.sessionId).toBeNull()
    expect(binding.workspaceId).toBeNull()

    const pair = await binding.ensure()

    expect(pair).toEqual({ sessionId: 'session-1', workspaceId: 'ws-audio' })
    expect(binding.sessionId).toBe('session-1')
    expect(binding.workspaceId).toBe('ws-audio')
    expect(binding.state).toBe('bound')
    expect(f.workspaces.ensureCalls).toBe(1)
    expect(f.sessions.createCalls).toBe(1)
    expect(f.storage.writes).toEqual([{
      sessionId: 'session-1',
      workspaceId: 'ws-audio',
      updatedAt: '2026-10-23T12:00:00.000Z',
    }])
  })

  it('does not create again on a later ensure or a restarted binding', async () => {
    const f = fixture({ clock: fixedClock() })
    const first = createVoiceBinding(f.deps)
    await first.ensure()

    const again = await first.ensure()
    expect(again).toEqual({ sessionId: 'session-1', workspaceId: 'ws-audio' })
    expect(f.workspaces.ensureCalls).toBe(1)
    expect(f.sessions.createCalls).toBe(1)

    const restarted = createVoiceBinding(f.deps)
    expect(await restarted.restore()).toEqual({ sessionId: 'session-1', workspaceId: 'ws-audio' })
    expect(restarted.state).toBe('bound')
    expect(await restarted.ensure()).toEqual({ sessionId: 'session-1', workspaceId: 'ws-audio' })
    expect(f.workspaces.ensureCalls).toBe(1)
    expect(f.sessions.createCalls).toBe(1)
  })

  it('restores a stored session in a workspace that still exists', async () => {
    const f = fixture()
    f.storage.record = stored()
    f.sessions.statuses.set('stored-session', 'active')
    const binding = createVoiceBinding(f.deps)

    const pair = await binding.ensure()

    expect(pair).toEqual({ sessionId: 'stored-session', workspaceId: 'ws-other' })
    expect(f.workspaces.ensureCalls).toBe(0)
    expect(f.sessions.createCalls).toBe(0)
    expect(f.storage.writes).toEqual([])
  })
})

describe('fallbacks', () => {
  it('creates a session in the Audio workspace when the stored session is missing', async () => {
    const f = fixture({ clock: fixedClock() })
    f.storage.record = stored()
    f.sessions.statuses.set('stored-session', 'missing')
    const binding = createVoiceBinding(f.deps)

    const pair = await binding.ensure()

    expect(pair).toEqual({ sessionId: 'session-1', workspaceId: 'ws-audio' })
    expect(f.workspaces.ensureCalls).toBe(1)
    expect(f.storage.record).toMatchObject({ sessionId: 'session-1', workspaceId: 'ws-audio' })
    expect(f.warnings).toHaveLength(1)
    expect(f.warnings[0]).toContain('is missing')
  })

  it('replaces an archived session instead of binding it', async () => {
    const f = fixture()
    f.storage.record = stored()
    f.sessions.statuses.set('stored-session', 'archived')
    const binding = createVoiceBinding(f.deps)

    const pair = await binding.ensure()

    expect(pair.sessionId).toBe('session-1')
    expect(f.warnings[0]).toContain('is archived')
    expect(f.storage.record?.sessionId).toBe('session-1')
  })

  it('falls back when the stored workspace registration is gone', async () => {
    const f = fixture()
    f.storage.record = stored({ workspaceId: 'ws-deleted' })
    f.sessions.statuses.set('stored-session', 'active')
    const binding = createVoiceBinding(f.deps)

    const pair = await binding.ensure()

    expect(pair.workspaceId).toBe('ws-audio')
    expect(f.warnings[0]).toContain("workspace 'ws-deleted' is gone")
  })

  it('reports nothing usable from restore without creating or writing', async () => {
    const f = fixture()
    f.storage.record = stored()
    const binding = createVoiceBinding(f.deps)

    expect(await binding.restore()).toBeNull()
    expect(binding.state).toBe('unbound')
    expect(f.storage.writes).toEqual([])
    expect(f.workspaces.ensureCalls).toBe(0)
    expect(f.sessions.createCalls).toBe(0)
  })
})

describe('writes', () => {
  it('persists a conductor switch and clears it on unbind', async () => {
    const f = fixture({ clock: fixedClock() })
    const binding = createVoiceBinding(f.deps)
    await binding.ensure()

    await binding.bind('session-9', 'ws-other')
    expect(binding.state).toBe('bound')
    expect(f.storage.record).toEqual({
      sessionId: 'session-9',
      workspaceId: 'ws-other',
      updatedAt: '2026-10-23T12:00:00.001Z',
    })

    await binding.unbind()
    expect(binding.state).toBe('unbound')
    expect(binding.sessionId).toBeNull()
    expect(binding.workspaceId).toBeNull()
    expect(f.storage.record).toBeNull()

    await binding.unbind()
    expect(f.storage.clears).toBe(2)
  })

  it('keeps the committed binding when a write fails', async () => {
    const f = fixture({ clock: fixedClock() })
    const binding = createVoiceBinding(f.deps)
    await binding.ensure()

    f.storage.failWrite = new Error('disk full')
    await expect(binding.bind('session-9', 'ws-other')).rejects.toThrow('disk full')
    expect(binding.sessionId).toBe('session-1')
    expect(binding.workspaceId).toBe('ws-audio')

    f.storage.failClear = new Error('read-only medium')
    await expect(binding.unbind()).rejects.toThrow('read-only medium')
    expect(binding.sessionId).toBe('session-1')
    expect(binding.state).toBe('bound')
  })

  it('serializes concurrent ensures so the record is written once', async () => {
    const f = fixture()
    const binding = createVoiceBinding(f.deps)

    const [left, right] = await Promise.all([binding.ensure(), binding.ensure()])

    expect(left).toEqual(right)
    expect(f.workspaces.ensureCalls).toBe(1)
    expect(f.sessions.createCalls).toBe(1)
    expect(f.storage.writes).toHaveLength(1)
  })

  it('serializes a bind against an in-flight ensure without interleaving writes', async () => {
    const f = fixture()
    const binding = createVoiceBinding(f.deps)

    const ensuring = binding.ensure()
    const switching = binding.bind('session-9', 'ws-other')
    await Promise.all([ensuring, switching])

    expect(f.storage.writes.map(entry => entry.sessionId)).toEqual(['session-1', 'session-9'])
    expect(binding.sessionId).toBe('session-9')
    expect(binding.workspaceId).toBe('ws-other')
  })
})

describe('storage failures', () => {
  it('starts on a corrupt stored record instead of throwing', async () => {
    const f = fixture()
    f.storage.failRead = new SyntaxError('Unexpected token')
    const binding = createVoiceBinding(f.deps)

    const pair = await binding.ensure()

    expect(pair.sessionId).toBe('session-1')
    expect(binding.state).toBe('bound')
    expect(f.warnings[0]).toContain('could not read the stored binding: Unexpected token')
  })

  it('keeps the binding in memory when the fallback cannot be stored', async () => {
    const f = fixture()
    f.storage.failWrite = new Error('medium unavailable')
    const binding = createVoiceBinding(f.deps)

    const pair = await binding.ensure()

    expect(pair).toEqual({ sessionId: 'session-1', workspaceId: 'ws-audio' })
    expect(binding.state).toBe('bound')
    expect(binding.sessionId).toBe('session-1')
    expect(f.warnings[0]).toContain('could not store the binding: medium unavailable')
  })

  it('reports a non-Error failure and stays quiet without a warn sink', async () => {
    const f = fixture({ warn: false })
    f.storage.failRead = 'corrupt document'
    const binding = createVoiceBinding(f.deps)

    const pair = await binding.ensure()
    expect(pair.sessionId).toBe('session-1')
    expect(f.warnings).toEqual([])
  })

  it('lets registry failures reject and restores the previous state', async () => {
    const f = fixture()
    f.storage.failRead = new Error('permission denied')
    const binding = createVoiceBinding(f.deps)
    f.sessions.createError = new Error('no agent factory')

    await expect(binding.ensure()).rejects.toThrow('no agent factory')
    expect(binding.state).toBe('unbound')
    expect(binding.sessionId).toBeNull()
  })

  it('rejects restore when the session lookup fails and keeps the previous state', async () => {
    const f = fixture()
    f.storage.record = stored()
    const binding = createVoiceBinding(f.deps)
    f.sessions.status = async () => { throw new Error('session store unavailable') }

    await expect(binding.restore()).rejects.toThrow('session store unavailable')
    expect(binding.state).toBe('unbound')
  })
})
