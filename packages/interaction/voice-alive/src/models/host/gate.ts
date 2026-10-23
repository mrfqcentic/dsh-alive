/**
 * Readiness gate between the model store and the engine supervisor.
 *
 * The voice layer may configure the supervisor only with a verified selection.
 * The gate refuses before any engine load starts, so a blocked install never
 * leaves a half-configured supervisor and never falls back to another model.
 * @module @deepseek-ai/dsh-voice-alive/models/host/gate
 */
import type { ModelSelection } from '../types.ts'
import { ModelStoreError } from './errors.ts'
import type { ModelStore } from './store.ts'

/** Supervisor surface the gate drives; `EngineSupervisor` satisfies it. */
export interface SupervisorPort {
  /**
   * Apply one verified selection to both engines.
   * @param selection - recognizer and synthesizer directories.
   */
  configure(selection: ModelSelection): Promise<void>
}

/**
 * Read the verified selection.
 *
 * Verification runs first, so a directory installed by an earlier process is
 * hashed before an engine is allowed to load it.
 * @param store - model store to read.
 * @returns the selection the supervisor can configure.
 * @throws {ModelStoreError} naming the missing kind while the required set is incomplete.
 */
export async function requireSelection(store: ModelStore): Promise<ModelSelection> {
  await store.initialize()
  const readiness = store.readiness()
  if (!readiness.ready) throw new ModelStoreError(readiness.failure.code, readiness.failure.message)
  const selection = store.selection()
  /* v8 ignore next 3 -- a ready store always yields a selection; the guard only narrows the union */
  if (selection === null) {
    throw new ModelStoreError('state', 'the model store reported readiness without a selection')
  }
  return selection
}

/**
 * Configure the supervisor from the verified model selection.
 * @param store - model store to read.
 * @param supervisor - engine supervisor to configure.
 * @throws {ModelStoreError} before any engine load while the required set is incomplete.
 */
export async function configureSupervisor(store: ModelStore, supervisor: SupervisorPort): Promise<void> {
  const selection = await requireSelection(store)
  await supervisor.configure(selection)
}
