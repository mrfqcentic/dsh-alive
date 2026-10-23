/**
 * Voice panel host row. The daemon lives inside the application's Host process
 * and dies with it: no companion service and no second profile. This ticket
 * mounts the service namespace only; the conductor tools, session binding, and
 * inference engines arrive in later tickets.
 * @module @deepseek-ai/dsh-voice-alive
 */

import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The voice panel daemon mounted by this row. */
    voiceAlive: VoiceAliveService
  }
}

/**
 * Host service owned by the voice bundle row.
 *
 * It holds no state yet: later tickets attach the bound session, the audio
 * state machine, and the conductor to this service so other host plugins read
 * one namespace per panel rather than process-global state.
 */
export class VoiceAliveService extends Service {
  /**
   * Register the service as `ctx.voiceAlive`.
   * @param ctx - Host plugin context that owns the service lifetime.
   */
  constructor(ctx: Context) {
    super(ctx, 'voiceAlive')
  }
}

export default VoiceAliveService
