/**
 * Host-owned local Kokoro text-to-speech engine. The engine splits a reply into
 * sentence-sized jobs, drives one private `RunAsNode` worker over a JSON-lines
 * protocol, and emits each finished WAV immediately so playback starts before
 * the reply finishes. Worker stdout carries protocol frames only.
 */
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Readable } from 'node:stream'
import {
  TtsError,
  type TtsSpawnFn,
  type TtsChunk,
  type TtsChunkMessage,
  type TtsEngine,
  type TtsRequest,
  type TtsStatus,
  type TtsSynthesizeMessage,
  type TtsWorkerConfig,
  type TtsWorkerProcess,
  type TtsErrorMessage,
} from './tts-types.ts'

/** Voice used when the request and the load options choose none. */
const DEFAULT_VOICE = 'af_heart'
/** Deadline for the worker to load the model and publish readiness. */
export const TTS_READY_TIMEOUT_MS = 120_000
/** Admitted but unfinished replies; the fifth concurrent call is refused. */
const MAX_PENDING_REQUESTS = 4
/** Idle period before the model worker is stopped; zero keeps it warm. */
const DEFAULT_IDLE_MS = 300_000
/** Maximum sentence bytes sent to one synthesis job. */
const MAX_CHUNK_LENGTH = 240
/** Explanatory stderr retained for typed failures. */
const MAX_STDERR_CHARS = 8 * 1024

/**
 * Words whose trailing period never ends a sentence.
 */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'a.m', 'p.m', 'u.s', 'u.k',
  'fig', 'no', 'cf', 'inc', 'ltd', 'co', 'dept', 'gen', 'gov', 'sen', 'rep', 'capt', 'lt', 'col', 'sgt',
  'mt', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
])

/** Sentence terminators; a run of these is one boundary. */
const TERMINATORS = '.!?\u2026'
/** Closing punctuation that stays with the sentence that precedes it. */
const CLOSERS = '"\u2019\u201d\')]}\u00bb'
/** Clause punctuation preferred over whitespace when a sentence exceeds the cap. */
const CLAUSE_BREAK = /[,;:]\s+/gu
/** Any whitespace run when a sentence exceeds the cap. */
const WORD_BREAK = /\s+/gu

/**
 * Split reply text into sentence-sized synthesis chunks.
 *
 * Boundaries are sentence terminators followed by whitespace, closing quotes, and newlines. Known
 * abbreviations, initials, and dotted initialisms never end a sentence. A sentence longer than the
 * cap is split at the last clause or word boundary before the cap, then hard at the cap.
 * @param text - Plain reply text.
 * @returns Trimmed non-empty chunks in reading order.
 */
export function splitSentences(text: string): string[] {
  const normalized = text.replace(/\r\n?/gu, '\n').trim()
  if (normalized === '') return []
  const chunks: string[] = []
  const push = (piece: string): void => {
    const trimmed = piece.trim()
    if (trimmed === '') return
    chunks.push(...splitLongSentence(trimmed))
  }
  let start = 0
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized.charAt(index)
    if (char === '\n') {
      push(normalized.slice(start, index))
      start = index + 1
      continue
    }
    if (!TERMINATORS.includes(char)) continue
    if (char === '.' && !isTerminalPeriod(normalized, index)) continue
    let end = index
    while (end + 1 < normalized.length && TERMINATORS.includes(normalized.charAt(end + 1))) end++
    while (end + 1 < normalized.length && CLOSERS.includes(normalized.charAt(end + 1))) end++
    const next = end + 1 < normalized.length ? normalized.charAt(end + 1) : undefined
    if (next !== undefined && !/\s/u.test(next)) {
      index = end
      continue
    }
    push(normalized.slice(start, end + 1))
    start = end + 1
    index = end
  }
  if (start < normalized.length) push(normalized.slice(start))
  return chunks
}

/**
 * Decide whether a period inside `text` may end a sentence.
 * @param text - Text containing the period.
 * @param index - Period position.
 * @returns false for a dotted initialism, a known abbreviation, or an initial.
 */
