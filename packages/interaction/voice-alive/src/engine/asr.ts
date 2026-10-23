/**
 * Host-side ASR engine: one `RunAsNode` child, one active model, one serial job.
 *
 * The engine validates the model directory before spawning, performs a hello
 * handshake within a fixed readiness budget, then sends `load` and
 * `transcribe` commands over the worker's stdin while responses arrive on the
 * child's dedicated protocol descriptor. It owns the child's lifetime: idle
 * shutdown, crash rejection, typed failures, and no orphaned processes.
 * @module @deepseek-ai/dsh-voice-alive/engine/asr
 */

import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import {
  ASR_PROTOCOL_VERSION,
  type AsrChildProcess,
  type AsrEngine,
  type AsrEngineErrorCode,
  type AsrEngineOptions,
  type AsrModelId,
  type AsrRequest,
  type AsrResult,
  type AsrStatus,
  type AsrWorkerCommand,
  type AsrWorkerResponse,
  type SpawnAsrOptions,
  type SpawnFn,
} from './types.ts'

/** Bytes of worker stderr retained for crash diagnostics. */
const MAX_STDERR_BYTES = 4096

/** Largest accepted protocol line; a longer line means a corrupt channel. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024

const modelSchema = z.enum(['whisper', 'parakeet'])

const failureCodeSchema = z.enum(['model-not-found', 'model-incompatible', 'invalid-input', 'protocol', 'internal'])

const responseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), protocol: z.number().int() }).strict(),
  z.object({ type: z.literal('loaded'), id: z.string(), model: modelSchema }).strict(),
  z.object({
    type: z.literal('result'),
    id: z.string(),
    text: z.string(),
    confidence: z.number().min(0).max(1).optional(),
    durationMs: z.number().nonnegative(),
  }).strict(),
  z.object({ type: z.literal('closed'), id: z.string() }).strict(),
  z.object({ type: z.literal('error'), id: z.string().optional(), code: failureCodeSchema, message: z.string() }).strict(),
])

/** Typed engine failure; `code` is stable for callers and UI mapping. */
export class AsrEngineError extends Error {
  /**
   * @param message - actionable description.
   * @param code - stable failure category.
   * @param options - optional cause.
   */
  constructor(message: string, readonly code: AsrEngineErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AsrEngineError'
  }
}

interface PendingResponse {
  readonly resolve: (frame: AsrWorkerResponse) => void
  readonly reject: (error: unknown) => void
}

interface Child {
  readonly process: AsrChildProcess
  readonly stdin: NodeJS.WritableStream
  readonly protocol: NodeJS.ReadableStream
  readonly stderr: NodeJS.ReadableStream | null
  readonly model: AsrModelId
  readonly modelDirectory: string
  readonly pending: Map<string, PendingResponse>
  readonly exited: Promise<void>
  readonly resolveExit: () => void
  exitedFlag: boolean
  exitDescription: string
  stderrText: string
  protocolBuffer: string
  hello: PendingResponse | undefined
  closed: boolean
}

interface Job {
  readonly request: AsrRequest
  readonly model: AsrModelId
  readonly resolve: (result: AsrResult) => void
  readonly reject: (error: unknown) => void
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleepTimer(milliseconds: number, run: () => void): NodeJS.Timeout {
  const timer = setTimeout(run, milliseconds)
  // A pending protocol budget must never keep an otherwise idle Host alive.
  timer.unref()
  return timer
}

/**
 * Await `work`, rejecting with a typed timeout when it exceeds its budget.
 * @param work - operation to bound.
 * @param milliseconds - budget.
 * @param error - failure factory evaluated only on timeout.
 * @param onTimeout - termination hook run before the rejection settles.
 * @returns the operation result.
 */
async function withTimeout<T>(work: Promise<T>, milliseconds: number, error: () => Error,
  onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = sleepTimer(milliseconds, () => {
      // Settle the typed timeout before the termination hook rejects the same work as a crash.
      reject(error())
      onTimeout()
    })
  })
  try {
    return await Promise.race([work, expired])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Spawn the worker with Electron's Node mode and a dedicated protocol descriptor.
 * @param command - executable, normally `process.execPath`.
 * @param args - worker module and any loader flags.
 * @param options - working directory and environment.
 * @returns the child with `protocol` bound to file descriptor 3.
 */
export function spawnAsrWorker(command: string, args: readonly string[], options: SpawnAsrOptions): AsrChildProcess {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    // fd 3 carries the protocol; stdout is discarded so worker diagnostics can never reach it.
    stdio: ['pipe', 'ignore', 'pipe', 'pipe'],
  })
  const protocol = (child.stdio[3] as Duplex | null | undefined) ?? null
  return {
    stdin: child.stdin,
    protocol,
    stderr: child.stderr,
    kill: signal => child.kill(signal),
    onExit: (listener) => { child.once('exit', listener) },
    offExit: (listener) => { child.off('exit', listener) },
    onError: (listener) => { child.once('error', listener) },
    offError: (listener) => { child.off('error', listener) },
  }
}

