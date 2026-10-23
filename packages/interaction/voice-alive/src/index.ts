/**
 * Voice panel host row. The daemon lives inside the application's Host process
 * and dies with it: no companion service and no second profile. The row mounts
 * the service namespace; the conductor tools, session binding, and inference
 * engines attach through it.
 * @module @deepseek-ai/dsh-voice-alive
 */

import { Service, type Context, type Fiber } from '@deepseek-ai/cordis'
import { VoiceConductor } from './conductor/tools.ts'

export {
  CONDUCTOR_ERROR_CODES,
  VoiceConductor,
} from './conductor/tools.ts'
export type {
  ConductorBindingResult,
  ConductorBoundResult,
  ConductorCandidatesResult,
  ConductorErrorCode,
  ConductorErrorResult,
  ConductorSessionFact,
  ConductorWorkspaceFact,
  ConductorWorkspaceList,
  VoiceBindingTarget,
} from './conductor/tools.ts'
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
export { createEngineSupervisor, SupervisorError } from './engine/supervisor.ts'
export type {
  EngineFailureCode,
  EngineHealth,
  EngineHealthStatus,
  EngineName,
  EngineSupervisor,
  ModelSelection,
  SupervisorErrorCode,
  SupervisorOptions,
} from './engine/supervisor.ts'

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
  /** The conductor child's activation; awaits the four tools' registration. */
  readonly conductor: Fiber & PromiseLike<Fiber>

  /**
   * Register the service as `ctx.voiceAlive` and mount its conductor tools.
   * @param ctx - Host plugin context that owns the service lifetime.
   */
  constructor(ctx: Context) {
    super(ctx, 'voiceAlive')
    this.conductor = ctx.plugin(VoiceConductor)
  }
}

export default VoiceAliveService
