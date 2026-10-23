/**
 * Monochrome voice orb canvas.
 *
 * One canvas, one animation loop. The loop paints the approved pearl body from
 * `orbMath`, follows the `level` prop when supplied, falls back to the idle
 * curve of the current state, and pauses when the canvas leaves the viewport
 * or the document becomes hidden. The clock, the loop, and every listener are
 * released on unmount.
 * @module @deepseek-ai/dsh-voice-alive/client/orb/Orb
 */
import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import {
  accentFrom,
  advanceTime,
  canvasSize,
  drawOrb,
  idleLevel,
  motionProfile,
  normalizeLevel,
  ORB_MOTION,
  smoothLevel,
  type Orb2DContext,
  type OrbFrame,
  type OrbState,
} from './orbMath.ts'

export type { OrbState } from './orbMath.ts'

/** Props accepted by the orb canvas. */
export interface OrbProps {
  /** Product state that selects the motion family and palette. */
  readonly state: OrbState
  /** Instantaneous loudness in 0..1; absent means the state idles on its own curve. */
  readonly level?: number
}

/** Media query that asks for calmer motion. */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/**
 * Render the voice orb.
 * @param props - the current state and optional instantaneous loudness.
 * @returns a decorative canvas sized by its container.
 */
export function Orb({ state, level }: OrbProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef(state)
  const levelRef = useRef(level)

  useEffect(() => {
    stateRef.current = state
    levelRef.current = level
  })

  useEffect(() => {
    const canvas = canvasRef.current
    // React attaches refs before passive effects run.
    /* v8 ignore next -- React attaches the ref before passive effects run. */
    if (canvas === null) return
    const context = canvas.getContext('2d')
    if (context === null) return
    const ctx: Orb2DContext = context
    const profile = motionProfile(window.matchMedia(REDUCED_MOTION_QUERY).matches)
    const accent = accentFrom(window.getComputedStyle(canvas))

    let cssWidth = 1
    let cssHeight = 1
    let time = 0
    let smoothed = 0
    let lastFrame = 0
    let frame: number | null = null
    let intersecting = true

    const paint = (deltaSeconds: number): void => {
      const currentState = stateRef.current
      time = advanceTime(time, deltaSeconds, currentState, profile)
      const external = levelRef.current
      const target = currentState === 'muted'
        ? 0
        : external === undefined ? idleLevel(currentState, time, profile) : normalizeLevel(external)
      smoothed = smoothLevel(smoothed, target, deltaSeconds)
      const orbFrame: OrbFrame = {
        state: currentState,
        time,
        level: smoothed,
        width: cssWidth,
        height: cssHeight,
        accent,
        profile,
      }
      drawOrb(ctx, orbFrame)
    }

    const resize = (): void => {
      const bounds = canvas.getBoundingClientRect()
      const size = canvasSize(bounds.width, bounds.height, window.devicePixelRatio || 1)
      cssWidth = size.width
      cssHeight = size.height
      canvas.width = Math.round(cssWidth * size.ratio)
      canvas.height = Math.round(cssHeight * size.ratio)
      ctx.setTransform(size.ratio, 0, 0, size.ratio, 0, 0)
    }

    const step = (now: number): void => {
      frame = null
      const delta = Math.max(0, Math.min(0.05, (now - lastFrame) / 1000))
      lastFrame = now
      paint(delta)
      frame = requestAnimationFrame(step)
    }

    const start = (): void => {
      lastFrame = performance.now()
      frame = requestAnimationFrame(step)
    }

    const stop = (): void => {
      if (frame === null) return
      cancelAnimationFrame(frame)
      frame = null
    }

    const sync = (): void => {
      const runnable = intersecting && document.visibilityState !== 'hidden'
      if (runnable && frame === null) start()
      else if (!runnable && frame !== null) stop()
    }

    const observer = new IntersectionObserver((entries) => {
      intersecting = entries.some(entry => entry.isIntersecting)
      sync()
    })
    observer.observe(canvas)
    document.addEventListener('visibilitychange', sync)
    window.addEventListener('resize', resize)
    resize()
    sync()

    return () => {
      stop()
      observer.disconnect()
      document.removeEventListener('visibilitychange', sync)
      window.removeEventListener('resize', resize)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, cssWidth, cssHeight)
      canvas.width = 0
      canvas.height = 0
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-orb-state={state}
      data-orb-motion={ORB_MOTION[state]}
      style={{ display: 'block', width: '100%', height: '100%' }}
    />
  )
}
