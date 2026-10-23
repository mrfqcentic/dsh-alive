/**
 * Default child factory and worker launch arguments. `node:child_process.spawn`
 * is replaced so the test observes the exact descriptors the packaged app uses
 * without starting a process.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { spawnAsrWorker, workerLaunchArgs, workerModulePath } from '../src/engine/asr.ts'

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdio: Array<NodeJS.ReadableStream | NodeJS.WritableStream | null | undefined> =
    [null, null, null, new PassThrough()]
  readonly kills: Array<NodeJS.Signals | undefined> = []

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal)
    return true
  }
}

it('spawns the worker in Electron Node mode with fd 3 as its protocol channel', () => {
  const child = new FakeChild()
  spawnMock.mockReturnValue(child)
  const environment: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin' }
  const spawned = spawnAsrWorker('/Applications/DeepSeek.app/Contents/MacOS/DeepSeek',
    ['--import', 'tsx/esm', '/pkg/lib/asr-worker.ts'], { cwd: '/repo', env: environment })
  expect(spawnMock).toHaveBeenCalledWith('/Applications/DeepSeek.app/Contents/MacOS/DeepSeek',
    ['--import', 'tsx/esm', '/pkg/lib/asr-worker.ts'],
    { cwd: '/repo', env: environment, stdio: ['pipe', 'ignore', 'pipe', 'pipe'] })
  expect(spawned.stdin).toBe(child.stdin)
  expect(spawned.protocol).toBe(child.stdio[3])
  expect(spawned.stderr).toBe(child.stderr)
})

it('forwards exit and error listeners and delegates kill', () => {
  const child = new FakeChild()
  spawnMock.mockReturnValue(child)
  const spawned = spawnAsrWorker('node', ['worker.js'], { cwd: '/repo', env: {} })
  const exits: Array<[number | null, NodeJS.Signals | null]> = []
  const errors: Error[] = []
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => { exits.push([code, signal]) }
  const onError = (error: Error): void => { errors.push(error) }
  spawned.onExit(onExit)
  spawned.onError(onError)
  child.emit('exit', 3, null)
  child.emit('error', new Error('pipe failed'))
  expect(exits).toEqual([[3, null]])
  expect(errors.map(error => error.message)).toEqual(['pipe failed'])
  spawned.offExit(onExit)
  spawned.offError(onError)
  child.emit('exit', 4, 'SIGTERM')
  expect(exits).toHaveLength(1)
  expect(child.listenerCount('exit')).toBe(0)
  expect(child.listenerCount('error')).toBe(0)
  expect(spawned.kill('SIGKILL')).toBe(true)
  expect(child.kills).toEqual(['SIGKILL'])
})

it('reports no protocol channel when fd 3 is not a pipe', () => {
  const child = new FakeChild()
  child.stdio[3] = undefined
  spawnMock.mockReturnValue(child)
  expect(spawnAsrWorker('node', ['worker.js'], { cwd: '/repo', env: {} }).protocol).toBeNull()
})

it('resolves the worker beside this module in source and built modes', () => {
  const source = pathToFileURL('/repo/packages/interaction/voice-alive/src/engine/asr.ts').href
  const built = pathToFileURL('/repo/packages/interaction/voice-alive/lib/index.js').href
  expect(workerModulePath(source)).toBe('/repo/packages/interaction/voice-alive/src/engine/asr-worker.ts')
  expect(workerModulePath(built)).toBe('/repo/packages/interaction/voice-alive/lib/worker.js')
})

it('adds the tsx loader only for a TypeScript worker', () => {
  expect(workerLaunchArgs('/pkg/src/engine/asr-worker.ts')).toEqual([
    '--import',
    import.meta.resolve('tsx/esm'),
    '/pkg/src/engine/asr-worker.ts',
  ])
  // The built worker is the package's single dispatcher, which selects the ASR
  // module from this role argument.
  expect(workerLaunchArgs('/pkg/lib/worker.js')).toEqual(['/pkg/lib/worker.js', 'asr'])
})