function isTerminalPeriod(text: string, index: number): boolean {
  const next = index + 1 < text.length ? text.charAt(index + 1) : ''
  if (next === '.') return false
  const start = wordStart(text, index)
  const token = text.slice(start, index + 1)
  if (/^(?:[A-Za-z]\.){2,}$/u.test(token)) return false
  if (/^[A-Za-z]\.$/u.test(token)) return false
  return !ABBREVIATIONS.has(token.slice(0, -1).toLowerCase())
}

/**
 * Find the start of the dotted token ending at `index`.
 * @param text - Text containing the token.
 * @param index - Token end (the period position).
 * @returns Index of the token's first character.
 */
function wordStart(text: string, index: number): number {
  let start = index
  while (start > 0 && /[A-Za-z.]/u.test(text.charAt(start - 1))) start--
  return start
}

/**
 * Cap one sentence by splitting at clause, word, then character boundaries.
 * @param sentence - Trimmed sentence text.
 * @returns One or more non-empty chunks, each at most {@link MAX_CHUNK_LENGTH} characters.
 */
function splitLongSentence(sentence: string): string[] {
  if (sentence.length <= MAX_CHUNK_LENGTH) return [sentence]
  const chunks: string[] = []
  let rest = sentence
  while (rest.length > MAX_CHUNK_LENGTH) {
    const cut = bestCut(rest)
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trimStart()
  }
  chunks.push(rest)
  return chunks
}

/**
 * Choose the preferred split position below the chunk cap.
 * @param text - Remaining sentence text.
 * @returns Cut position strictly between zero and the cap.
 */
function bestCut(text: string): number {
  const minimum = Math.floor(MAX_CHUNK_LENGTH / 2)
  for (const pattern of [CLAUSE_BREAK, WORD_BREAK]) {
    pattern.lastIndex = 0
    let cut = 0
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      const end = match.index + match[0].length
      if (end > MAX_CHUNK_LENGTH) break
      if (end >= minimum) cut = end
    }
    if (cut > 0) return cut
  }
  return MAX_CHUNK_LENGTH
}

/**
 * Build worker argv, loading TypeScript source through tsx when the engine runs from source.
 *
 * The built worker is the package's single `./worker` dispatcher; the role
 * argument selects the TTS role module and the configuration JSON stays at
 * `argv[2]` for it.
 * @param entry - Absolute worker file.
 * @param config - Worker configuration.
 * @returns Worker argv without the Node executable.
 */
export function workerArguments(entry: string, config: TtsWorkerConfig): string[] {
  const json = JSON.stringify(config)
  return entry.endsWith('.ts')
    ? ['--import', import.meta.resolve('tsx/esm'), entry, json]
    : [entry, 'tts', json]
}

/**
 * Resolve the worker entry beside the packaged or source engine module.
 * @param moduleUrl - `import.meta.url` of the engine module.
 * @returns the source worker when running from TypeScript, else the built `./worker` dispatcher.
 */
export function resolveWorkerEntry(moduleUrl: string): URL {
  return new URL(moduleUrl.endsWith('.ts') ? './tts-worker.ts' : './worker.js', moduleUrl)
}

/** One admitted reply and its cancellation state. */
interface TtsJob {
  readonly request: TtsRequest
  readonly sentences: readonly string[]
  readonly onChunk: (chunk: TtsChunk) => void
  readonly controller: AbortController
}

/** A worker exit observed while a caller still waits for its process. */
interface WorkerState {
  readonly process: TtsWorkerProcess
  /** True while the engine itself stops the worker, so its exit is not a crash. */
  stopping: boolean
  /** Bounded stderr tail used in typed failures. */
  stderr: string
}

/** Readiness settlement held until the worker publishes its sample rate. */
interface ReadyWaiter {
  readonly worker: WorkerState
  readonly resolve: (sampleRate: number) => void
  readonly reject: (error: TtsError) => void
}

/** In-flight sentence settlement held until the worker answers. */
/** Read cancellation without narrowing the signal across an await boundary. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

interface ChunkWaiter {
  readonly id: string
  readonly index: number
  readonly resolve: (message: TtsChunkMessage | TtsErrorMessage | undefined) => void
  readonly reject: (error: TtsError) => void
}

/**
 * Create the host TTS engine. The worker is spawned lazily, kept warm while jobs arrive, and stopped
 * after `idleMs` without work; a later `speak` respawns it. `cancel` stops the worker to end the
 * current synthesis immediately; the next request reloads the model.
 * @param options - Idle lifetime and the child-process launcher used by tests.
 * @returns Engine bound to this host process.
 */
