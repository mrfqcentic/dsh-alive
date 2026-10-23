/**
 * Conductor tools: workspace resolution, session facts, binding effects, and
 * the typed failures that must leave the panel unbound.
 */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-title'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VoiceAliveService, {
  CONDUCTOR_ERROR_CODES,
  VoiceConductor,
  type ConductorWorkspaceFact,
  type VoiceBindingTarget,
} from '../src/index.ts'

/** The subset of a Workspace entity the conductor reads. */
interface FakeWorkspace {
  readonly id: ReturnType<typeof WorkspaceId>
  readonly title: string
  readonly path: string
  readonly sessionIds: SessionId[]
}

interface Harness {
  readonly ctx: Context
  readonly conductor: VoiceConductor
  readonly createCalls: string[]
  readonly controller: {
    list: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
  }
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function workspace(id: string, title: string, path: string, sessions: readonly string[] = []): FakeWorkspace {
  return { id: WorkspaceId(id), title, path, sessionIds: sessions.map(id => SessionId(id)) }
}

function summary(id: string, updatedAt: number, options: {
  title?: string
  origin?: 'subagent'
} = {}): SessionSummary {
  return {
    sessionId: SessionId(id),
    updatedAt,
    agentAvailable: false,
    running: false,
    blank: false,
    ...options.title === undefined ? {} : {
      projections: { kind: 'sequenced' as const, asOfSeq: 1, values: { title: options.title } },
    },
    ...options.origin === undefined ? {} : { origin: options.origin },
  }
}

async function mount(options: {
  workspaces?: FakeWorkspace[]
  summaries?: SessionSummary[]
  archived?: readonly string[]
  createdId?: string
} = {}): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const workspaces = options.workspaces ?? []
  const registry = {
    list: () => workspaces,
    archivedSessionIds: (options.archived ?? []).map(id => SessionId(id)),
  }
  const createCalls: string[] = []
  const controller = {
    list: vi.fn(async () => ({ items: options.summaries ?? [] })),
    create: vi.fn(async (request: { workspaceId: string }) => {
      const sessionId = SessionId(options.createdId ?? 'created-session')
      createCalls.push(request.workspaceId)
      workspaces.find(entry => String(entry.id) === request.workspaceId)?.sessionIds.push(sessionId)
      return { sessionId }
    }),
  }
  ctx.provide('workspaceRegistry', registry as never)
  ctx.provide('sessionController', controller as never)
  await ctx.plugin(VoiceConductor)
  return { ctx, conductor: ctx.voiceConductor, createCalls, controller }
}

async function run(ctx: Context, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const batch = await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: ToolCallId(`call-${name}`), name, arguments: JSON.stringify(args) }],
    signal: new AbortController().signal,
  })
  const first = batch.results[0]
  if (first === undefined) throw new Error('missing tool result')
  if (first.result.isError) {
    throw new Error(`tool ${name} failed: ${JSON.stringify(first.result.content)}`)
  }
  return first.result.value as Record<string, unknown>
}

async function fail(ctx: Context, name: string, args: unknown = {}): Promise<string> {
  const batch = await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: ToolCallId(`call-${name}`), name, arguments: JSON.stringify(args) }],
    signal: new AbortController().signal,
  })
  const first = batch.results[0]
  if (first === undefined) throw new Error('missing tool result')
  expect(first.result.isError).toBe(true)
  return JSON.stringify(first.result.content)
}

function expectUnbound(harness: Harness): void {
  expect(harness.conductor.currentBinding).toBeNull()
}

