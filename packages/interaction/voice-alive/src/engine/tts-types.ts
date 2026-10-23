/** Public contracts for the local Kokoro text-to-speech engine and its private worker protocol. */
import type { Readable, Writable } from 'node:stream'

/** Engine life cycle state; `unloaded` never means the model configuration was forgotten. */
export type TtsStatus = 'unloaded' | 'loading' | 'ready' | 'error'

/** One reply to speak. `id` correlates every emitted chunk with its request. */
export interface TtsRequest {
  /** Caller-owned request identity, copied onto each chunk. */
  readonly id: string
  /** Plain reply text; the engine splits it into sentence-sized synthesis jobs. */
  readonly text: string
  /** Kokoro voice id; omission uses the voice selected at load time. */
  readonly voice?: string
}

/** One complete, self-contained WAV ready for the renderer's decodeAudioData. */
export interface TtsChunk {
  /** Request identity copied from {@link TtsRequest.id}. */
  readonly id: string
  /** Zero-based sentence position within the request; monotonically increasing. */
  readonly index: number
  /** 24 kHz mono 16-bit PCM WAV with complete RIFF sizes. */
  readonly wav: ArrayBuffer
  /** Exact text synthesized into this chunk. */
  readonly text: string
  /** Playback duration derived from the PCM sample count. */
  readonly durationMs: number
}

/** Host-owned local speech synthesizer with one serial worker. */
export interface TtsEngine {
  /**
   * Load a Kokoro model from an existing local directory and wait for the worker to be ready.
   * @param modelDirectory - Absolute or relative directory containing the ONNX model, tokenizer, and config.
   * @param options - Voice used when a request omits one.
   */
  load(modelDirectory: string, options?: { voice?: string }): Promise<void>

  /**
   * Synthesize one reply in sentence order, emitting each WAV before the next sentence is synthesized.
   * A cancelled request resolves without further chunks instead of rejecting.
   * @param request - Reply text and request identity.
   * @param onChunk - Consumer invoked once per sentence, in order.
   */
  speak(request: TtsRequest, onChunk: (chunk: TtsChunk) => void): Promise<void>

  /** Drop every queued or emitted-pending chunk and stop the worker's current synthesis. */
  cancel(): void

  /** Stop the worker and forget the loaded model. */
  unload(): Promise<void>

  /** Current life cycle state. */
  readonly status: TtsStatus
}

/** Environment and working directory for one spawned worker. */
export interface TtsSpawnOptions {
  /** Complete child environment. */
  readonly env: NodeJS.ProcessEnv
}

/** Minimal child-process handle the engine needs; keeping it narrow makes the process injectable. */
export interface TtsWorkerProcess {
  /** Protocol request stream. */
  readonly stdin: Writable
  /** Protocol response stream; never carries console noise. */
  readonly stdout: Readable
  /** Diagnostic tail retained for typed failures. */
  readonly stderr: Readable
  /** Resolves with the exit code when the child closes; it never rejects. */
  readonly done: Promise<number | null>
  /** Terminate the child immediately. */
  kill(): void
}

/** Launch one worker process. Tests replace it with an in-memory protocol peer. */
export type TtsSpawnFn = (
  command: string,
  args: readonly string[],
  options: TtsSpawnOptions,
) => TtsWorkerProcess

/** Structured failure categories consumers may branch on. */
export type TtsErrorCode =
  | 'input'
  | 'model'
  | 'not-loaded'
  | 'not-ready'
  | 'cancelled'
  | 'queue-full'
  | 'readiness'
  | 'worker'
  | 'synthesis'
  | 'protocol'

/** Typed engine failure with a stable code, never a bare string match. */
export class TtsError extends Error {
  /** Failure category; see {@link TtsErrorCode}. */
  readonly code: TtsErrorCode

  /**
   * Create a typed engine failure.
   * @param code - Stable failure category.
   * @param message - Actionable description, including worker diagnostics where available.
   * @param options - Optional original failure cause.
   */
  constructor(code: TtsErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

/** Worker configuration passed as `argv[2]`. */
export interface TtsWorkerConfig {
  /** Existing model directory, resolved by the Host. */
  readonly modelDirectory: string
  /** Voice used when a request omits one. */
  readonly voice: string
}

/** Worker readiness handshake written once, before any request is accepted. */
export interface TtsReadyMessage {
  /** Discriminant. */
  readonly type: 'ready'
  /** PCM sample rate of every emitted WAV. */
  readonly sampleRate: number
}

/** One synthesis job sent to the worker. */
export interface TtsSynthesizeMessage {
  /** Discriminant. */
  readonly type: 'synthesize'
  /** Request identity. */
  readonly id: string
  /** Sentence position within the request. */
  readonly index: number
  /** Sentence text to synthesize. */
  readonly text: string
  /** Kokoro voice id. */
  readonly voice: string
}

/** One completed sentence returned by the worker. */
export interface TtsChunkMessage {
  /** Discriminant. */
  readonly type: 'chunk'
  /** Request identity. */
  readonly id: string
  /** Sentence position; the Host rejects a mismatch. */
  readonly index: number
  /** Base64-encoded complete WAV. */
  readonly wav: string
  /** Playback duration derived from the PCM sample count. */
  readonly durationMs: number
}

/** One failed synthesis job; the worker stays alive for the next sentence. */
export interface TtsErrorMessage {
  /** Discriminant. */
  readonly type: 'error'
  /** Request identity, absent when the request line itself was malformed. */
  readonly id?: string
  /** Human-readable failure description. */
  readonly message: string
}

/** Any frame the worker writes to stdout. */
export type TtsWorkerMessage = TtsReadyMessage | TtsChunkMessage | TtsErrorMessage
