/**
 * Voice instructions: the host row installs one policy section, the section
 * names the conductor tools that are actually registered, and it renders only
 * for the Session the panel follows.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import VoiceAliveService from '../src/index.ts'
import { VOICE_INSTRUCTIONS_SECTION } from '../src/instructions.ts'

/** The four conductor tools the policy is allowed to name. */
const CONDUCTOR_TOOLS = [
  'voice_list_workspaces',
  'voice_open_workspace',
  'voice_new_session',
  'voice_resume_session',
] as const

const contexts: Context[] = []
const homes: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

interface Row {
  readonly ctx: Context
  readonly fiber: Fiber
}

/** One workspace entity the fakes expose to the binding and the conductor. */
interface FakeWorkspace {
  id: string
  path: string
  title: string
  sessionIds: string[]
}

/**
 * Mount the real host row over fakes for the Host registries it injects, with
 * the prompt registry and tool registry the policy section needs.
 * @param options - `createSession` replaces the session controller's creation call.
 * @returns the mounted row and its fiber.
 */
async function mountRow(options: {
  createSession?: (request: { workspaceId: string }, call: number) => Promise<{ sessionId: string }>
} = {}): Promise<Row> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-voice-instructions-'))
  homes.push(home)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)

  const workspaces = new Map<string, FakeWorkspace>()
  let record: unknown = null
  let creates = 0
  const createSession = options.createSession
    ?? (async (_request, call) => ({ sessionId: `session-${call}` }))
  ctx.provide('profileContext', { home } as never)
  ctx.provide('storageDomain', {
    open: async () => ({
      table: () => ({
        get: () => record ?? undefined,
        put: async (_key: string, value: unknown) => { record = value },
        delete: async () => {
          const existed = record !== null
          record = null
          return existed
        },
      }),
      close: async () => {},
    }),
  } as never)
  ctx.provide('workspaceRegistry', {
    list: () => [...workspaces.values()],
    get: (id: string) => workspaces.get(id),
    create: (path: string, title: string) => {
      const entity: FakeWorkspace = { id: `ws-${workspaces.size + 1}`, path, title, sessionIds: [] }
      workspaces.set(entity.id, entity)
      return entity
    },
    archivedSessionIds: [],
  } as never)
  ctx.provide('sessions', { get: () => undefined } as never)
  ctx.provide('sessionPersistence', { stat: async () => undefined } as never)
  ctx.provide('sessionController', {
    list: async () => ({ items: [] }),
    create: async (request: { workspaceId: string }) => {
      creates += 1
      return await createSession(request, creates)
    },
  } as never)

  const fiber = await ctx.plugin(VoiceAliveService)
  return { ctx, fiber }
}

/**
 * Build the structural Agent one prompt assembly needs.
 * @param ctx - context handed to the stub; assembly never reads it.
 * @param sessionId - identity of the stub's Session.
 * @returns an Agent whose only read field is the Session id.
 */
function agentFor(ctx: Context, sessionId: string): Agent {
  const session = Session.create(SessionId(sessionId))
  return {
    id: session.id,
    options: {},
    session,
    model: unsupportedModel(),
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  } satisfies Agent
}

/**
 * Render one Session's system prompt.
 * @param ctx - context with the prompt registry and the voice row.
 * @param sessionId - the Session whose Agent assembles.
 * @returns the rendered prompt.
 */
async function promptFor(ctx: Context, sessionId: string): Promise<string> {
  return renderPrompt(await ctx.systemPrompt.assemble({ agent: agentFor(ctx, sessionId) }))
}

/**
 * Count the voice policy sections one Session's assembly carries.
 * @param ctx - context with the prompt registry and the voice row.
 * @param sessionId - the Session whose Agent assembles.
 * @returns the number of installed policy sections.
 */
