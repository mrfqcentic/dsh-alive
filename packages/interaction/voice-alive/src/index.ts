/**
 * Voice panel host row. The daemon lives inside the application's Host process
 * and dies with it: no companion service and no second profile. The row mounts
 * the service namespace; the conductor tools, session binding, and inference
 * engines attach through it.
 * @module @deepseek-ai/dsh-voice-alive
 */

import { Service, type Context } from '@deepseek-ai/cordis'

export { AsrEngineError, createAsrEngine } from './engine/asr.ts'
export type {
  AsrEngine,
  AsrEngineErrorCode,
  AsrEngineOptions,
  AsrModelId,
  AsrRequest,
  AsrResult,
  AsrStatus,
} from './engine/types.ts'
export { createTtsEngine } from './engine/tts.ts'
export { TtsError } from './engine/tts-types.ts'
export type {
  TtsChunk,
  TtsEngine,
  TtsErrorCode,
  TtsRequest,
  TtsSpawnFn,
  TtsSpawnOptions,
  TtsStatus,
  TtsWorkerProcess,
} from './engine/tts-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The voice panel daemon mounted by this row. */
    voiceAlive: VoiceAliveService
  }
}

/**
 * Host service owned by the voice bundle row.
 *
 * It owns no state. The bound session, the audio state machine, and the
 * conductor belong on this service so other host plugins read one namespace
 * per panel rather than process-global state.
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
