/** The host row registers one `ctx.voiceAlive` namespace and releases it with its fiber. */
import { Context } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'
import VoiceAliveService, { VoiceAliveService as DefaultVoiceAliveService } from '../src/index.ts'

it('mounts the voice panel service for the plugin lifetime', async () => {
  const ctx = new Context()
  const service = new VoiceAliveService(ctx)
  expect(DefaultVoiceAliveService).toBe(VoiceAliveService)
  expect(service.name).toBe('voiceAlive')
  expect(ctx.voiceAlive).toBeInstanceOf(VoiceAliveService)
  await ctx.fiber.dispose()
  expect(ctx.get('voiceAlive')).toBeUndefined()
})

it('creates one model store under the profile voice directory', async () => {
  const ctx = new Context()
  ctx.provide('profileContext', { home: '/tmp/dsh-voice-test' } as ProfileContext)
  const service = new VoiceAliveService(ctx)
  const store = service.models
  expect(store.root).toBe('/tmp/dsh-voice-test/voice/models')
  expect(service.models).toBe(store)
  await ctx.fiber.dispose()
})

it('refuses the model store outside a dsh profile', async () => {
  const ctx = new Context()
  const service = new VoiceAliveService(ctx)
  expect(() => service.models).toThrow(expect.objectContaining({ code: 'state' }))
  await ctx.fiber.dispose()
})
