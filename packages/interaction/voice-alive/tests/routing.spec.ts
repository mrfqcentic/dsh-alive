/**
 * Conductor routing: workspace resolution, new-versus-resume selection,
 * archived recovery, and the durable write that records the accepted pair.
 */
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { describe, expect, it } from 'vitest'
import {
  routeConductor,
  type ConductorRouteRequest,
  type ConductorRoutingDeps,
  type RoutingSessionSummary,
  type RoutingWorkspace,
} from '../src/conductor/routing.ts'

/** A fake workspace whose session account the fake create call can extend. */
interface FakeWorkspace extends RoutingWorkspace {
  readonly sessionIds: SessionId[]
}

/** One recorded durable write. */
interface BindingWrite {
  readonly sessionId: string
  readonly workspaceId: string
}

function workspace(
  id: string,
  title: string,
  path: string,
  sessions: readonly string[] = [],
): FakeWorkspace {
  return { id: WorkspaceId(id), title, path, sessionIds: sessions.map(session => SessionId(session)) }
}

function summary(
  id: string,
  updatedAt: number,
  options: { title?: string; origin?: 'subagent' } = {},
): RoutingSessionSummary {
  return {
    sessionId: SessionId(id),
    updatedAt,
    ...options.title === undefined ? {} : { projections: { values: { title: options.title } } },
    ...options.origin === undefined ? {} : { origin: options.origin },
  }
}

interface Harness {
  readonly deps: ConductorRoutingDeps
  readonly writes: BindingWrite[]
  readonly createCalls: string[]
}

function harness(options: {
  workspaces?: FakeWorkspace[]
  summaries?: RoutingSessionSummary[]
  archived?: readonly string[]
  createdId?: string
  bind?: (sessionId: string, workspaceId: string) => Promise<void>
} = {}): Harness {
  const workspaces = options.workspaces ?? []
  const summaries = options.summaries ?? []
  const createdId = options.createdId ?? 'created-session'
  const writes: BindingWrite[] = []
  const createCalls: string[] = []
  const deps: ConductorRoutingDeps = {
    workspaces,
    archivedSessionIds: (options.archived ?? []).map(id => SessionId(id)),
    listSessions: async () => summaries,
    createSession: async (target) => {
      createCalls.push(String(target.id))
      const fake = workspaces.find(entry => entry.id === target.id)
      fake?.sessionIds.push(SessionId(createdId))
      return createdId
    },
    bind: options.bind ?? (async (sessionId, workspaceId) => {
      writes.push({ sessionId, workspaceId })
    }),
  }
  return { deps, writes, createCalls }
}

const SIGNAL = new AbortController().signal

/** One resume request; open-workspace resume creates, named-session resume reports. */
function resume(
  workspace: string,
  options: { sessionId?: string; createWhenEmpty?: boolean } = {},
): ConductorRouteRequest {
  return {
    workspace,
    mode: 'resume',
    createWhenEmpty: options.createWhenEmpty ?? true,
    ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
  }
}