/**
 * Resolve the worker module beside this one.
 * @param moduleUrl - this module's `import.meta.url`.
 * @returns absolute source worker, or the built `./worker` dispatcher.
 */
export function workerModulePath(moduleUrl: string): string {
  return fileURLToPath(new URL(moduleUrl.endsWith('.ts') ? './asr-worker.ts' : './worker.js', moduleUrl))
}

/**
 * Build the worker argv for the current execution mode.
 *
 * The built worker is the package's single `./worker` dispatcher, which reads
 * this role argument and then imports the ASR role module; the TypeScript worker
 * is launched directly through tsx.
 * @param workerPath - resolved worker module.
 * @returns arguments passed after the executable.
 */
export function workerLaunchArgs(workerPath: string): string[] {
  return workerPath.endsWith('.ts')
    ? ['--import', import.meta.resolve('tsx/esm'), workerPath]
    : [workerPath, 'asr']
}

/**
 * Validate the model directory before spending a worker spawn on it.
 * @param directory - caller-supplied model directory.
 * @returns the same directory once confirmed.
 * @throws {AsrEngineError} when it is missing, unreadable, or not a directory.
 */
async function validateModelDirectory(directory: string): Promise<string> {
  let info
  try {
    info = await stat(directory)
  } catch (error) {
    const missing = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
    if (missing) {
      throw new AsrEngineError(`ASR model directory does not exist: ${directory}`, 'model-not-found', { cause: error })
    }
    throw new AsrEngineError(`ASR model directory cannot be read: ${directory} (${describe(error)})`,
      'model-incompatible', { cause: error })
  }
  if (!info.isDirectory()) {
    throw new AsrEngineError(`ASR model path is not a directory: ${directory}`, 'model-incompatible')
  }
  return directory
}

function encodePcm(pcm: Int16Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64')
}

class AsrEngineImpl implements AsrEngine {
  private readonly idleMs: number
  private readonly maxQueue: number
  private readonly readinessTimeoutMs: number
  private readonly jobTimeoutMs: number
  private readonly shutdownGraceMs: number
  private readonly spawn: SpawnFn
  private activeModel: AsrModelId | null = null
  private modelDirectory: string | undefined
  private lifecycle: AsrStatus = 'unloaded'
  private child: Child | undefined
  private readonly queue: Job[] = []
  private pumping = false
  private pumpDone: Promise<void> = Promise.resolve()
  private idleTimer: NodeJS.Timeout | undefined
  private stopping: Promise<void> | undefined
  private unloading = false
  private sequence = 0

  constructor(options: AsrEngineOptions = {}) {
    this.idleMs = options.idleMs ?? 60_000
    this.maxQueue = options.maxQueue ?? 4
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 10_000
    this.jobTimeoutMs = options.jobTimeoutMs ?? 120_000
    this.shutdownGraceMs = options.shutdownGraceMs ?? 2_000
    this.spawn = options.spawn ?? spawnAsrWorker
  }

  get model(): AsrModelId | null {
    return this.activeModel
  }

  get status(): AsrStatus {
    return this.lifecycle
  }

  async load(model: AsrModelId, directory: string): Promise<void> {
    if (this.unloading) throw new AsrEngineError('ASR engine is unloading', 'state')
    if (this.lifecycle === 'loading') throw new AsrEngineError('Another ASR model is already loading', 'state')
    if (this.pumping) {
      throw new AsrEngineError('Cannot change the ASR model while transcription is queued', 'state')
    }
    let validated: string
    try {
      validated = await validateModelDirectory(directory)
    } catch (error) {
      // A rejected switch never leaves the previous model pretending to satisfy the new request.
      const child = this.child
      if (child !== undefined) await this.stopChild(child, new AsrEngineError('ASR model changed', 'state'))
      this.activeModel = null
      this.modelDirectory = undefined
      this.lifecycle = 'error'
      throw error
    }
    if (this.lifecycle === 'ready' && this.activeModel === model && this.modelDirectory === validated) return
    this.clearIdle()
    this.lifecycle = 'loading'
    const child = this.child
    if (child !== undefined) await this.stopChild(child, new AsrEngineError('ASR model changed', 'state'))
    this.activeModel = model
    this.modelDirectory = validated
    try {
      this.child = await this.startChild()
      this.lifecycle = 'ready'
    } catch (error) {
      this.activeModel = null
      this.modelDirectory = undefined
      this.lifecycle = 'error'
      throw error
    }
  }

