// @vitest-environment jsdom
/** The orb canvas owns one loop, pauses off-screen, and releases everything on unmount. */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Orb } from '../src/client/orb/Orb.tsx'
import { ORB_MOTION, ORB_STATES } from '../src/client/orb/orbMath.ts'
import { RecordingContext } from './orb-context.client.ts'

const originalGetContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')

let context: RecordingContext
let getContext: ReturnType<typeof vi.fn>
let requestFrame: ReturnType<typeof vi.fn>
let cancelFrame: ReturnType<typeof vi.fn>
let matchMedia: ReturnType<typeof vi.fn>
let pending: Map<number, FrameRequestCallback>
let nextFrameId: number
let reducedMotion: boolean
let visibility: 'hidden' | 'visible'
let canvasRect: { width: number; height: number }

class ObserverStub {
  static instances: ObserverStub[] = []
  readonly observed: Element[] = []
  disconnected = false

  constructor(readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
    ObserverStub.instances.push(this)
  }

  observe(element: Element): void { this.observed.push(element) }
  unobserve(element: Element): void { this.observed.splice(this.observed.indexOf(element), 1) }
  disconnect(): void { this.disconnected = true; this.observed.length = 0 }
  takeRecords(): [] { return [] }

  emits(isIntersecting: boolean): void { this.callback([{ isIntersecting }]) }
}

function stubContext(value: RecordingContext | null): void {
  getContext = vi.fn(() => value)
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: getContext })
}

function rectangle(width: number, height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    toJSON: () => ({ x: 0, y: 0, width, height, top: 0, left: 0, right: width, bottom: height }),
  }
}

function canvasOf(container: HTMLElement): HTMLCanvasElement {
  const canvas = container.querySelector('canvas')
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('the orb did not render a canvas')
  return canvas
}

function pendingFrame(): FrameRequestCallback {
  const entry = pending.entries().next().value
  if (entry === undefined) throw new Error('no animation frame was scheduled')
  const [frame, callback] = entry
  pending.delete(frame)
  return callback
}

function runFrame(time: number): void {
  const callback = pendingFrame()
  act(() => { callback(time) })
}

beforeEach(() => {
  context = new RecordingContext()
  pending = new Map()
  nextFrameId = 0
  reducedMotion = false
  visibility = 'visible'
  canvasRect = { width: 132, height: 132 }
  ObserverStub.instances = []

  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  stubContext(context)
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  matchMedia = vi.fn((query: string) => ({ matches: reducedMotion, media: query }))
  vi.stubGlobal('matchMedia', matchMedia)
  vi.stubGlobal('IntersectionObserver', ObserverStub)
  requestFrame = vi.fn((callback: FrameRequestCallback) => {
    nextFrameId += 1
    pending.set(nextFrameId, callback)
    return nextFrameId
  })
  cancelFrame = vi.fn((frame: number) => { pending.delete(frame) })
  vi.stubGlobal('requestAnimationFrame', requestFrame)
  vi.stubGlobal('cancelAnimationFrame', cancelFrame)
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect')
    .mockImplementation(() => rectangle(canvasRect.width, canvasRect.height))
})

afterEach(() => {
  cleanup()
  if (originalGetContext !== undefined) {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', originalGetContext)
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('state table', () => {
  it.each(ORB_STATES)('renders the %s state with its motion family', (state) => {
    const view = render(<Orb state={state} />)
    const canvas = canvasOf(view.container)
    expect(canvas.dataset.orbState).toBe(state)
    expect(canvas.dataset.orbMotion).toBe(ORB_MOTION[state])
    expect(canvas.getAttribute('aria-hidden')).toBe('true')
    expect(getContext).toHaveBeenCalledWith('2d')
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
    expect(pending.size).toBe(1)
    runFrame(16)
    expect(context.clearRects).toHaveLength(1)
    expect(pending.size).toBe(1)
  })
})

describe('sizing', () => {
  it('scales the backing store by the device pixel ratio and redraws on resize', () => {
    canvasRect = { width: 120, height: 90 }
    const view = render(<Orb state="listening" />)
    const canvas = canvasOf(view.container)
    expect(canvas.width).toBe(240)
    expect(canvas.height).toBe(180)
    expect(context.transforms[0]).toEqual([2, 0, 0, 2, 0, 0])

    canvasRect = { width: 200, height: 100 }
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(canvas.width).toBe(400)
    expect(canvas.height).toBe(200)
    expect(context.transforms.at(-1)).toEqual([2, 0, 0, 2, 0, 0])
  })

  it('treats a missing device pixel ratio as one', () => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 0 })
    const view = render(<Orb state="listening" />)
    expect(canvasOf(view.container).width).toBe(132)
  })
})