export function createTtsEngine(options: { idleMs?: number; spawn?: TtsSpawnFn } = {}): TtsEngine {
  return new KokoroTtsEngine(options)
}

/** Mutable engine implementation kept behind the interface seam. */
class KokoroTtsEngine implements TtsEngine {
  /** Current life cycle state. */
  status: TtsStatus = 'unloaded'
  private readonly idleMs: number
  private readonly spawn: TtsSpawnFn
  private model: { directory: string; voice: string } | undefined
  private worker: WorkerState | undefined
  private tail: Promise<void> = Promise.resolve()
  private pending = 0
  private readonly jobs = new Set<TtsJob>()
  private idle: ReturnType<typeof setTimeout> | undefined
  private readyWaiter: ReadyWaiter | undefined
  /** Incremented by unload so a load racing with it cannot revive the worker. */
  private loadEpoch = 0
  private chunkWaiter: ChunkWaiter | undefined

  constructor(options: { idleMs?: number; spawn?: TtsSpawnFn }) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS
    this.spawn = options.spawn ?? spawnWorker
  }

  /**
   * Load a Kokoro model directory and wait for the worker handshake.
   * @param modelDirectory - Directory containing the ONNX model, tokenizer, and config.
   * @param options - Voice used when a request omits one.
   */
  async load(modelDirectory: string, options: { voice?: string } = {}): Promise<void> {
    if (this.status === 'loading') throw new TtsError('not-ready', 'TTS engine is already loading a model')
    this.status = 'loading'
    const epoch = ++this.loadEpoch
    await this.stopWorker()
    this.model = undefined
    if (epoch !== this.loadEpoch) {
      this.status = 'unloaded'
      throw new TtsError('cancelled', 'TTS model load was cancelled')
    }
    const directory = resolve(modelDirectory)
    let info
    try {
      info = await stat(directory)
    } catch (error) {
      this.status = 'error'
      throw new TtsError('model', `TTS model directory does not exist: ${directory}`, { cause: error })
    }
    if (!info.isDirectory()) {
      this.status = 'error'
      throw new TtsError('model', `TTS model path is not a directory: ${directory}`)
    }
    const model = { directory, voice: options.voice ?? DEFAULT_VOICE }
    this.model = model
    this.status = 'loading'
    await this.startWorker(model)
  }

  /**
   * Synthesize one reply in sentence order.
   * @param request - Reply text and request identity.
   * @param onChunk - Consumer invoked once per sentence, in order.
   */
  async speak(request: TtsRequest, onChunk: (chunk: TtsChunk) => void): Promise<void> {
    if (this.status === 'loading') throw new TtsError('not-ready', 'TTS engine is still loading a model')
    const model = this.model
    if (model === undefined) throw new TtsError('not-loaded', 'Load a TTS model before speaking')
    const text = request.text.trim()
    if (text === '') throw new TtsError('input', 'TTS text is empty')
    if (this.pending >= MAX_PENDING_REQUESTS) {
      throw new TtsError('queue-full', `TTS queue is full (${String(MAX_PENDING_REQUESTS)} pending)`)
    }
    const sentences = splitSentences(text)
    const job: TtsJob = {
      request: { ...request, text }, sentences, onChunk, controller: new AbortController(),
    }
    this.jobs.add(job)
    this.pending++
    clearTimeout(this.idle)
    this.idle = undefined
    const run = this.tail.then(() => this.runJob(job, model))
    this.tail = run.then(() => undefined, () => undefined)
    try {
      await run
    } finally {
      this.pending--
      this.jobs.delete(job)
      if (this.pending === 0) this.scheduleIdle()
    }
  }

  /** Drop queued and in-flight chunks and stop the worker when it is synthesizing. */
  cancel(): void {
    if (this.pending === 0) return
    this.stopWorkerNow('unloaded')
    for (const job of this.jobs) job.controller.abort()
    this.jobs.clear()
  }

  /** Stop the worker and forget the loaded model. */
  async unload(): Promise<void> {
    this.loadEpoch++
    this.model = undefined
    for (const job of this.jobs) job.controller.abort()
    this.jobs.clear()
    await this.stopWorker()
    this.status = 'unloaded'
  }

  /**
   * Run one admitted job against the serial worker.
   * @param job - Admitted reply.
   */
  private async runJob(job: TtsJob, model: { directory: string; voice: string }): Promise<void> {
    const signal = job.controller.signal
    if (isAborted(signal)) return
    let worker: TtsWorkerProcess
    try {
      worker = await this.startWorker(model)
    } catch (error) {
      if (isAborted(signal)) return
      throw error
    }
    for (const [index, sentence] of job.sentences.entries()) {
      const message = await this.requestChunk(job, worker, index, sentence, model.voice)
      if (message === undefined || isAborted(signal)) return
      if (message.type === 'error') throw new TtsError('synthesis', message.message)
      const wav = decodeWav(message.wav)
      job.onChunk({
        id: job.request.id,
        index,
        wav,
        text: sentence,
        durationMs: message.durationMs,
      })
    }
  }

  /**
   * Send one sentence and wait for its chunk, error, cancellation, or worker exit.
   * @param job - Owning reply.
   * @param worker - Process that receives the request.
   * @param index - Sentence position.
   * @param sentence - Sentence text.
   * @returns Worker answer, or undefined when cancellation or a stop settled the wait.
   */
  private async requestChunk(
    job: TtsJob,
    worker: TtsWorkerProcess,
    index: number,
    sentence: string,
    defaultVoice: string,
  ): Promise<TtsChunkMessage | TtsErrorMessage | undefined> {
    const signal = job.controller.signal
    const voice = job.request.voice ?? defaultVoice
    const pending = Promise.withResolvers<TtsChunkMessage | TtsErrorMessage | undefined>()
    this.chunkWaiter = {
      id: job.request.id,
      index,
      resolve: pending.resolve,
      reject: pending.reject,
    }
    const abort = (): void => {
      this.chunkWaiter = undefined
      pending.resolve(undefined)
    }
    signal.addEventListener('abort', abort, { once: true })
    const message: TtsSynthesizeMessage = {
      type: 'synthesize', id: job.request.id, index, text: sentence, voice,
    }
    try {
      worker.stdin.write(`${JSON.stringify(message)}\n`)
    } catch (error) {
      signal.removeEventListener('abort', abort)
      this.chunkWaiter = undefined
      throw new TtsError('worker', 'TTS worker request stream is closed', { cause: error })
    }
    try {
      return await pending.promise
    } finally {
      signal.removeEventListener('abort', abort)
      this.chunkWaiter = undefined
    }
  }

  /**
   * Ensure a ready worker exists, spawning and handshaking one when needed.
   * @returns The ready child process.
   */
  private async startWorker(model: { directory: string; voice: string }): Promise<TtsWorkerProcess> {
    if (this.worker !== undefined) return this.worker.process
    this.status = 'loading'
    const entry = fileURLToPath(resolveWorkerEntry(import.meta.url))
    const config: TtsWorkerConfig = { modelDirectory: model.directory, voice: model.voice }
    const args = workerArguments(entry, config)
    const child = this.spawn(process.execPath, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    const worker: WorkerState = { process: child, stopping: false, stderr: '' }
    this.worker = worker
    this.attach(worker)
    try {
      await this.waitReady(worker)
      this.status = 'ready'
      return child
    } catch (error) {
      if (this.worker === worker) {
        this.worker = undefined
        worker.stopping = true
        child.kill()
        this.status = 'error'
      }
      throw error
    }
  }

  /**
   * Attach protocol, diagnostics, and exit handling to one worker.
   * @param worker - Newly spawned worker.
   */
  private attach(worker: WorkerState): void {
    worker.process.stdin.on('error', () => {
      // A closed request stream is reported by the exit handler, not by a process-level throw.
    })
    worker.process.stdout.on('error', (error: Error) => {
      this.fail(worker, new TtsError('worker', 'TTS worker response stream failed', { cause: error }))
    })
    worker.process.stderr.on('data', (chunk: Buffer) => {
      worker.stderr = `${worker.stderr}${chunk.toString('utf8')}`.slice(-MAX_STDERR_CHARS)
    })
    lineReader(worker.process.stdout, (line) => { this.handleLine(worker, line) })
    void worker.process.done.then((code) => { this.handleExit(worker, code) })
  }

  /**
   * Wait for the readiness frame or fail on timeout or early exit.
   * @param worker - Worker performing the handshake.
   * @returns PCM sample rate published by the worker.
   */
  private async waitReady(worker: WorkerState): Promise<number> {
    const pending = Promise.withResolvers<number>()
    const timer = setTimeout(() => {
      pending.reject(new TtsError('readiness', `TTS worker did not become ready within ${String(TTS_READY_TIMEOUT_MS)} ms`))
    }, TTS_READY_TIMEOUT_MS)
    this.readyWaiter = { worker, resolve: pending.resolve, reject: pending.reject }
    try {
      return await pending.promise
    } finally {
      clearTimeout(timer)
      this.clearReadyWaiter(worker)
    }
  }

  /**
   * Release the readiness settlement only when it still belongs to this worker.
   * @param worker - Worker whose handshake finished.
   */
  private clearReadyWaiter(worker: WorkerState): void {
    if (this.readyWaiter !== undefined && this.readyWaiter.worker === worker) this.readyWaiter = undefined
  }

  /**
   * Decode one protocol line from the worker.
   * @param worker - Worker that wrote the line.
   * @param line - Single newline-terminated stdout line.
   */
  private handleLine(worker: WorkerState, line: string): void {
    const value = parseFrame(line)
    if (value === undefined) {
      this.fail(worker, new TtsError('protocol', 'TTS worker wrote an invalid protocol frame'))
      return
    }
    switch (value.type) {
      case 'ready': {
        const waiter = this.readyWaiter
        if (waiter === undefined || waiter.worker !== worker) {
          this.fail(worker, new TtsError('protocol', 'TTS worker published readiness twice'))
          return
        }
        this.readyWaiter = undefined
        waiter.resolve(value.sampleRate)
        return
      }
      case 'chunk': {
        const waiter = this.chunkWaiter
        if (waiter === undefined || waiter.id !== value.id || waiter.index !== value.index) {
          this.fail(worker, new TtsError('protocol', 'TTS worker answered a request it was not given'))
          return
        }
        this.chunkWaiter = undefined
        waiter.resolve(value)
        return
      }
      case 'error': {
        const waiter = this.chunkWaiter
        if (waiter === undefined || (value.id !== undefined && value.id !== waiter.id)) {
          this.fail(worker, new TtsError('protocol', 'TTS worker reported an unrelated failure'))
          return
        }
        this.chunkWaiter = undefined
        waiter.resolve(value)
        return
      }
    }
  }

  /**
   * Handle an unexpected worker exit and surface it to whoever waits.
   * @param worker - Worker whose process closed.
   * @param code - Exit code, null when killed by a signal.
   */
  private handleExit(worker: WorkerState, code: number | null): void {
    if (this.worker === worker) this.worker = undefined
    if (worker.stopping) return
    const detail = worker.stderr.trim()
    const reason = code === null ? 'TTS worker stopped' : `TTS worker exited with code ${String(code)}`
    const error = new TtsError('worker', detail === '' ? reason : `${reason}: ${detail}`)
    const ready = this.readyWaiter
    if (ready !== undefined && ready.worker === worker) {
      this.readyWaiter = undefined
      ready.reject(new TtsError('readiness', detail === '' ? `${reason} before readiness` : `${reason} before readiness: ${detail}`))
    }
    const chunk = this.chunkWaiter
    if (chunk !== undefined) {
      this.chunkWaiter = undefined
      chunk.reject(error)
    }
    this.status = 'error'
  }

  /**
   * Fail the worker because its output violated the protocol.
   * @param worker - Offending worker.
   * @param error - Protocol failure carried to the active caller.
   */
  private fail(worker: WorkerState, error: TtsError): void {
    if (this.worker !== worker) return
    worker.stopping = true
    this.worker = undefined
    this.status = 'error'
    const ready = this.readyWaiter
    if (ready !== undefined && ready.worker === worker) {
      this.readyWaiter = undefined
      ready.reject(error)
    }
    const chunk = this.chunkWaiter
    if (chunk !== undefined) {
      this.chunkWaiter = undefined
      chunk.reject(error)
    }
    worker.process.kill()
  }

  /** Stop the idle worker, if any, and retain the loaded model for respawn. */
  private scheduleIdle(): void {
    clearTimeout(this.idle)
    this.idle = undefined
    if (this.idleMs <= 0 || this.model === undefined || this.worker === undefined) return
    this.idle = setTimeout(() => { this.stopWorkerNow('unloaded') }, this.idleMs)
  }

  /**
   * Stop the worker without awaiting its exit, settling any active wait.
   * @param status - Status to publish immediately.
   */
  private stopWorkerNow(status: TtsStatus): void {
    clearTimeout(this.idle)
    this.idle = undefined
    const worker = this.worker
    if (worker === undefined) {
      this.status = status
      return
    }
    this.worker = undefined
    worker.stopping = true
    this.status = status
    if (this.readyWaiter?.worker === worker) {
      const ready = this.readyWaiter
      this.readyWaiter = undefined
      ready.reject(new TtsError('readiness', 'TTS worker stopped before readiness'))
    }
    if (this.chunkWaiter !== undefined) {
      const chunk = this.chunkWaiter
      this.chunkWaiter = undefined
      chunk.resolve(undefined)
    }
    worker.process.kill()
  }

  /** Stop the worker and wait for its exit. */
  private async stopWorker(): Promise<void> {
    const worker = this.worker
    if (worker === undefined) return
    this.stopWorkerNow('unloaded')
    await worker.process.done
  }
}