  async transcribe(request: AsrRequest): Promise<AsrResult> {
    if (this.unloading) throw new AsrEngineError('ASR engine is unloading', 'state')
    if (this.lifecycle !== 'ready') {
      throw new AsrEngineError('Load an ASR model before transcribing', 'state')
    }
    const model = this.activeModel
    /* v8 ignore next 3 -- load() sets the model before status becomes ready */
    if (model === null) {
      throw new AsrEngineError('Load an ASR model before transcribing', 'state')
    }
    if (this.queue.length >= this.maxQueue) {
      throw new AsrEngineError(`ASR transcription queue is full (maxQueue=${this.maxQueue})`, 'queue-full')
    }
    this.clearIdle()
    const job = Promise.withResolvers<AsrResult>()
    this.queue.push({ request, model, resolve: job.resolve, reject: job.reject })
    this.pump()
    return job.promise
  }

  async unload(): Promise<void> {
    if (this.unloading) return
    if (this.lifecycle === 'loading') {
      throw new AsrEngineError('Cannot unload while an ASR model is loading', 'state')
    }
    this.unloading = true
    try {
      this.clearIdle()
      for (const job of this.queue.splice(0)) job.reject(new AsrEngineError('ASR engine is unloading', 'state'))
      const stopping = this.stopping
      if (stopping !== undefined) await stopping
      const child = this.child
      if (child !== undefined) await this.stopChild(child, new AsrEngineError('ASR engine unloaded', 'state'))
      await this.pumpDone
      this.activeModel = null
      this.modelDirectory = undefined
      this.lifecycle = 'unloaded'
    } finally {
      this.unloading = false
    }
  }

  private pump(): void {
    if (this.pumping) return
    this.pumping = true
    const done = Promise.withResolvers<void>()
    this.pumpDone = done.promise
    void (async () => {
      try {
        while (this.queue.length > 0) {
          const job = this.dequeue()
          try {
            job.resolve(await this.runJob(job))
          } catch (error) {
            job.reject(error)
          }
        }
      } finally {
        this.pumping = false
        done.resolve()
        this.scheduleIdle()
      }
    })()
  }

  /** @returns the oldest queued job; the pump loop guarantees one exists. */
  private dequeue(): Job {
    const job = this.queue.shift()
    /* v8 ignore next 3 -- callers enter this with a non-empty queue */
    if (job === undefined) {
      throw new AsrEngineError('ASR queue invariant violated', 'internal')
    }
    return job
  }

  private async runJob(job: Job): Promise<AsrResult> {
    const child = await this.ensureChild()
    const request = job.request
    const command: AsrWorkerCommand = {
      type: 'transcribe',
      id: request.id,
      sampleRate: request.sampleRate,
      ...request.language === undefined ? {} : { language: request.language },
      pcm: encodePcm(request.pcm),
    }
    const response = await this.command(child, command)
    if (response.type !== 'result') {
      throw new AsrEngineError('ASR worker acknowledged a transcription without a result', 'protocol')
    }
    return {
      id: request.id,
      text: response.text,
      ...response.confidence === undefined ? {} : { confidence: response.confidence },
      durationMs: response.durationMs,
      model: job.model,
    }
  }

  private async ensureChild(): Promise<Child> {
    const stopping = this.stopping
    if (stopping !== undefined) await stopping
    const child = this.child
    if (child !== undefined) return child
    return this.startChild()
  }

