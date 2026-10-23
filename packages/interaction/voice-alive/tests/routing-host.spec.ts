/**
 * Host composition: the conductor's switch lands in the row's durable binding,
 * so the reported ids, `currentBinding`, and the stored record stay one pair.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { afterEach, expect, it, vi } from 'vitest'
import VoiceAliveService from '../src/index.ts'
import type { BindingRecord } from '../src/binding/types.ts'

const contexts: Context[] = []
const homes: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

interface HostFakes {
  readonly ctx: Context
  readonly writes: BindingRecord[]
  readonly record: () => BindingRecord | null
  readonly live: Set<string>
}

async function mountHost(): Promise<HostFakes> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-voice-routing-'))
  homes.push(home)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)

  const createdAt = new Date(0).toISOString()
  const workspaceEntity = {
    id: WorkspaceId('ws-voice'),
    title: 'Voice',
    path: join(home, 'voice', 'workspace'),
    createdAt,
    updatedAt: createdAt,
    sessionIds: [SessionId('session-a')] as SessionId[],
  }
  const live = new Set<string>(['session-a'])
  const writes: BindingRecord[] = []
  let stored: BindingRecord | null = {
    sessionId: 'session-a',
    workspaceId: 'ws-voice',
    updatedAt: new Date().toISOString(),
  }
  const domain = {
    table: () => ({
      get: () => stored ?? undefined,
      put: async (_key: string, value: BindingRecord) => {
        writes.push(value)
        stored = value
      },
      delete: async () => {
        const existed = stored !== null
        stored = null
        return existed
      },
    }),
    close: async () => {},
  }
  const sessionController = {
    list: vi.fn(async () => ({
      items: workspaceEntity.sessionIds.map((sessionId, index) => ({
        sessionId,
        updatedAt: 1_000 + index,
        agentAvailable: false,
        running: false,
        blank: false,
      })),
    })),
    create: vi.fn(async () => {
      const sessionId = SessionId('session-created')
      workspaceEntity.sessionIds.push(sessionId)
      live.add(String(sessionId))
      return { sessionId }
    }),
  }

  ctx.provide('profileContext', { home } as never)
  ctx.provide('storageDomain', { open: async () => domain } as never)
  ctx.provide('workspaceRegistry', {
    get: (id: string) => (id === String(workspaceEntity.id) ? workspaceEntity : undefined),
    list: () => [workspaceEntity],
    create: async () => workspaceEntity,
    archivedSessionIds: [],
  } as never)
  ctx.provide('sessions', {
    get: (id: string) => (live.has(id) ? { id } : undefined),
  } as never)
  ctx.provide('sessionPersistence', { stat: async () => undefined } as never)
  ctx.provide('sessionController', sessionController as never)

  await ctx.plugin(VoiceAliveService)
  return { ctx, writes, record: () => stored, live }
}

it('routes a conductor switch through the durable binding', async () => {
  const host = await mountHost()
  expect(host.ctx.voiceAlive.binding.sessionId).toBe('session-a')
  expect(host.writes).toEqual([])

  const batch = await host.ctx.tools.execute({
    calls: [{
      type: 'tool-call',
      id: ToolCallId('call-new'),
      name: 'voice_new_session',
      arguments: JSON.stringify({ workspace: 'Voice' }),
    }],
    signal: new AbortController().signal,
  })
  const first = batch.results[0]
  if (first === undefined) throw new Error('missing tool result')
  const value = first.result.value as { status?: string; session?: { sessionId?: string } }
  expect(value.status).toBe('bound')
  expect(value.session?.sessionId).toBe('session-created')

  expect(host.writes).toHaveLength(1)
  expect(host.record()).toMatchObject({ sessionId: 'session-created', workspaceId: 'ws-voice' })
  expect(host.ctx.voiceAlive.binding.sessionId).toBe('session-created')
  expect(host.ctx.voiceAlive.binding.workspaceId).toBe('ws-voice')
  expect(host.ctx.voiceConductor.currentBinding).toEqual({
    sessionId: host.ctx.voiceAlive.binding.sessionId,
    workspaceId: host.ctx.voiceAlive.binding.workspaceId,
  })
})
