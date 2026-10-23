/** The host row registers one `ctx.voiceAlive` namespace and releases it with its fiber. */
import { Context } from '@deepseek-ai/cordis'
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