  private async startChild(): Promise<Child> {
    const model = this.activeModel
    const directory = this.modelDirectory
    /* v8 ignore next 4 -- load() sets both fields before the engine becomes ready */
    if (model === null || directory === undefined) {
      throw new AsrEngineError('Load an ASR model before starting the ASR worker', 'state')
    }
    const worker = workerModulePath(import.meta.url)
    let spawned: AsrChildProcess
    try {
      spawned = this.spawn(process.execPath, workerLaunchArgs(worker), {
        cwd: process.cwd(),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
    } catch (error) {
      throw new AsrEngineError(`ASR worker could not start: ${describe(error)}`, 'crashed', { cause: error })
    }
    const stdin = spawned.stdin
    const protocol = spawned.protocol
    if (stdin === null || protocol === null) {
      spawned.kill('SIGKILL')
      throw new AsrEngineError('ASR worker did not expose its command and protocol channels', 'protocol')
    }
    const exit = Promise.withResolvers<void>()
    const state: Child = {
      process: spawned,
      stdin,
      protocol,
      stderr: spawned.stderr,
      model,
      modelDirectory: directory,
      pending: new Map(),
      exited: exit.promise,
      resolveExit: exit.resolve,
      exitedFlag: false,
      exitDescription: '',
      stderrText: '',
      protocolBuffer: '',
      hello: undefined,
      closed: false,
    }
    this.child = state
    this.attach(state)
    try {
      await this.awaitHello(state)
      const response = await this.command(state, {
        type: 'load',
        id: `load-${++this.sequence}`,
        model,
        modelDirectory: directory,
      })
      if (response.type !== 'loaded') {
        throw new AsrEngineError('ASR worker acknowledged an unexpected command', 'protocol')
      }
      return state
    } catch (error) {
      /* v8 ignore next 2 -- awaitHello and command reject only with an AsrEngineError */
      const failure = error instanceof AsrEngineError ? error
        : new AsrEngineError(describe(error), 'internal', { cause: error })
      await this.stopChild(state, failure)
      if (this.lifecycle === 'ready') this.lifecycle = 'error'
      throw failure
    }
  }

  private attach(state: Child): void {
    state.protocol.on('data', (chunk: string | Buffer) => { this.receive(state, String(chunk)) })
    state.protocol.on('error', () => {
      // The exit handler reports the failure; this listener keeps the pipe error from becoming uncaught.
    })
    state.stderr?.on('data', (chunk: string | Buffer) => {
      state.stderrText = `${state.stderrText}${String(chunk)}`.slice(0, MAX_STDERR_BYTES)
    })
    state.stdin.on('error', () => {
      // The exit handler reports the failure; write failures are raised at the command site.
    })
    state.process.onExit((code, signal) => { this.settleExit(state, code, signal) })
    state.process.onError((error) => {
      state.exitDescription = `failed to start (${error.message})`
      this.settleExit(state, null, null)
    })
  }

  private receive(state: Child, chunk: string): void {
    if (state.closed) return
    state.protocolBuffer += chunk
    if (state.protocolBuffer.length > MAX_FRAME_BYTES) {
      this.failProtocol(state, 'ASR worker response frame exceeded its byte limit')
      return
    }
    for (let end = state.protocolBuffer.indexOf('\n'); end >= 0; end = state.protocolBuffer.indexOf('\n')) {
      const line = state.protocolBuffer.slice(0, end)
      state.protocolBuffer = state.protocolBuffer.slice(end + 1)
      if (line.trim() === '') continue
      if (this.handleFrame(state, line)) return
    }
  }

  /** @returns whether the frame failed the protocol and closed the child. */
  private handleFrame(state: Child, line: string): boolean {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      this.failProtocol(state, 'ASR worker sent a response frame that is not JSON')
      return true
    }
    const parsed = responseSchema.safeParse(raw)
    if (!parsed.success) {
      this.failProtocol(state, 'ASR worker sent an invalid response frame')
      return true
    }
    const frame = parsed.data
    if (frame.type === 'hello') {
      if (frame.protocol !== ASR_PROTOCOL_VERSION) {
        this.failProtocol(state, `ASR worker speaks protocol ${String(frame.protocol)}, expected ${String(ASR_PROTOCOL_VERSION)}`)
        return true
      }
      const hello = state.hello
      state.hello = undefined
      if (hello === undefined) {
        this.failProtocol(state, 'ASR worker repeated its readiness frame')
        return true
      }
      hello.resolve(frame)
      return false
    }
    const id = frame.id
    if (id === undefined) {
      this.failProtocol(state, 'ASR worker sent a failure without a request id')
      return true
    }
    const pending = state.pending.get(id)
    if (pending === undefined) {
      this.failProtocol(state, `ASR worker answered an unknown request id: ${id}`)
      return true
    }
    state.pending.delete(id)
    if (frame.type === 'error') {
      pending.reject(new AsrEngineError(frame.message, frame.code))
      return false
    }
    if (frame.type === 'result') {
      pending.resolve(frame.confidence === undefined
        ? { type: 'result', id, text: frame.text, durationMs: frame.durationMs }
        : { type: 'result', id, text: frame.text, confidence: frame.confidence, durationMs: frame.durationMs })
      return false
    }
    pending.resolve(frame)
    return false
  }

  private failProtocol(state: Child, message: string): void {
    state.closed = true
    // The protocol listener belongs to the current child; a replaced child is closed before its stream ends.
    this.child = undefined
    const failure = new AsrEngineError(message, 'protocol')
    this.rejectPending(state, failure)
    this.lifecycle = 'error'
    state.process.kill('SIGKILL')
  }

  private rejectPending(state: Child, failure: Error): void {
    const pending = [...state.pending.values()]
    state.pending.clear()
    for (const entry of pending) entry.reject(failure)
    const hello = state.hello
    state.hello = undefined
    hello?.reject(failure)
  }

  private settleExit(state: Child, code: number | null, signal: NodeJS.Signals | null): void {
    if (state.exitedFlag) return
    state.exitedFlag = true
    if (state.exitDescription === '') {
      state.exitDescription = signal === null ? `exited with code ${String(code ?? 'null')}` : `was terminated by ${signal}`
    }
    state.resolveExit()
    if (this.child === state) this.child = undefined
    const detail = state.stderrText.trim()
    const failure = new AsrEngineError(
      detail === '' ? `ASR worker ${state.exitDescription}` : `ASR worker ${state.exitDescription}: ${detail}`,
      'crashed',
    )
    this.rejectPending(state, failure)
  }

  private async awaitHello(state: Child): Promise<void> {
    const hello = Promise.withResolvers<AsrWorkerResponse>()
    state.hello = { resolve: hello.resolve, reject: hello.reject }
    await withTimeout(hello.promise, this.readinessTimeoutMs,
      () => new AsrEngineError(`ASR worker did not report readiness within ${String(this.readinessTimeoutMs)} ms`, 'timeout'),
      () => { /* the start failure path stops the child */ })
  }

  private command(state: Child, command: AsrWorkerCommand): Promise<AsrWorkerResponse> {
    const pending = Promise.withResolvers<AsrWorkerResponse>()
    state.pending.set(command.id, { resolve: pending.resolve, reject: pending.reject })
    try {
      state.stdin.write(`${JSON.stringify(command)}\n`)
    } catch (error) {
      state.pending.delete(command.id)
      return Promise.reject(new AsrEngineError(`ASR worker command channel failed: ${describe(error)}`, 'crashed', {
        cause: error,
      }))
    }
    return withTimeout(pending.promise, this.jobTimeoutMs,
      () => new AsrEngineError(
        `ASR worker did not answer ${command.type} request ${command.id} within ${String(this.jobTimeoutMs)} ms`,
        'timeout',
      ),
      () => {
        this.child = undefined
        state.process.kill('SIGKILL')
      }).finally(() => { state.pending.delete(command.id) })
  }

  private async stopChild(state: Child, reason: AsrEngineError): Promise<void> {
    state.closed = true
    if (this.child === state) this.child = undefined
    this.rejectPending(state, reason)
    if (state.exitedFlag) return
    try {
      state.stdin.write(`${JSON.stringify({ type: 'shutdown', id: `shutdown-${++this.sequence}` })}\n`)
      state.stdin.end()
    } catch {
      // A closed command channel means the child is already going away; the kill below reaps it.
    }
    const timer = sleepTimer(this.shutdownGraceMs, () => { state.process.kill('SIGKILL') })
    try {
      await state.exited
    } finally {
      clearTimeout(timer)
    }
  }

  private clearIdle(): void {
    if (this.idleTimer === undefined) return
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private scheduleIdle(): void {
    this.clearIdle()
    if (this.idleMs <= 0 || this.unloading || this.lifecycle !== 'ready' || this.child === undefined) return
    this.idleTimer = sleepTimer(this.idleMs, () => {
      this.idleTimer = undefined
      const child = this.child
      if (child === undefined) return
      this.stopping = this.stopChild(child, new AsrEngineError('ASR engine stopped its idle worker', 'state'))
        .finally(() => { this.stopping = undefined })
    })
  }
}

/**
 * Create one serial local ASR engine.
 * @param options - idle budget, queue depth, timeouts, and the child factory.
 * @returns an engine that starts unloaded.
 */
export function createAsrEngine(options?: AsrEngineOptions): AsrEngine {
  return new AsrEngineImpl(options)
}