describe('resuming a workspace', () => {
  it('binds the newest live session and reports the pair it wrote', async () => {
    const test = harness({
      workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice', ['older', 'newer'])],
      summaries: [summary('older', 1_000, { title: 'Older' }), summary('newer', 2_000, { title: 'Newer' })],
    })
    const result = await routeConductor(resume('Voice'), test.deps, SIGNAL)

    expect(result).toMatchObject({
      status: 'bound',
      created: false,
      session: {
        sessionId: 'newer',
        title: 'Newer',
        workspaceId: 'ws-voice',
        lastActivityAt: new Date(2_000).toISOString(),
        archived: false,
      },
      workspace: { workspaceId: 'ws-voice', title: 'Voice', path: '/tmp/voice', sessionCount: 2 },
    })
    expect(result.status === 'bound' ? result.message : '').toBe(
      `Bound "Newer" (newer) in workspace "Voice" (/tmp/voice). Last activity ${new Date(2_000).toISOString()}.`,
    )
    expect(test.writes).toEqual([{ sessionId: 'newer', workspaceId: 'ws-voice' }])
    expect(test.createCalls).toEqual([])
  })

  it('binds a named session by id', async () => {
    const test = harness({
      workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice', ['a', 'b'])],
      summaries: [summary('a', 1, { title: 'A' }), summary('b', 2, { title: 'B' })],
    })
    const result = await routeConductor(resume('Voice', { sessionId: 'a' }), test.deps, SIGNAL)

    expect(result).toMatchObject({ status: 'bound', session: { sessionId: 'a' } })
    expect(test.writes).toEqual([{ sessionId: 'a', workspaceId: 'ws-voice' }])
  })

  it('creates when no live session remains', async () => {
    const test = harness({
      workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice', ['archived'])],
      summaries: [summary('archived', 1_000, { title: 'Archived' })],
      archived: ['archived'],
    })
    const result = await routeConductor(resume('Voice'), test.deps, SIGNAL)

    expect(result).toMatchObject({ status: 'bound', created: true, session: { sessionId: 'created-session' } })
    expect(result.status === 'bound' ? result.message : '').toBe(
      'Created and bound session created-session in workspace "Voice" (/tmp/voice).',
    )
    expect(test.createCalls).toEqual(['ws-voice'])
    expect(test.writes).toEqual([{ sessionId: 'created-session', workspaceId: 'ws-voice' }])
  })

  it('reports an empty workspace when the caller names an earlier session', async () => {
    const test = harness({ workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice')] })
    const result = await routeConductor(
      resume('Voice', { createWhenEmpty: false }),
      test.deps,
      SIGNAL,
    )

    expect(result).toEqual({
      status: 'error',
      code: 'SESSION_NOT_FOUND',
      message: 'Workspace "Voice" has no session to resume.',
      candidates: [],
    })
    expect(test.createCalls).toEqual([])
    expect(test.writes).toEqual([])
  })

  it('resolves an exact path and a final path segment', async () => {
    const test = harness({
      workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice', ['a'])],
      summaries: [summary('a', 1)],
    })

    for (const name of ['/tmp/voice', 'voice']) {
      const result = await routeConductor(resume(name), test.deps, SIGNAL)
      expect(result).toMatchObject({ status: 'bound', session: { sessionId: 'a' } })
    }
  })
})

describe('opening a workspace', () => {
  it('always creates in new mode', async () => {
    const test = harness({
      workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice', ['existing'])],
      summaries: [summary('existing', 1_000, { title: 'Existing' })],
      createdId: 'created-new',
    })
    const result = await routeConductor({ workspace: 'Voice', mode: 'new' }, test.deps, SIGNAL)

    expect(result).toMatchObject({ status: 'bound', created: true, session: { sessionId: 'created-new' } })
    expect(test.createCalls).toEqual(['ws-voice'])
    expect(test.writes).toEqual([{ sessionId: 'created-new', workspaceId: 'ws-voice' }])
  })
})

describe('archived recovery', () => {
  it('binds the newest live session and names the archived one', async () => {
    const test = harness({
      workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice', ['archived', 'live', 'older'])],
      summaries: [
        summary('archived', 3_000, { title: 'Archived' }),
        summary('older', 500, { title: 'Older' }),
        summary('live', 2_000, { title: 'Live' }),
      ],
      archived: ['archived'],
    })
    const result = await routeConductor(resume('Voice', { sessionId: 'archived' }), test.deps, SIGNAL)

    expect(result).toMatchObject({ status: 'bound', created: false, session: { sessionId: 'live' } })
    expect(result.status === 'bound' ? result.message : '').toBe(
      'Bound "Live" (live) in workspace "Voice" (/tmp/voice) because "Archived" (archived) is archived. '
      + `Last activity ${new Date(2_000).toISOString()}.`,
    )
    expect(test.writes).toEqual([{ sessionId: 'live', workspaceId: 'ws-voice' }])
    expect(test.createCalls).toEqual([])
  })

  it('creates a replacement when every other session is archived', async () => {
    const test = harness({
      workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice', ['archived'])],
      summaries: [summary('archived', 1_000)],
      archived: ['archived'],
    })
    const result = await routeConductor(resume('Voice', { sessionId: 'archived' }), test.deps, SIGNAL)

    expect(result).toMatchObject({ status: 'bound', created: true, session: { sessionId: 'created-session' } })
    expect(result.status === 'bound' ? result.message : '').toBe(
      'Created and bound session created-session in workspace "Voice" (/tmp/voice) '
      + 'because session archived is archived.',
    )
    expect(test.writes).toEqual([{ sessionId: 'created-session', workspaceId: 'ws-voice' }])
  })

  it('creates a replacement when the only live session belongs to a subagent', async () => {
    const test = harness({
      workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice', ['archived', 'child'])],
      summaries: [
        summary('archived', 1_000, { title: 'Archived' }),
        summary('child', 2_000, { title: 'Child', origin: 'subagent' }),
      ],
      archived: ['archived'],
    })
    const result = await routeConductor(resume('Voice', { sessionId: 'archived' }), test.deps, SIGNAL)

    expect(result).toMatchObject({ status: 'bound', created: true })
    expect(test.createCalls).toEqual(['ws-voice'])
    expect(test.writes).toEqual([{ sessionId: 'created-session', workspaceId: 'ws-voice' }])
  })
})

describe('unresolved requests', () => {
  it('returns candidates for a partial workspace name without binding or creating', async () => {
    const test = harness({
      workspaces: [workspace('ws-a', 'Client X', '/tmp/client-x'), workspace('ws-b', 'Client Y', '/tmp/client-y')],
    })
    const result = await routeConductor(resume('client'), test.deps, SIGNAL)

    expect(result).toMatchObject({
      status: 'candidates',
      message: 'No exact workspace is named "client". Candidates: "Client X", "Client Y". Ask which one.',
      candidates: [
        { workspaceId: 'ws-a', title: 'Client X', path: '/tmp/client-x', sessionCount: 0 },
        { workspaceId: 'ws-b', title: 'Client Y', path: '/tmp/client-y', sessionCount: 0 },
      ],
    })
    expect(test.writes).toEqual([])
    expect(test.createCalls).toEqual([])
  })

  it('reports an unknown workspace with the registered ones as candidates', async () => {
    const test = harness({ workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice')] })
    const result = await routeConductor(resume('nope'), test.deps, SIGNAL)

    expect(result).toEqual({
      status: 'error',
      code: 'WORKSPACE_NOT_FOUND',
      message: 'No workspace matches "nope". Known workspaces: "Voice".',
      candidates: [{ workspaceId: 'ws-voice', title: 'Voice', path: '/tmp/voice', sessionCount: 0 }],
    })
    expect(test.writes).toEqual([])
  })

  it('reports a miss without a match list when no workspace is registered', async () => {
    const test = harness()
    const result = await routeConductor(resume('nope'), test.deps, SIGNAL)

    expect(result).toEqual({
      status: 'error',
      code: 'WORKSPACE_NOT_FOUND',
      message: 'No workspace matches "nope".',
      candidates: [],
    })
  })

  it('asks for a workspace name when none is registered', async () => {
    const test = harness()
    const result = await routeConductor(resume(''), test.deps, SIGNAL)

    expect(result).toMatchObject({
      status: 'candidates',
      message: 'A workspace name is required, and no workspaces are registered.',
      candidates: [],
    })
  })

  it('reports a named session the workspace does not account', async () => {
    const test = harness({ workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice')] })
    const result = await routeConductor(
      resume('Voice', { sessionId: 'missing' }),
      test.deps,
      SIGNAL,
    )

    expect(result).toEqual({
      status: 'error',
      code: 'SESSION_NOT_FOUND',
      message: 'Session "missing" is not available in workspace "Voice".',
      candidates: [],
    })
    expect(test.writes).toEqual([])
  })

  it('skips an accounted session the Host list does not return', async () => {
    const test = harness({ workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice', ['ghost'])] })
    const result = await routeConductor(
      resume('Voice', { sessionId: 'ghost' }),
      test.deps,
      SIGNAL,
    )

    expect(result).toMatchObject({ status: 'error', code: 'SESSION_NOT_FOUND' })
  })

  it('refuses a subagent session named explicitly', async () => {
    const test = harness({
      workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice', ['child'])],
      summaries: [summary('child', 1_000, { title: 'Child', origin: 'subagent' })],
    })
    const result = await routeConductor(
      resume('Voice', { sessionId: 'child' }),
      test.deps,
      SIGNAL,
    )

    expect(result).toEqual({
      status: 'error',
      code: 'PERMISSION_DENIED',
      message: '"Child" (child) belongs to a subagent and cannot be the voice session.',
      candidates: [],
    })
    expect(test.writes).toEqual([])
  })
})

describe('binding failures', () => {
  it('propagates a rejected write without reporting a bound result', async () => {
    const writes: BindingWrite[] = []
    const test = harness({
      workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice', ['a'])],
      summaries: [summary('a', 1, { title: 'A' })],
      bind: async (sessionId, workspaceId) => {
        writes.push({ sessionId, workspaceId })
        throw new Error('storage offline')
      },
    })

    await expect(routeConductor(resume('Voice'), test.deps, SIGNAL))
      .rejects.toThrow('storage offline')
    expect(writes).toEqual([{ sessionId: 'a', workspaceId: 'ws-voice' }])
    expect(test.createCalls).toEqual([])
  })
})
