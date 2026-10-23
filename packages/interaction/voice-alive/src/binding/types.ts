/**
 * Session-binding vocabulary: the durable record, the ports the binding
 * drives, and the observable surface the conductor and history store use.
 * Types only — the implementation lives in `./index.ts` and its adapters.
 * @module @deepseek-ai/dsh-voice-alive/binding/types
 */

/** One persisted binding, written whole on every switch. */
export interface BindingRecord {
  /** Bound session id. */
  readonly sessionId: string
  /** Workspace that owns the bound session. */
  readonly workspaceId: string
  /** ISO-8601 instant of the write that produced this record. */
  readonly updatedAt: string
}

/**
 * Durable storage for the single binding record. The binding owns the only
 * write path, so implementations need no compare-and-set.
 */
export interface BindingStorage {
  /**
   * Read the stored record.
   * @returns the record, or `null` when none is stored.
   */
  read(): Promise<BindingRecord | null>

  /**
   * Replace the stored record durably.
   * @param record - the complete next record.
   * @returns resolution after durability.
   */
  write(record: BindingRecord): Promise<void>

  /**
   * Remove the stored record durably. Idempotent.
   * @returns resolution after durability.
   */
  clear(): Promise<void>
}

/** A workspace the binding can point at. */
export interface BindingWorkspace {
  /** Workspace registration id. */
  readonly workspaceId: string
  /** Canonical workspace directory; a session created here carries it as `cwd`. */
  readonly path: string
}

/** Whether a stored session can still receive the panel. */
export type BindingSessionStatus = 'active' | 'archived' | 'missing'

/** Session registry the binding validates and creates through. */
export interface BindingSessions {
  /**
   * Classify one stored session.
   * @param sessionId - the session to look up.
   * @returns `active` when it can be bound, otherwise the reason it cannot.
   */
  status(sessionId: string): Promise<BindingSessionStatus>

  /**
   * Create a session inside a workspace and account it there.
   * @param workspace - the workspace that receives the session.
   * @returns the created session id.
   */
  create(workspace: BindingWorkspace): Promise<string>
}

/** Workspace registry the binding resolves and creates through. */
export interface BindingWorkspaces {
  /**
   * Resolve a workspace registration.
   * @param workspaceId - the id to look up.
   * @returns the workspace, or `undefined` when the registration is gone.
   */
  get(workspaceId: string): BindingWorkspace | undefined

  /**
   * Create or reuse the Audio workspace. Idempotent by canonical directory:
   * repeated calls return the same registration.
   * @returns the Audio workspace.
   */
  ensure(): Promise<BindingWorkspace>
}

/** Everything a binding needs from its host. */
export interface BindingDeps {
  /** Durable record storage. */
  readonly storage: BindingStorage
  /** Session registry. */
  readonly sessions: BindingSessions
  /** Workspace registry. */
  readonly workspaces: BindingWorkspaces
  /** Clock for `updatedAt`; the wall clock when omitted. */
  readonly now?: () => Date
  /** Diagnostic sink for recoverable failures; silent when omitted. */
  readonly warn?: (message: string) => void
}

/** Binding lifecycle as observed between calls. */
export type BindingState = 'unbound' | 'restoring' | 'bound'

/**
 * The panel's single bound session.
 *
 * Reads are synchronous snapshots of the last committed binding. Writes are
 * serialized on one chain, so a concurrent `bind`/`ensure` pair can never
 * interleave its storage writes. In-memory state publishes only after the
 * durable write settles, except the startup fallback, which keeps a usable
 * binding in memory when the medium is unavailable.
 */
export interface VoiceBinding {
  /** Bound session id, or `null` while unbound. */
  readonly sessionId: string | null
  /** Bound workspace id, or `null` while unbound. */
  readonly workspaceId: string | null
  /**
   * Follow the conductor's switch: make `sessionId`/`workspaceId` the bound
   * pair and persist it. The caller has already validated both.
   * @param sessionId - the session to bind.
   * @param workspaceId - the workspace that owns it.
   * @returns resolution after the durable write.
   */
  bind(sessionId: string, workspaceId: string): Promise<void>

  /**
   * Drop the binding and remove the stored record. Idempotent.
   * @returns resolution after the durable clear.
   */
  unbind(): Promise<void>

  /**
   * Restore the stored binding when both its workspace and its session still
   * exist and the session is not archived. Never creates or writes.
   * @returns the restored pair, or `null` when nothing usable is stored.
   */
  restore(): Promise<{ sessionId: string; workspaceId: string } | null>

  /**
   * Guarantee a bound session for host start: restore when possible,
   * otherwise create a session in the Audio workspace and record it. A
   * storage failure leaves the in-memory binding intact instead of rejecting.
   * @returns the bound pair.
   */
  ensure(): Promise<{ sessionId: string; workspaceId: string }>

  /** Current lifecycle state. */
  readonly state: BindingState
}
