/**
 * Voice panel host row. The daemon lives inside the application's Host process
 * and dies with it: no companion service and no second profile. The row mounts
 * the service namespace and its conductor child; the session binding installs
 * here, and the audio state machine and inference engines attach through it.
 * @module @deepseek-ai/dsh-voice-alive
 */

import { Service, type Context, type Fiber } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-workspace'
import { createVoiceBindingDeps } from './binding/harness.ts'
import { createVoiceBinding } from './binding/index.ts'
import type { VoiceBinding } from './binding/types.ts'
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
export { createVoiceBinding } from './binding/index.ts'
export type {
  BindingDeps,
  BindingRecord,
  BindingSessionStatus,
  BindingSessions,
  BindingState,
  BindingStorage,
  BindingWorkspace,
  BindingWorkspaces,
  VoiceBinding,
} from './binding/types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The voice panel daemon mounted by this row. */
    voiceAlive: VoiceAliveService
  }
}

/**
 * Host service owned by the voice bundle row.
 *
 * It owns the panel's session binding for its lifetime and mounts its conductor
 * child, so the history store and the conductor read one namespace per panel
 * rather than process-global state. The audio state machine and inference
 * engines attach to this namespace as their tickets land.
 */
export class VoiceAliveService extends Service {
  static inject = ['storageDomain', 'workspaceRegistry', 'sessions', 'sessionPersistence', 'sessionController']

  /** The conductor child's activation; awaits the four tools' registration. */
  readonly conductor: Fiber & PromiseLike<Fiber>

  private voiceBinding: VoiceBinding | undefined

  /**
   * Register the service as `ctx.voiceAlive` and mount its conductor tools.
   * @param ctx - Host plugin context that owns the service lifetime.
   */
  constructor(ctx: Context) {
    super(ctx, 'voiceAlive')
    this.conductor = ctx.plugin(VoiceConductor)
  }

  /**
   * The panel's session binding, installed once the host services this row
   * injects are active.
   * @returns the single binding instance.
   * @throws when read before installation (the injected services are absent).
   */
  get binding(): VoiceBinding {
    if (this.voiceBinding === undefined) {
      throw new Error('voice binding is not installed: the host storage, workspace, and session services are absent')
    }
    return this.voiceBinding
  }

  /** Install the binding and restore the stored session without failing activation on it. */
  protected async [Service.init](): Promise<void> {
    const binding = createVoiceBinding(createVoiceBindingDeps(this.ctx))
    this.voiceBinding = binding
    try {
      await binding.ensure()
    } catch (error: unknown) {
      this.ctx.logger.warn(`voice binding: startup restore failed: ${String(error)}`)
    }
  }
}

export default VoiceAliveService