/**
 * Read complete newline-terminated lines from a stream.
 * @param stream - Protocol stdout.
 * @param onLine - Consumer for each non-empty line.
 */
function lineReader(stream: Readable, onLine: (line: string) => void): void {
  let buffer = ''
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end < 0) break
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (line.trim() !== '') onLine(line)
    }
  })
}

/**
 * Validate one worker frame at the process boundary.
 * @param line - Raw JSON line.
 * @returns A typed frame, or undefined when the line is malformed.
 */
function parseFrame(line: string): { type: 'ready'; sampleRate: number } | TtsChunkMessage | TtsErrorMessage | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || !('type' in value)) return undefined
  const frame = value as Record<string, unknown>
  switch (frame.type) {
    case 'ready':
      return typeof frame.sampleRate === 'number' ? { type: 'ready', sampleRate: frame.sampleRate } : undefined
    case 'chunk':
      return typeof frame.id === 'string' && typeof frame.index === 'number'
        && typeof frame.wav === 'string' && typeof frame.durationMs === 'number'
        ? { type: 'chunk', id: frame.id, index: frame.index, wav: frame.wav, durationMs: frame.durationMs }
        : undefined
    case 'error':
      return typeof frame.message === 'string' && (frame.id === undefined || typeof frame.id === 'string')
        ? { type: 'error', message: frame.message, ...frame.id === undefined ? {} : { id: frame.id } }
        : undefined
    default:
      return undefined
  }
}

/**
 * Decode a base64 WAV frame into its own ArrayBuffer.
 * @param value - Base64 payload.
 * @returns ArrayBuffer accepted directly by decodeAudioData.
 */
function decodeWav(value: string): ArrayBuffer {
  const bytes = Buffer.from(value, 'base64')
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

/**
 * Default launcher for the private worker.
 * @param command - Node or Electron executable.
 * @param args - Worker argv.
 * @param options - Child environment.
 * @returns Narrow process handle.
 */
export function spawnWorker(command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }): TtsWorkerProcess {
  const child = spawn(command, [...args], {
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.once('error', () => {
    // A launch failure also closes the child; readiness reports the typed failure.
  })
  const done = new Promise<number | null>((resolve) => {
    child.once('close', (code) => { resolve(code) })
  })
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    done,
    kill: () => { child.kill() },
  }
}