describe('registration', () => {
  it('mounts the four tools through the host row with exact schemas', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    ctx.provide('workspaceRegistry', {
      list: () => [workspace('ws-voice', 'Voice', '/tmp/voice', ['session-a'])],
      archivedSessionIds: [],
    } as never)
    ctx.provide('sessionController', {
      list: async () => ({ items: [summary('session-a', 10, { title: 'Hello' })] }),
      create: async () => ({ sessionId: SessionId('created') }),
    } as never)

    const service = new VoiceAliveService(ctx)
    await service.conductor
    expect(ctx.get('voiceAlive') instanceof VoiceAliveService).toBe(true)

    const schemas = ctx.tools.schemas()
    expect(schemas.map(schema => schema.name).sort()).toEqual([
      'voice_list_workspaces',
      'voice_new_session',
      'voice_open_workspace',
      'voice_resume_session',
    ])
    const byName = new Map(schemas.map(schema => [schema.name, schema]))
    expect(byName.get('voice_open_workspace')?.parameters).toMatchObject({
      type: 'object',
      required: ['name', 'mode'],
      properties: {
        name: { type: 'string' },
        mode: { type: 'string', enum: ['resume', 'new'] },
      },
    })
    expect(byName.get('voice_new_session')?.parameters).toMatchObject({
      required: ['workspace'],
      properties: { workspace: { type: 'string' } },
    })
    expect(byName.get('voice_resume_session')?.parameters).toMatchObject({
      required: ['workspace'],
      properties: { workspace: { type: 'string' }, session_id: { type: 'string' } },
    })
    expect(byName.get('voice_list_workspaces')?.parameters).toEqual({ type: 'object', properties: {} })

    const listed = await run(ctx, 'voice_list_workspaces')
    expect(listed).toMatchObject({
      workspaces: [{ workspaceId: 'ws-voice', title: 'Voice', path: '/tmp/voice', sessionCount: 1 }],
    })
  })
})

describe('workspace listing', () => {
  it('names every registered workspace and its session count', async () => {
    const harness = await mount({
      workspaces: [
        workspace('ws-voice', 'Voice', '/tmp/voice', ['a', 'b']),
        workspace('ws-client', 'Client', '/tmp/client'),
      ],
    })
    const value = await run(harness.ctx, 'voice_list_workspaces')
    expect(value.message).toBe([
      'Workspaces (2):',
      '- "Voice" (ws-voice) — /tmp/voice — sessions: 2',
      '- "Client" (ws-client) — /tmp/client — sessions: 0',
    ].join('\n'))
    expect(value.workspaces).toEqual([
      { workspaceId: 'ws-voice', title: 'Voice', path: '/tmp/voice', sessionCount: 2 },
      { workspaceId: 'ws-client', title: 'Client', path: '/tmp/client', sessionCount: 0 },
    ] satisfies ConductorWorkspaceFact[])
  })

  it('reports an empty registry without inventing a row', async () => {
    const harness = await mount()
    const value = await run(harness.ctx, 'voice_list_workspaces')
    expect(value).toEqual({ message: 'No workspaces are registered.', workspaces: [] })
  })
})