async function policySectionCount(ctx: Context, sessionId: string): Promise<number> {
  const assembly = await ctx.systemPrompt.assemble({ agent: agentFor(ctx, sessionId) })
  return assembly.sections.filter(section => section.name === VOICE_INSTRUCTIONS_SECTION).length
}

/** Count non-overlapping occurrences of one tool name in rendered text. */
function occurrences(text: string, name: string): number {
  return text.split(name).length - 1
}

describe('voice instructions', () => {
  it('installs one policy section that names the registered conductor tools', async () => {
    const { ctx } = await mountRow()

    const registered = ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('voice_')).sort()
    expect(registered).toEqual([...CONDUCTOR_TOOLS].sort())

    const prompt = await promptFor(ctx, 'session-1')
    expect(prompt).toContain('remote control')
    for (const name of CONDUCTOR_TOOLS) expect(occurrences(prompt, name)).toBe(1)
    expect(prompt).toContain('`mode`')
    expect(prompt).toContain('`session_id`')
    expect(prompt).toContain('candidates')
    expect(prompt).toContain('"Voice"')
    expect(await policySectionCount(ctx, 'session-1')).toBe(1)
  })

  it('renders nothing for a Session the panel does not follow', async () => {
    const { ctx } = await mountRow()

    const prompt = await promptFor(ctx, 'another-session')
    expect(prompt).not.toContain('remote control')
    for (const name of CONDUCTOR_TOOLS) expect(prompt).not.toContain(name)
    expect(prompt).toContain('You are an AI agent')
    expect(await policySectionCount(ctx, 'another-session')).toBe(1)
  })

  it('renders nothing before the panel has a bound Session', async () => {
    const { ctx } = await mountRow({
      createSession: async () => { throw new Error('no agent factory') },
    })

    const prompt = await promptFor(ctx, 'session-1')
    expect(prompt).not.toContain('remote control')
  })

  it('renders nothing on a diagnostics assembly without an Agent', async () => {
    const { ctx } = await mountRow()

    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).not.toContain('remote control')
  })

  it('follows a conductor switch to the newly bound Session', async () => {
    const { ctx } = await mountRow()
    expect(ctx.voiceAlive.binding.sessionId).toBe('session-1')

    const batch = await ctx.tools.execute({
      calls: [{
        type: 'tool-call',
        id: ToolCallId('call-new-session'),
        name: 'voice_new_session',
        arguments: JSON.stringify({ workspace: 'Voice' }),
      }],
      signal: new AbortController().signal,
    })
    expect(batch.results[0]?.result.isError).toBe(false)
    expect(ctx.voiceConductor.currentBinding?.sessionId).toBe('session-2')

    const switched = await promptFor(ctx, 'session-2')
    expect(occurrences(switched, 'voice_open_workspace')).toBe(1)
    const previous = await promptFor(ctx, 'session-1')
    expect(previous).not.toContain('remote control')
  })

  it('installs exactly one section across a row restart', async () => {
    const first = await mountRow()
    const firstBound = first.ctx.voiceAlive.binding.sessionId
    expect(firstBound).not.toBeNull()
    expect(await promptFor(first.ctx, String(firstBound))).toContain('remote control')
    expect(await policySectionCount(first.ctx, String(firstBound))).toBe(1)

    await first.fiber.dispose()
    expect(await policySectionCount(first.ctx, String(firstBound))).toBe(0)
    expect(await promptFor(first.ctx, String(firstBound))).not.toContain('remote control')

    const fiber = await first.ctx.plugin(VoiceAliveService)
    const restartedBound = first.ctx.voiceAlive.binding.sessionId
    expect(restartedBound).not.toBeNull()
    expect(restartedBound).not.toBe(firstBound)
    expect(await policySectionCount(first.ctx, String(restartedBound))).toBe(1)
    const restarted = await promptFor(first.ctx, String(restartedBound))
    expect(occurrences(restarted, 'voice_list_workspaces')).toBe(1)
    expect(occurrences(restarted, 'remote control')).toBe(1)
    await fiber.dispose()
  })
})
