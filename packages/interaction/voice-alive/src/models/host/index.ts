/**
 * Host-side model subsystem surface: the directory under the profile home and
 * the catalog, store, and readiness API the voice row exposes.
 *
 * The Audio workspace already uses `<home>/voice`; models live beside it under
 * `<home>/voice/models`, so a profile move or backup carries both.
 * @module @deepseek-ai/dsh-voice-alive/models/host
 */
import { join } from 'node:path'

/**
 * Model store root of one profile.
 * @param home - resolved Harness home of the launching profile.
 * @returns the absolute directory that holds one child per installed model.
 */
export function voiceModelsRoot(home: string): string {
  return join(home, 'voice', 'models')
}

export { MODEL_CATALOG, catalogEntry, modelBytes } from '../catalog.ts'
export {
  MODELS_ACTION_PATH,
  MODELS_EVENTS_PATH,
  MODELS_SNAPSHOT_PATH,
  modelSnapshot,
  registerModelRoutes,
} from './endpoint.ts'
export { configureSupervisor, requireSelection } from './gate.ts'
export { ModelStoreError } from './errors.ts'
export { SUPPORTED_PLATFORM, createModelStore } from './store.ts'
export type { ModelActionKind } from './endpoint.ts'
export type {
  AsrCatalogEngine,
  ModelFailure,
  ModelFailureCode,
  ModelFile,
  ModelId,
  ModelKind,
  ModelReadiness,
  ModelRecord,
  ModelSelection,
  ModelSnapshot,
  ModelState,
  ModelView,
} from '../types.ts'
export type { SupervisorPort } from './gate.ts'
export type { ModelStore, ModelStoreOptions } from './store.ts'