describe('opening a workspace', () => {
  it('binds the newest unarchived session and reports its facts', async () => {
    const harness = await mount({
      workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice', ['older', 'newer', 'archived-newest'])],
      summaries: [
        summary('older', 1_000, { title: 'Older' }),
        summary('newer', 2_000, { title: 'Newer' }),
        summary('archived-newest', 3_000, { title: 'Archived' }),
      ],
      archived: ['archived-newest'],
    })
    const value = await run(harness.ctx, 'voice_open_workspace', { name: 'Voice', mode: 'resume' })
    expect(value).toMatchObject({
      status: 'bound',
      created: false,
      session: {
        sessionId: 'newer',
        title: 'Newer',
        workspaceId: 'ws-voice',
        lastActivityAt: new Date(2_000).toISOString(),
        archived: false,
      },
      workspace: { workspaceId: 'ws-voice', title: 'Voice', path: '/tmp/voice', sessionCount: 3 },
    })
    expect(value.message).toBe(
      `Bound "Newer" (newer) in workspace "Voice" (/tmp/voice). Last activity ${new Date(2_000).toISOString()}.`,
    )
    expect(harness.conductor.currentBinding).toEqual({ sessionId: 'newer', workspaceId: 'ws-voice' })
    expect(harness.createCalls).toEqual([])
  })

  it('keeps the first session when a later one has the same or older activity', async () => {
    const harness = await mount({
      workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice', ['first', 'second'])],
      summaries: [summary('first', 2_000, { title: 'First' }), summary('second', 2_000, { title: 'Second' })],
    })
    const value = await run(harness.ctx, 'voice_open_workspace', { name: 'Voice', mode: 'resume' })
    expect(value.session).toMatchObject({ sessionId: 'first' })
  })

  it('creates a session when the workspace accounts none', async () => {
    const harness = await mount({ workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice')] })
    harness.controller.list.mockResolvedValueOnce({ items: [] })
    harness.controller.list.mockResolvedValueOnce({
      items: [summary('created-session', 5_000, { title: 'Fresh' })],
    })
    const value = await run(harness.ctx, 'voice_open_workspace', { name: 'Voice', mode: 'resume' })
    expect(value).toMatchObject({
      status: 'bound',
      created: true,
      session: { sessionId: 'created-session', title: 'Fresh', lastActivityAt: new Date(5_000).toISOString() },
    })
    expect(harness.createCalls).toEqual(['ws-voice'])
    expect(harness.conductor.currentBinding).toEqual({ sessionId: 'created-session', workspaceId: 'ws-voice' })
  })

  it('creates a session when every accounted session is archived', async () => {
    const harness = await mount({
      workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice', ['archived'])],
      summaries: [summary('archived', 1_000, { title: 'Archived' })],
      archived: ['archived'],
    })
    const value = await run(harness.ctx, 'voice_open_workspace', { name: 'Voice', mode: 'resume' })
    expect(value).toMatchObject({ status: 'bound', created: true })
    expect(harness.createCalls).toEqual(['ws-voice'])
  })

  it('always creates in new mode', async () => {
    const harness = await mount({
      workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice', ['existing'])],
      summaries: [summary('existing', 1_000, { title: 'Existing' })],
      createdId: 'created-new',
    })
    harness.controller.list.mockResolvedValueOnce({
      items: [summary('existing', 1_000, { title: 'Existing' }), summary('created-new', 2_000, { title: 'New' })],
    })
    const value = await run(harness.ctx, 'voice_open_workspace', { name: 'Voice', mode: 'new' })
    expect(value).toMatchObject({ status: 'bound', created: true, session: { sessionId: 'created-new' } })
    expect(harness.createCalls).toEqual(['ws-voice'])
  })

  it('returns candidates for a partial name without binding or creating', async () => {
    const harness = await mount({
      workspaces: [
        workspace('ws-a', 'Client X', '/tmp/client-x'),
        workspace('ws-b', 'Client Y', '/tmp/client-y'),
      ],
    })
    const value = await run(harness.ctx, 'voice_open_workspace', { name: 'client', mode: 'resume' })
    expect(value).toMatchObject({
      status: 'candidates',
      message: 'No exact workspace is named "client". Candidates: "Client X", "Client Y". Ask which one.',
      candidates: [
        { workspaceId: 'ws-a', title: 'Client X', path: '/tmp/client-x', sessionCount: 0 },
        { workspaceId: 'ws-b', title: 'Client Y', path: '/tmp/client-y', sessionCount: 0 },
      ],
    })
    expect(harness.createCalls).toEqual([])
    expectUnbound(harness)
  })

  it('returns candidates for duplicate exact titles', async () => {
    const harness = await mount({
      workspaces: [
        workspace('ws-a', 'Client', '/tmp/client-a'),
        workspace('ws-b', 'Client', '/tmp/client-b'),
      ],
    })
    const value = await run(harness.ctx, 'voice_open_workspace', { name: 'Client', mode: 'resume' })
    expect(value.status).toBe('candidates')
    expect(value.candidates).toHaveLength(2)
    expectUnbound(harness)
  })

  it('returns every workspace as candidates when the name is blank', async () => {
    const harness = await mount({
      workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice'), workspace('ws-a', 'A', '/tmp/a')],
    })
    const value = await run(harness.ctx, 'voice_open_workspace', { name: '  ', mode: 'resume' })
    expect(value).toMatchObject({
      status: 'candidates',
      message: 'A workspace name is required. Candidates: "Voice", "A". Ask which one.',
    })
    expectUnbound(harness)
  })

  it('truncates a long candidate list in the message only', async () => {
    const workspaces = Array.from({ length: 9 }, (_, index) =>
      workspace(`ws-${index}`, `Team ${index}`, `/tmp/team-${index}`))
    const harness = await mount({ workspaces })
    const value = await run(harness.ctx, 'voice_open_workspace', { name: 'Team', mode: 'resume' })
    expect(value.candidates).toHaveLength(9)
    expect(value.message).toContain('(+1 more)')
  })

  it('reports an unknown workspace with the known workspaces as matches', async () => {
    const harness = await mount({ workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice')] })
    const value = await run(harness.ctx, 'voice_open_workspace', { name: 'nope', mode: 'resume' })
    expect(value).toMatchObject({
      status: 'error',
      code: 'WORKSPACE_NOT_FOUND',
      message: 'No workspace matches "nope". Known workspaces: "Voice".',
      candidates: [{ workspaceId: 'ws-voice', title: 'Voice', path: '/tmp/voice', sessionCount: 0 }],
    })
    expectUnbound(harness)
  })

  it('reports an unknown workspace without a match list when none is registered', async () => {
    const harness = await mount()
    const value = await run(harness.ctx, 'voice_open_workspace', { name: 'nope', mode: 'resume' })
    expect(value).toMatchObject({
      status: 'error',
      code: 'WORKSPACE_NOT_FOUND',
      message: 'No workspace matches "nope".',
      candidates: [],
    })
  })

  it('reports a blank name with an empty registry', async () => {
    const harness = await mount()
    const value = await run(harness.ctx, 'voice_open_workspace', { name: '', mode: 'resume' })
    expect(value).toMatchObject({
      status: 'candidates',
      message: 'A workspace name is required, and no workspaces are registered.',
      candidates: [],
    })
  })
})

describe('workspace name matching', () => {
  it('resolves an exact path and an exact final path segment', async () => {
    const harness = await mount({
      workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice', ['s'])],
      summaries: [summary('s', 1, { title: 'S' })],
    })
    expect((await run(harness.ctx, 'voice_open_workspace', { name: '/tmp/voice', mode: 'resume' })).status).toBe('bound')
    expect((await run(harness.ctx, 'voice_open_workspace', { name: 'voice', mode: 'resume' })).status).toBe('bound')
  })

  it('returns candidates for title and path prefixes and substrings', async () => {
    const harness = await mount({
      workspaces: [workspace('ws-voice', 'Voice Panel', '/tmp/voice-panel')],
    })
    for (const name of ['voice', 'voi', 'panel', 'oice pan']) {
      const value = await run(harness.ctx, 'voice_open_workspace', { name, mode: 'resume' })
      expect(value.status).toBe('candidates')
    }
    expectUnbound(harness)
  })
})

describe('creating a session', () => {
  it('creates and binds one in the named workspace', async () => {
    const harness = await mount({
      workspaces: [workspace('ws-client', 'Client', '/tmp/client')],
      createdId: 'fresh',
    })
    harness.controller.list.mockResolvedValueOnce({ items: [summary('fresh', 8_000)] })
    const value = await run(harness.ctx, 'voice_new_session', { workspace: 'Client' })
    expect(value).toMatchObject({
      status: 'bound',
      created: true,
      message: 'Created and bound session fresh in workspace "Client" (/tmp/client). '
        + `Last activity ${new Date(8_000).toISOString()}.`,
      session: { sessionId: 'fresh', title: null, workspaceId: 'ws-client' },
    })
    expect(harness.createCalls).toEqual(['ws-client'])
    expect(harness.conductor.currentBinding).toEqual({ sessionId: 'fresh', workspaceId: 'ws-client' })
  })

  it('falls back to null activity when the created session is not listed yet', async () => {
    const harness = await mount({ workspaces: [workspace('ws-client', 'Client', '/tmp/client')] })
    harness.controller.list.mockResolvedValueOnce({ items: [] })
    const value = await run(harness.ctx, 'voice_new_session', { workspace: 'Client' })
    expect(value).toMatchObject({
      status: 'bound',
      message: 'Created and bound session created-session in workspace "Client" (/tmp/client).',
      session: { sessionId: 'created-session', title: null, lastActivityAt: null },
    })
  })

  it('does not create anything for an ambiguous workspace', async () => {
    const harness = await mount({
      workspaces: [workspace('ws-a', 'Client X', '/tmp/x'), workspace('ws-b', 'Client Y', '/tmp/y')],
    })
    const value = await run(harness.ctx, 'voice_new_session', { workspace: 'client' })
    expect(value.status).toBe('candidates')
    expect(harness.createCalls).toEqual([])
    expectUnbound(harness)
  })

  it('does not create anything for an unknown workspace', async () => {
    const harness = await mount({ workspaces: [workspace('ws-a', 'Client', '/tmp/x')] })
    const value = await run(harness.ctx, 'voice_new_session', { workspace: 'unknown' })
    expect(value).toMatchObject({ status: 'error', code: 'WORKSPACE_NOT_FOUND' })
    expect(harness.createCalls).toEqual([])
  })
})

describe('resuming a session', () => {
  it('binds the requested session by id', async () => {
    const harness = await mount({
      workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice', ['a', 'b'])],
      summaries: [summary('a', 1, { title: 'A' }), summary('b', 2, { title: 'B' })],
    })
    const value = await run(harness.ctx, 'voice_resume_session', { workspace: 'Voice', session_id: 'a' })
    expect(value).toMatchObject({ status: 'bound', created: false, session: { sessionId: 'a' } })
    expect(harness.conductor.currentBinding).toEqual({ sessionId: 'a', workspaceId: 'ws-voice' })
  })

  it('binds the newest unarchived session when no id is given', async () => {
    const harness = await mount({
      workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice', ['a', 'b'])],
      summaries: [summary('a', 1, { title: 'A' }), summary('b', 2, { title: 'B' })],
    })
    const value = await run(harness.ctx, 'voice_resume_session', { workspace: 'Voice' })
    expect(value).toMatchObject({ status: 'bound', session: { sessionId: 'b' } })
  })

  it('reports an unknown session id without binding', async () => {
    const harness = await mount({
      workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice', ['a'])],
      summaries: [summary('a', 1, { title: 'A' })],
    })
    const value = await run(harness.ctx, 'voice_resume_session', { workspace: 'Voice', session_id: 'missing' })
    expect(value).toMatchObject({
      status: 'error',
      code: 'SESSION_NOT_FOUND',
      message: 'Session "missing" is not available in workspace "Voice".',
      candidates: [],
    })
    expectUnbound(harness)
  })

  it('does not treat a session accounted elsewhere as available', async () => {
    const harness = await mount({
      workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice'), workspace('ws-client', 'Client', '/tmp/client', ['c'])],
      summaries: [summary('c', 1, { title: 'C' })],
    })
    const value = await run(harness.ctx, 'voice_resume_session', { workspace: 'Voice', session_id: 'c' })
    expect(value).toMatchObject({ status: 'error', code: 'SESSION_NOT_FOUND' })
  })

  it('reports a workspace with nothing to resume', async () => {
    const harness = await mount({ workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice')] })
    const value = await run(harness.ctx, 'voice_resume_session', { workspace: 'Voice' })
    expect(value).toMatchObject({
      status: 'error',
      code: 'SESSION_NOT_FOUND',
      message: 'Workspace "Voice" has no session to resume.',
    })
    expectUnbound(harness)
  })

  it('recovers an archived session by binding the newest live one', async () => {
    const harness = await mount({
      workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice', ['archived', 'live'])],
      summaries: [summary('archived', 1, { title: 'Archived' }), summary('live', 2, { title: 'Live' })],
      archived: ['archived'],
    })
    const value = await run(harness.ctx, 'voice_resume_session', { workspace: 'Voice', session_id: 'archived' })
    expect(value).toMatchObject({ status: 'bound', created: false, session: { sessionId: 'live' } })
    expect(value.message).toContain('because "Archived" (archived) is archived')
    expect(harness.conductor.currentBinding).toEqual({ sessionId: 'live', workspaceId: 'ws-voice' })
  })

  it('refuses a subagent session as a permission failure', async () => {
    const harness = await mount({
      workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice', ['child'])],
      summaries: [summary('child', 1, { title: 'Child', origin: 'subagent' })],
    })
    const value = await run(harness.ctx, 'voice_resume_session', { workspace: 'Voice', session_id: 'child' })
    expect(value).toMatchObject({
      status: 'error',
      code: 'PERMISSION_DENIED',
      message: '"Child" (child) belongs to a subagent and cannot be the voice session.',
      candidates: [],
    })
    expectUnbound(harness)
  })

  it('skips an accounted session the Host list does not return', async () => {
    const harness = await mount({
      workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice', ['ghost', 'live'])],
      summaries: [summary('live', 1, { title: 'Live' })],
    })
    const value = await run(harness.ctx, 'voice_resume_session', { workspace: 'Voice', session_id: 'ghost' })
    expect(value).toMatchObject({ status: 'error', code: 'SESSION_NOT_FOUND' })
    const bound = await run(harness.ctx, 'voice_resume_session', { workspace: 'Voice' })
    expect(bound).toMatchObject({ status: 'bound', session: { sessionId: 'live' } })
  })

  it('returns candidates for a partial workspace name without binding', async () => {
    const harness = await mount({
      workspaces: [workspace('ws-x', 'Client X', '/tmp/client-x'), workspace('ws-y', 'Client Y', '/tmp/client-y')],
    })
    const value = await run(harness.ctx, 'voice_resume_session', { workspace: 'client' })
    expect(value).toMatchObject({
      status: 'candidates',
      candidates: [{ workspaceId: 'ws-x' }, { workspaceId: 'ws-y' }],
    })
    expectUnbound(harness)
  })

  it('reports an unknown workspace without binding', async () => {
    const harness = await mount({ workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice')] })
    const value = await run(harness.ctx, 'voice_resume_session', { workspace: 'missing' })
    expect(value).toMatchObject({ status: 'error', code: 'WORKSPACE_NOT_FOUND', candidates: [{ workspaceId: 'ws-voice' }] })
    expectUnbound(harness)
  })
})

describe('binding failures', () => {
  it('propagates a rejected binding write and records nothing', async () => {
    const harness = await mount({
      workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice', ['a'])],
      summaries: [summary('a', 1, { title: 'A' })],
    })
    const target: VoiceBindingTarget = { bind: async () => { throw new Error('storage offline') } }
    harness.conductor.setBinding(target)
    const message = await fail(harness.ctx, 'voice_open_workspace', { name: 'Voice', mode: 'resume' })
    expect(message).toContain('storage offline')
    expectUnbound(harness)
  })

  it('installs a durable sink and still reports the processed binding', async () => {
    const harness = await mount({
      workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice', ['a'])],
      summaries: [summary('a', 1, { title: 'A' })],
    })
    const bind = vi.fn(async () => {})
    harness.conductor.setBinding({ bind })
    const value = await run(harness.ctx, 'voice_open_workspace', { name: 'Voice', mode: 'resume' })
    expect(value.status).toBe('bound')
    expect(bind).toHaveBeenCalledWith('a', 'ws-voice')
    expect(harness.conductor.currentBinding).toEqual({ sessionId: 'a', workspaceId: 'ws-voice' })
  })
})

describe('argument validation', () => {
  it('rejects arguments that do not match the declared parameters', async () => {
    const harness = await mount({ workspaces: [workspace('ws-voice', 'Voice', '/tmp/voice')] })
    const message = await fail(harness.ctx, 'voice_open_workspace', { name: 'Voice', mode: 'other' })
    expect(message).toContain('invalid arguments')
    expect(message).toContain('mode')
    expectUnbound(harness)
  })

  it('names the root when the arguments are not an object', async () => {
    const harness = await mount()
    const message = await fail(harness.ctx, 'voice_list_workspaces', null)
    expect(message).toContain('invalid arguments')
    expect(message).toContain('(root)')
  })
})

it('publishes the stable failure-code vocabulary', () => {
  expect(CONDUCTOR_ERROR_CODES).toEqual([
    'WORKSPACE_NOT_FOUND',
    'SESSION_NOT_FOUND',
    'PERMISSION_DENIED',
  ])
})
