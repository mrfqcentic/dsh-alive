/**
 * Audio state machine: the single owner of the five panel states.
 *
 * Capture, playback, the panel store, and the injected reply port meet here.
 * The machine keeps one turn in flight, publishes every transition to the
 * store the orb renders, and releases the microphone on mute. Mute is safe in
 * every state: it cancels the active turn, cuts playback, and drops anything
 * that turn would have enqueued later.
 *
 * The store is also the mute control. The panel's chord and orb button write
 * `muted` or `listening` to the store, and the machine follows those two
 * writes because they are the only external commands the panel surface has.
 * Any other external write (`thinking`, `speaking`, `error`) is an orb-only
 * preview: it does not command audio, and the next machine transition writes
 * its own state back. That keeps the panel store the single source for the orb
 * without letting a rendering concern drive capture or playback.
 *
 * An accepted segment while `thinking` is dropped rather than queued. One turn
 * is in flight at a time, the injected reply port cannot cancel the host turn,
 * and queueing would delay a later barge-in behind a stale reply. A segment
 * while `speaking` is a barge-in: playback stops, the current turn is
 * cancelled, and the new turn starts immediately.
 * @module @deepseek-ai/dsh-voice-alive/client/audio/machine
 */
import type { PanelState, PanelStateStore } from '../panel/state.ts'
import type { PlaybackChunk, PlaybackController } from './playback.ts'
import type { CaptureController, SpeechSegment } from './types.ts'

/** The five audio states; the same union the orb renders. */
export type AudioState = PanelState

/** Everything the machine drives. */
export interface AudioMachineDeps {
  /** Microphone capture. */
  capture: CaptureController
  /** Ordered reply playback. */
  playback: PlaybackController
  /** Panel store: written on every transition and observed for the mute control. */
  store: PanelStateStore
  /**
   * The turn end: returns the reply chunks to speak. Absent = transcript-only mode.
   * @param segment - the accepted utterance that ended the turn.
   * @returns reply chunks in playback order; an empty reply returns to listening.
   */
  respond?: (segment: SpeechSegment) => Promise<readonly PlaybackChunk[]>
}

/** Observable audio state machine. */
export interface AudioMachine {
  /** Current state; the last value written to the store. */
  readonly state: AudioState
  /**
   * Start listening and wire the capture, playback, and store signals.
   *
   * Idempotent while running, and the recovery path from a capture failure:
   * call it again after `error` to re-acquire the microphone.
   * @returns after capture acquisition settles.
   */
  start(): Promise<void>
  /**
   * Release capture and playback, remove the machine's subscriptions, clear
   * timers, and cancel the active turn. Idempotent.
   */
  stop(): void
  /**
   * Mute or unmute. Muting cuts playback, releases the microphone, and
   * cancels the active turn; unmuting listens again and re-acquires capture.
   * Idempotent and safe in every state.
   * @param muted - true to mute, false to listen again.
   */
  setMuted(muted: boolean): void
  /** Flip the mute state; the same effect as the panel's mute chord. */
  toggleMute(): void
  /**
   * @returns the loudness in 0..1 for the active direction: playback level
   * while `speaking`, otherwise 0. Capture level needs ticket 14's analyser;
   * this method is the extension point where that reading attaches.
   */
  getLevel(): number
  /**
   * Observe state transitions.
   * @param listener - receives each new state, never the current one on subscribe.
   * @returns function that stops observing.
   */
  onState(listener: (state: AudioState) => void): () => void
}

/**
 * How long the `error` state stays visible after a failed reply before the
 * machine returns to listening. Long enough to paint the orb tint, short
 * enough that the next utterance is not blocked.
 */
const ERROR_RECOVERY_MS = 800

/** One reply in flight; cancelling settles `signal` so waiting races stop. */
interface Turn {
  /** Settles when the turn is cancelled. */
  readonly signal: Promise<void>
  /** Resolve `signal`; the turn's result is discarded afterwards. */
  readonly cancel: () => void
}

