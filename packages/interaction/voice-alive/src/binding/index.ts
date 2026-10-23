/**
 * The panel's session binding: one durable `{ sessionId, workspaceId,
 * updatedAt }` record that survives restarts, follows conductor switches,
 * and falls back to a fresh session in the Audio workspace when the stored
 * one is gone. Every write runs on one serialized chain, so concurrent
 * callers can never interleave the record.
 * @module @deepseek-ai/dsh-voice-alive/binding
 */

import type {
  BindingDeps,
  BindingRecord,
  BindingState,
  VoiceBinding,
} from './types.ts'

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
} from './types.ts'

/** A bound pair without storage-only fields. */
type BoundPair = { sessionId: string; workspaceId: string }

/**
 * Describe a caught failure for a diagnostic line.
 * @param error - the caught value.
 * @returns the message for an `Error`, otherwise its string form.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Create the session binding over host-supplied ports.
 *
 * `ensure` is the startup entry: it restores a still-valid record or creates
 * the Audio workspace and a session in it, then records the switch. A
 * storage failure during that fallback leaves the binding usable in memory
 * and reports through `warn`; registry failures reject so the host can retry.
 * `bind` and `unbind` are the conductor's write paths and reject when
 * durability fails, keeping in-memory state at the last committed pair.
 * @param deps - storage, registries, clock, and diagnostic sink.
 * @returns the binding instance.
 */
export function createVoiceBinding(deps: BindingDeps): VoiceBinding {
  const clock = deps.now ?? (() => new Date())
  const warn = deps.warn ?? (() => {})

  let sessionId: string | null = null
  let workspaceId: string | null = null
  let state: BindingState = 'unbound'
  // Tail of the single write chain. Every operation links onto it, so the
  // record is read, rewritten, and committed by one caller at a time.
  let tail: Promise<void> = Promise.resolve()

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = tail.then(operation, operation)
    tail = run.then(() => {}, () => {})
    return run
  }

  const record = (pair: BoundPair): BindingRecord => ({
    sessionId: pair.sessionId,
    workspaceId: pair.workspaceId,
    updatedAt: clock().toISOString(),
  })

  const commit = (pair: BoundPair): BoundPair => {
    sessionId = pair.sessionId
    workspaceId = pair.workspaceId
    state = 'bound'
    return pair
  }

  const clearMemory = (): void => {
    sessionId = null
    workspaceId = null
    state = 'unbound'
  }

  const readStored = async (): Promise<BindingRecord | null> => {
    try {
      return await deps.storage.read()
    } catch (error: unknown) {
      warn(`voice binding: could not read the stored binding: ${describe(error)}`)
      return null
    }
  }

  const resolveStored = async (): Promise<BoundPair | null> => {
    const stored = await readStored()
    if (stored === null) return null
    if (deps.workspaces.get(stored.workspaceId) === undefined) {
      warn(`voice binding: workspace '${stored.workspaceId}' is gone; binding a new session`)
      return null
    }
    const status = await deps.sessions.status(stored.sessionId)
    if (status !== 'active') {
      warn(`voice binding: session '${stored.sessionId}' is ${status}; binding a new session`)
      return null
    }
    return { sessionId: stored.sessionId, workspaceId: stored.workspaceId }
  }

  const persist = async (pair: BoundPair): Promise<void> => {
    try {
      await deps.storage.write(record(pair))
    } catch (error: unknown) {
      warn(`voice binding: could not store the binding: ${describe(error)}`)
    }
  }

  const restoreCommitted = async (): Promise<BoundPair | null> => {
    const previous = state
    state = 'restoring'
    try {
      const restored = await resolveStored()
      if (restored === null) {
        clearMemory()
        return null
      }
      return commit(restored)
    } catch (error: unknown) {
      state = previous
      throw error
    }
  }

  return {
    get sessionId() {
      return sessionId
    },
    get workspaceId() {
      return workspaceId
    },
    get state() {
      return state
    },

    bind(nextSessionId, nextWorkspaceId) {
      return serialize(async () => {
        await deps.storage.write(record({ sessionId: nextSessionId, workspaceId: nextWorkspaceId }))
        commit({ sessionId: nextSessionId, workspaceId: nextWorkspaceId })
      })
    },

    unbind() {
      return serialize(async () => {
        await deps.storage.clear()
        clearMemory()
      })
    },

    restore() {
      return serialize(restoreCommitted)
    },

    ensure() {
      return serialize(async () => {
        const previous = state
        state = 'restoring'
        try {
          const restored = await resolveStored()
          if (restored !== null) return commit(restored)
          const workspace = await deps.workspaces.ensure()
          const created = await deps.sessions.create(workspace)
          const pair = { sessionId: created, workspaceId: workspace.workspaceId }
          // Startup keeps a usable in-memory binding when the medium is down;
          // the next successful write repairs the record.
          await persist(pair)
          return commit(pair)
        } catch (error: unknown) {
          state = previous
          throw error
        }
      })
    },
  }
}
