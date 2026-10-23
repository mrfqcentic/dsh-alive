/**
 * ASR engine contract shared by the Host engine, its worker process, and tests.
 *
 * The engine owns one model at a time. Audio is 16-bit PCM at 16 kHz; the
 * worker protocol carries it as base64 so a frame stays a single JSON line.
 * @module @deepseek-ai/dsh-voice-alive/engine/types
 */

/** Protocol version exchanged by the engine and its worker; both sides reject other versions. */
export const ASR_PROTOCOL_VERSION = 1

/** Recognizer families the engine can load. The active one is explicit; the engine never substitutes another. */
export type AsrModelId = 'whisper' | 'parakeet'

/** One complete utterance to recognize. */
export interface AsrRequest {
  /** Caller-owned correlation id echoed in the result. */
  readonly id: string
  /** 16 kHz mono 16-bit PCM, borrowed until the returned promise settles. */
  readonly pcm: Int16Array
  /** Sampling rate of `pcm`; the capture path always produces 16000. */
  readonly sampleRate: 16000
  /** Explicit language hint; omitted lets the model decide for itself. */
  readonly language?: string
}

/** One recognized utterance. */
export interface AsrResult {
  /** Correlation id copied from the request. */
  readonly id: string
  /** Recognized text, empty when the model heard no words. */
  readonly text: string
  /** Mean token probability in [0, 1] when the backend reports it. */
  readonly confidence?: number
  /** Worker inference wall time in milliseconds, excluding IPC and queue wait. */
  readonly durationMs: number
  /** Model that produced this result. */
  readonly model: AsrModelId
}

/** Engine lifecycle; `ready` keeps the configured model across child restarts and idle shutdowns. */
export type AsrStatus = 'unloaded' | 'loading' | 'ready' | 'error'

/** Failure codes the worker may report. */
export type AsrWorkerFailureCode = 'model-not-found' | 'model-incompatible' | 'invalid-input' | 'protocol' | 'internal'

/** Failure codes surfaced by the engine, including failures that never reach a worker. */
export type AsrEngineErrorCode = AsrWorkerFailureCode | 'timeout' | 'crashed' | 'queue-full' | 'state'

/** A child process exposing the separated command, protocol, and diagnostic channels. */
export interface AsrChildProcess {
  /** JSON-line commands written to the worker's standard input. */
  readonly stdin: NodeJS.WritableStream | null
  /** JSON-line responses read from the worker's dedicated protocol descriptor (fd 3). */
  readonly protocol: NodeJS.ReadableStream | null
  /** Worker diagnostics; never part of the protocol. */
  readonly stderr: NodeJS.ReadableStream | null
  /** @param signal - termination signal. @returns whether the signal was delivered. */
  kill(signal?: NodeJS.Signals): boolean
  /** @param listener - called once when the child terminates. */
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  /** @param listener - the exit listener to remove. */
  offExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  /** @param listener - called once when the child fails to start or its pipes fail. */
  onError(listener: (error: Error) => void): void
  /** @param listener - the error listener to remove. */
  offError(listener: (error: Error) => void): void
}

/** Environment and working directory for one worker spawn. */
export interface SpawnAsrOptions {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

/** Child factory; tests inject a fake that speaks the protocol without a real process. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnAsrOptions) => AsrChildProcess

/** Engine construction options. */
export interface AsrEngineOptions {
  /** Milliseconds without queued work before the child is stopped; `0` keeps it warm. Default 60000. */
  readonly idleMs?: number
  /** Jobs allowed to wait behind the active one; further requests reject instead of growing the queue. Default 4. */
  readonly maxQueue?: number
  /** Maximum wait for the worker's hello frame. Default 10000. */
  readonly readinessTimeoutMs?: number
  /** Maximum wait for one load or transcription reply. Default 120000. */
  readonly jobTimeoutMs?: number
  /** Milliseconds between a graceful shutdown request and SIGKILL. Default 2000. */
  readonly shutdownGraceMs?: number
  /** Child factory override; the default spawns the adjacent worker with `ELECTRON_RUN_AS_NODE=1`. */
  readonly spawn?: SpawnFn
}

/**
 * One serial local recognizer.
 *
 * `load` replaces the active model; `transcribe` queues work behind the
 * single in-flight job; `unload` stops the child and releases the model.
 */
export interface AsrEngine {
  /** Configured model, or null before a successful load and after unload. */
  readonly model: AsrModelId | null
  readonly status: AsrStatus
  /**
   * Load exactly one model from a local directory; missing or incompatible weights reject.
   * @param model - recognizer family to load.
   * @param modelDirectory - directory holding the ONNX weights and tokens.
   */
  load(model: AsrModelId, modelDirectory: string): Promise<void>
  /**
   * Queue one utterance; only one transcribes at a time.
   * @param request - PCM, rate, correlation id, and optional language hint.
   * @returns the recognized text and timing.
   */
  transcribe(request: AsrRequest): Promise<AsrResult>
  /** Stop the child and clear the model; queued and in-flight work rejects. */
  unload(): Promise<void>
}

/** One command frame written to the worker. */
export type AsrWorkerCommand =
  | { readonly type: 'load'; readonly id: string; readonly model: AsrModelId; readonly modelDirectory: string }
  | {
    readonly type: 'transcribe'
    readonly id: string
    readonly sampleRate: number
    readonly language?: string
    /** Base64 of little-endian 16-bit PCM. */
    readonly pcm: string
  }
  | { readonly type: 'shutdown'; readonly id: string }

/** One response frame read from the worker's protocol descriptor. */
export type AsrWorkerResponse =
  | { readonly type: 'hello'; readonly protocol: number }
  | { readonly type: 'loaded'; readonly id: string; readonly model: AsrModelId }
  | {
    readonly type: 'result'
    readonly id: string
    readonly text: string
    readonly confidence?: number
    readonly durationMs: number
  }
  | { readonly type: 'closed'; readonly id: string }
  | { readonly type: 'error'; readonly id?: string; readonly code: AsrWorkerFailureCode; readonly message: string }

/** Input accepted by one worker backend. */
export interface AsrBackendInput {
  readonly pcm: Int16Array
  readonly sampleRate: number
  readonly language?: string
}

/** Backend output before the worker adds timing. */
export interface AsrBackendResult {
  readonly text: string
  readonly confidence?: number
}

/** Native recognizer confined to the worker process. */
export interface AsrBackend {
  /**
   * Recognize one complete utterance.
   * @param input - PCM samples, rate, and optional language hint.
   * @returns recognized text and optional confidence.
   */
  transcribe(input: AsrBackendInput): Promise<AsrBackendResult>
  /** Release native resources; called before another load and on process shutdown. */
  close(): Promise<void>
}

/**
 * Load one backend for the requested model.
 * @param model - recognizer family.
 * @param modelDirectory - directory holding the weights.
 * @returns a backend bound to those weights.
 */
export type AsrBackendLoader = (model: AsrModelId, modelDirectory: string) => Promise<AsrBackend>