/**
 * Whether one playback failure is the abort that `stop()` raises.
 * @param error - value the drain promise rejected with.
 * @returns true for an `AbortError`, which is cancellation, not a failure.
 */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** Implementation of {@link AudioMachine}; the factory is its only constructor. */
class Machine implements AudioMachine {
  private current: AudioState = 'muted'
  private mutedValue: boolean
  private running = false
  private turn: Turn | null = null
  private recovery: ReturnType<typeof setTimeout> | null = null
  private offSegment: (() => void) | undefined
  private offError: (() => void) | undefined
  private offStore: (() => void) | undefined
  private readonly listeners = new Set<(state: AudioState) => void>()
  private readonly deps: AudioMachineDeps

  /**
   * @param deps - capture, playback, store, and the optional reply port.
   */
  constructor(deps: AudioMachineDeps) {
    this.deps = deps
    // The panel boots muted; a store left in another state still starts unmuted.
    this.mutedValue = deps.store.get() === 'muted'
  }

  get state(): AudioState {
    return this.current
  }

  async start(): Promise<void> {
    this.running = true
    this.wire()
    if (this.mutedValue) {
      this.publish('muted')
      return
    }
    this.publish('listening')
    await this.listen()
  }

  stop(): void {
    this.running = false
    this.mutedValue = true
    this.cancelTurn()
    this.clearRecovery()
    this.unwire()
    this.deps.capture.stop()
    this.deps.playback.stop()
    this.publish('muted')
  }

  setMuted(muted: boolean): void {
    if (muted === this.mutedValue) return
    this.mutedValue = muted
    if (muted) {
      this.cancelTurn()
      this.clearRecovery()
      this.deps.playback.stop()
      this.deps.capture.setMuted(true)
      this.publish('muted')
      return
    }
    this.publish('listening')
    if (!this.running) return
    this.deps.capture.setMuted(false)
    void this.listen()
  }

  toggleMute(): void {
    this.setMuted(!this.mutedValue)
  }

  getLevel(): number {
    return this.current === 'speaking' ? this.deps.playback.getLevel() : 0
  }

