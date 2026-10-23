/**
 * Value types shared by microphone capture, voice activity detection, and the
 * word gate. They are declaration-only so capture can import them without
 * pulling the controller, the detector, or the device layer into one graph.
 * @module @deepseek-ai/dsh-voice-alive/client/audio/types
 */
import type { CaptureError } from './devices.ts'

/**
 * One block of captured audio.
 *
 * `at` is capture-relative: the first analyzed frame starts at 0 ms and every
 * successive 20 ms frame advances the clock, so the value is independent of
 * wall time and of audio-context clock resets.
 */
export interface CaptureChunk {
  /** 16 kHz mono signed 16-bit PCM. */
  readonly pcm: Int16Array
  /** Capture-relative start time of the block in milliseconds. */
  readonly at: number
}

/**
 * One closed utterance handed to the word gate and, when accepted, to the
 * segment listener.
 */
export interface SpeechSegment {
  /**
   * Segment number unique within one capture controller, starting at 0. It
   * survives mute, stop, and failure, and resets only with a new controller.
   */
  readonly id: number
  /**
   * 16 kHz mono signed 16-bit PCM. Includes the pre-roll before the first
   * voiced frame and at most 200 ms of trailing audio after the last one.
   */
  readonly pcm: Int16Array
  /** Capture-relative start time in milliseconds, including the pre-roll. */
  readonly startedAt: number
  /** Capture-relative end time in milliseconds. */
  readonly endedAt: number
  /** Largest absolute sample in `pcm`, normalized so full scale is 1. */
  readonly peak: number
  /** Root-mean-square level across `pcm`, normalized so full scale is 1. */
  readonly rms: number
}

/**
 * Decides whether a closed segment contains real words.
 *
 * Capture runs the gate before delivering anything: a segment the gate
 * rejects produces no call to `onSegment`. The decision may be asynchronous
 * because a transcript-based gate must await recognition.
 */
export interface WordGate {
  /**
   * Decide whether a closed segment contains speech that may become a turn.
   * @param segment - closed segment with its level statistics.
   * @returns true to deliver the segment, false to discard it silently.
   */
  accept(segment: SpeechSegment): Promise<boolean> | boolean
}

/**
 * Options accepted by {@link import('./capture.ts').createCapture}.
 *
 * Capture is always 16 kHz mono; an audio context that cannot run at that rate
 * is resampled rather than configured.
 */
export interface CaptureOptions {
  /** Exact input device id; absent follows the system default input. */
  deviceId?: string
  /** Decision applied to every closed segment; absent uses the energy gate. */
  gate?: WordGate
}

/**
 * Microphone acquisition and segmentation of one capture controller.
 *
 * `muted` and `stop()` release the microphone and discard an open segment;
 * speaking again requires `start()` (or unmuting a controller that was
 * running). That trade keeps the microphone light off while muted.
 */
export interface CaptureController {
  /** Current lifecycle state; starts as `idle`. */
  readonly state: 'idle' | 'running' | 'muted' | 'error'

  /**
   * Acquire the selected input and begin segmenting speech.
   *
   * Idempotent while `running` and while a previous call is still acquiring.
   * A `stop()` or mute during acquisition discards that acquisition, so a
   * later `start()` or unmute acquires again instead of being dropped.
   * Failures are reported to {@link CaptureController.onError} and leave the
   * controller in `error`; this promise does not reject for them.
   */
  start(): Promise<void>

  /** Release the microphone, close the audio context, and return to `idle`. */
  stop(): void

  /**
   * Mute or unmute. Muting releases the microphone and closes the audio
   * context; unmuting restarts capture only if it was running when muted.
   * @param muted - true to stop capture, false to resume it.
   */
  setMuted(muted: boolean): void

  /**
   * Observe accepted segments.
   * @param listener - receives each segment the word gate accepts.
   * @returns function that stops observing.
   */
  onSegment(listener: (segment: SpeechSegment) => void): () => void

  /**
   * Observe acquisition and gate failures.
   * @param listener - receives each typed failure.
   * @returns function that stops observing.
   */
  onError(listener: (error: CaptureError) => void): () => void
}
