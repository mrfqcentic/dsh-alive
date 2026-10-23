/**
 * Typed model-store failures and the filesystem-failure wrapper both the store
 * and its downloader use.
 *
 * Download, install, and readiness paths throw one error type so the pane can
 * render a stable category instead of a raw message, and so a failure keeps its
 * cause locally without leaking a stack trace to the renderer.
 * @module @deepseek-ai/dsh-voice-alive/models/host/errors
 */
import type { ModelFailure, ModelFailureCode } from '../types.ts'

/** A failure a caller can show; `code` is stable across releases. */
export class ModelStoreError extends Error {
  /**
   * @param code - stable failure category.
   * @param message - actionable description naming the model and step.
   * @param options - optional original cause, kept off the wire.
   */
  constructor(readonly code: ModelFailureCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ModelStoreError'
  }

  /** The safe projection the pane renders: the code and the message, never the cause. */
  get failure(): ModelFailure {
    return { code: this.code, message: this.message }
  }
}

/**
 * Project any thrown value onto the safe failure shape.
 * @param error - value a model operation rejected with.
 * @param fallback - category used when the value carries no model failure.
 * @returns the model failure, or a generic one for an untyped value.
 */
export function failureOf(error: unknown, fallback: ModelFailureCode = 'internal'): ModelFailure {
  if (error instanceof ModelStoreError) return error.failure
  return { code: fallback, message: reasonOf(error) }
}

/**
 * Describe a thrown value by its stable code when it has one.
 * @param error - value a filesystem or transport call rejected with.
 * @returns the error code, else its message, else its string form.
 */
export function reasonOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run one filesystem operation, reporting any rejection as a typed disk failure.
 * @param work - operation to await.
 * @param what - step named in the failure message.
 * @returns the operation result.
 */
export async function diskStep<T>(work: Promise<T>, what: string): Promise<T> {
  try {
    return await work
  } catch (error) {
    throw new ModelStoreError('disk', `model store could not ${what} (${reasonOf(error)})`, { cause: error })
  }
}