  onState(listener: (state: AudioState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Subscribe to capture and store signals once per running period.
   */
  private wire(): void {
    if (this.offSegment !== undefined) return
    this.offSegment = this.deps.capture.onSegment((segment) => { this.accept(segment) })
    this.offError = this.deps.capture.onError(() => { this.captureFailed() })
    this.offStore = this.deps.store.subscribe((state) => { this.external(state) })
  }

  /** Remove every subscription the machine installed. */
  private unwire(): void {
    this.offSegment?.()
    this.offError?.()
    this.offStore?.()
    this.offSegment = undefined
    this.offError = undefined
    this.offStore = undefined
  }

  /**
   * Publish one transition to the store and to the machine's own observers.
   * @param next - state the machine is in now.
   */
  private publish(next: AudioState): void {
    const changed = next !== this.current
    this.current = next
    this.deps.store.set(next)
    // Any non-error state ends the visible error window; a new error keeps it.
    if (next !== 'error') this.clearRecovery()
    if (!changed) return
    for (const listener of [...this.listeners]) {
      try {
        listener(next)
      } catch {
        // A state observer must not break the transition it observed.
      }
    }
  }

  /** Clear the pending error recovery, if any. */
  private clearRecovery(): void {
    if (this.recovery === null) return
    clearTimeout(this.recovery)
    this.recovery = null
  }

  /** Return to listening after the visible error window. */
  private scheduleRecovery(): void {
    this.clearRecovery()
    this.recovery = setTimeout(() => {
      this.recovery = null
      this.publish('listening')
    }, ERROR_RECOVERY_MS)
  }

  /**
   * Reflect one external store write.
   * @param next - state another writer published.
   */
  private external(next: PanelState): void {
    if (next === 'muted') {
      if (!this.mutedValue) this.setMuted(true)
      return
    }
    if (this.mutedValue && next === 'listening') this.setMuted(false)
  }

  /**
   * Handle one accepted segment.
   * @param segment - the utterance capture accepted.
   */
  private accept(segment: SpeechSegment): void {
    if (!this.running || this.mutedValue) return
    if (this.current === 'thinking') return
    if (this.current === 'speaking') {
      this.cancelTurn()
      this.deps.playback.stop()
    }
    this.clearRecovery()
    this.begin(segment)
  }

  /**
   * Start one turn.
   * @param segment - the utterance that opened the turn.
   */
  private begin(segment: SpeechSegment): void {
    this.publish('thinking')
    const respond = this.deps.respond
    if (respond === undefined) {
      // Transcript-only mode has no reply to wait for; the turn closes at once.
      this.publish('listening')
      return
    }
    const turn = this.createTurn()
    this.turn = turn
    void this.run(turn, segment, respond)
  }

  /** @returns a fresh turn and its cancellation signal. */
  private createTurn(): Turn {
    const pending = Promise.withResolvers<void>()
    return { signal: pending.promise, cancel: pending.resolve }
  }

  /** Cancel the active turn, releasing anything waiting on it. */
  private cancelTurn(): void {
    const turn = this.turn
    if (turn === null) return
    this.turn = null
    turn.cancel()
  }

  /**
   * Run one reply: wait for chunks, enqueue them, and wait for the player to drain.
   * @param turn - the turn this work belongs to.
   * @param segment - the accepted utterance.
   * @param respond - the injected reply port.
   */
  private async run(
    turn: Turn,
    segment: SpeechSegment,
    respond: (segment: SpeechSegment) => Promise<readonly PlaybackChunk[]>,
  ): Promise<void> {
    // A rejection and a cancellation both produce null; turn identity tells
    // them apart: cancellation clears the machine's turn first.
    const chunks = await Promise.race([
      respond(segment).then(
        reply => reply,
        () => null,
      ),
      turn.signal.then(() => null),
    ])
    if (this.turn !== turn) return
    if (chunks === null) {
      this.finish('error')
      return
    }
    if (chunks.length === 0) {
      this.finish('listening')
      return
    }
    this.publish('speaking')
    for (const chunk of chunks) this.deps.playback.enqueue(chunk)
    const drained = await Promise.race([
      this.deps.playback.idle.then(
        () => true,
        (error: unknown) => error,
      ),
      turn.signal.then(() => true),
    ])
    if (this.turn !== turn) return
    if (drained === true) {
      this.finish('listening')
      return
    }
    this.finish(isAbort(drained) ? 'listening' : 'error')
  }

  /**
   * Close the active turn in one state.
   * @param next - state to publish after the turn.
   */
  private finish(next: AudioState): void {
    this.turn = null
    this.publish(next)
    if (next === 'error') this.scheduleRecovery()
  }

  /**
   * Acquire capture for the current listening period.
   * @returns after acquisition settles.
   */
  private async listen(): Promise<void> {
    try {
      await this.deps.capture.start()
    } catch {
      this.captureFailed()
      return
    }
    if (!this.running || this.mutedValue) return
    if (this.deps.capture.state === 'running') this.publish('listening')
  }

  /** Surface a capture failure without leaving a turn or playback running. */
  private captureFailed(): void {
    if (!this.running || this.mutedValue) return
    this.cancelTurn()
    this.clearRecovery()
    this.deps.playback.stop()
    this.publish('error')
  }
}

/**
 * Create the audio state machine.
 *
 * The machine starts inert and muted when the store is muted; `start()` wires
 * the signals and begins listening otherwise. Stop it on surface unmount.
 * @param deps - capture, playback, store, and the optional reply port.
 * @returns the machine over those dependencies.
 */
export function createAudioMachine(deps: AudioMachineDeps): AudioMachine {
  return new Machine(deps)
}