describe('animation', () => {
  it('follows an external level and keeps the loop running', () => {
    const view = render(<Orb state="speaking" level={0.3} />)
    runFrame(performance.now() + 16)
    view.rerender(<Orb state="speaking" level={1.4} />)
    runFrame(performance.now() + 32)
    expect(context.clearRects).toHaveLength(2)
    expect(pending.size).toBe(1)
  })

  it('calms but keeps animating for reduced motion', () => {
    reducedMotion = true
    const view = render(<Orb state="speaking" />)
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
    runFrame(16)
    expect(context.clearRects).toHaveLength(1)
    expect(canvasOf(view.container).dataset.orbMotion).toBe('reactive')
  })

  it('stays idle when the canvas has no 2D context', () => {
    stubContext(null)
    const view = render(<Orb state="listening" />)
    expect(requestFrame).not.toHaveBeenCalled()
    expect(() => { view.unmount() }).not.toThrow()
  })
})

describe('visibility', () => {
  it('pauses off-screen and when the document hides, then resumes', () => {
    const view = render(<Orb state="listening" />)
    const observer = ObserverStub.instances[0] as ObserverStub
    expect(observer.observed).toContain(canvasOf(view.container))
    const firstFrame = nextFrameId

    act(() => { observer.emits(false) })
    expect(cancelFrame).toHaveBeenCalledWith(firstFrame)
    expect(pending.size).toBe(0)

    act(() => { observer.emits(false) })
    expect(cancelFrame).toHaveBeenCalledTimes(1)

    act(() => { observer.emits(true) })
    expect(pending.size).toBe(1)
    act(() => { observer.emits(true) })
    expect(pending.size).toBe(1)

    visibility = 'hidden'
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(cancelFrame).toHaveBeenCalledTimes(2)
    expect(pending.size).toBe(0)

    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(cancelFrame).toHaveBeenCalledTimes(2)

    visibility = 'visible'
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(pending.size).toBe(1)
  })
})

describe('cleanup', () => {
  it('releases the frame, observer, listeners, and bitmap on unmount', () => {
    const view = render(<Orb state="thinking" />)
    const canvas = canvasOf(view.container)
    const observer = ObserverStub.instances[0] as ObserverStub
    const lastFrame = nextFrameId
    const scheduled = requestFrame.mock.calls.length

    view.unmount()

    expect(cancelFrame).toHaveBeenCalledWith(lastFrame)
    expect(observer.disconnected).toBe(true)
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)

    act(() => {
      window.dispatchEvent(new Event('resize'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(requestFrame.mock.calls.length).toBe(scheduled)
  })

  it('unmounts safely after the loop was already stopped', () => {
    const view = render(<Orb state="listening" />)
    const observer = ObserverStub.instances[0] as ObserverStub
    act(() => { observer.emits(false) })
    expect(() => { view.unmount() }).not.toThrow()
    expect(observer.disconnected).toBe(true)
  })
})

describe('accent', () => {
  it('reads the accent token for the thinking ring and falls back when absent', () => {
    render(<Orb state="thinking" />)
    runFrame(16)
    expect(context.strokeStyles).toContain('rgba(245, 245, 245, 0.55)')

    cleanup()
    context = new RecordingContext()
    stubContext(context)
    vi.stubGlobal('getComputedStyle', vi.fn(() => ({
      getPropertyValue: (name: string) => name === '--accent' ? '#eeeeee' : '',
    })))
    render(<Orb state="thinking" />)
    runFrame(32)
    expect(context.strokeStyles).toContain('rgba(238, 238, 238, 0.55)')
  })
})
