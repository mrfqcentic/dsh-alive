/** Orb math: palette, motion profiles, contour geometry, sizing, and paint calls. */
import { describe, expect, it } from 'vitest'
import {
  accentFrom,
  advanceTime,
  CALM_MOTION,
  canvasSize,
  contourPoints,
  drawOrb,
  FULL_MOTION,
  idleLevel,
  motionProfile,
  normalizeLevel,
  ORB_CONTOUR_POINTS,
  ORB_MOTION,
  ORB_STATES,
  paletteFor,
  smoothLevel,
  traceContour,
  type OrbFrame,
  type OrbState,
} from '../src/client/orb/orbMath.ts'
import { RecordingContext } from './orb-context.client.ts'

function frame(state: OrbState, overrides: Partial<OrbFrame> = {}): OrbFrame {
  return {
    state,
    time: 0,
    level: 0.5,
    width: 340,
    height: 340,
    accent: '#f5f5f5',
    profile: FULL_MOTION,
    ...overrides,
  }
}

function radiusOf(point: readonly [number, number], width = 340, height = 340): number {
  return Math.hypot(point[0] - width / 2, point[1] - height / 2)
}

describe('state table', () => {
  it('maps each of the five states to one distinct motion family', () => {
    expect(ORB_STATES).toEqual(['muted', 'listening', 'thinking', 'speaking', 'error'])
    expect(ORB_STATES.map(state => ORB_MOTION[state])).toEqual(['still', 'breathe', 'orbit', 'reactive', 'pulse'])
    expect(new Set(ORB_STATES.map(state => ORB_MOTION[state])).size).toBe(5)
  })
})

describe('palette', () => {
  it('uses only monochrome tones and the approved muted ramp', () => {
    const muted = paletteFor('muted')
    expect(muted).toEqual({
      light: 'rgb(171, 171, 171)',
      mid: '#5a5a5a',
      deep: '#2a2a2a',
      deeper: '#101010',
      glow: 'rgba(255, 255, 255, 0.08)',
      rim: 'rgba(255, 255, 255, 0.10)',
    })
    for (const state of ORB_STATES) {
      const ramp = paletteFor(state)
      for (const color of [ramp.light, ramp.mid, ramp.deep, ramp.deeper, ramp.glow, ramp.rim]) {
        // #rrggbb and rgb()/rgba() both carry three equal channels in monochrome.
        const values = color.startsWith('#')
          ? [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16))
          : color.match(/\d+/gu)?.slice(0, 3).map(Number) ?? []
        expect(values).toHaveLength(3)
        expect(values[0]).toBe(values[1])
        expect(values[1]).toBe(values[2])
      }
    }
  })

  it('keeps error brighter and thinking one step darker than listening', () => {
    expect(paletteFor('error').mid).toBe('#e8e8e8')
    expect(paletteFor('error').rim).toBe('rgba(255, 255, 255, 0.4)')
    expect(paletteFor('thinking').mid).toBe('#bdbdbd')
    expect(paletteFor('thinking').deep).toBe('rgb(65, 65, 65)')
    expect(paletteFor('listening').mid).toBe('#cfcfcf')
    expect(paletteFor('listening').deep).toBe('rgb(70, 70, 70)')
    expect(paletteFor('speaking').mid).toBe('#cfcfcf')
  })
})

describe('motion profile', () => {
  it('calms every amplitude and speed for reduced motion', () => {
    expect(motionProfile(false)).toBe(FULL_MOTION)
    expect(motionProfile(true)).toBe(CALM_MOTION)
    expect(CALM_MOTION.wobble).toBeLessThan(FULL_MOTION.wobble)
    expect(CALM_MOTION.timeScale).toBeLessThan(FULL_MOTION.timeScale)
    expect(CALM_MOTION.pulse).toBeLessThan(FULL_MOTION.pulse)
    expect(CALM_MOTION.ringSpeed).toBeLessThan(FULL_MOTION.ringSpeed)
  })
})

describe('loudness', () => {
  it('holds muted at zero and keeps every idle curve inside its band', () => {
    expect(idleLevel('muted', 123, FULL_MOTION)).toBe(0)
    for (const time of [0, 0.3, 1.7, 4.2]) {
      expect(idleLevel('listening', time, FULL_MOTION)).toBeGreaterThanOrEqual(0.07)
      expect(idleLevel('listening', time, FULL_MOTION)).toBeLessThanOrEqual(0.13)
      expect(idleLevel('thinking', time, FULL_MOTION)).toBeGreaterThanOrEqual(0.13)
      expect(idleLevel('thinking', time, FULL_MOTION)).toBeLessThanOrEqual(0.19)
      expect(idleLevel('speaking', time, FULL_MOTION)).toBeGreaterThan(0.1)
      expect(idleLevel('speaking', time, FULL_MOTION)).toBeLessThan(0.8)
      expect(idleLevel('error', time, FULL_MOTION)).toBeGreaterThanOrEqual(0.05)
      expect(idleLevel('error', time, FULL_MOTION)).toBeLessThanOrEqual(0.09)
    }
  })

  it('shrinks the idle oscillation under the calm profile', () => {
    const listeningTime = Math.PI / (2 * 1.6)
    const fullListening = idleLevel('listening', listeningTime, FULL_MOTION) - 0.1
    const calmListening = idleLevel('listening', listeningTime, CALM_MOTION) - 0.1
    expect(calmListening).toBeLessThan(fullListening)

    const speakingTime = Math.PI / 18
    const fullSpeaking = idleLevel('speaking', speakingTime, FULL_MOTION) - 0.42
    const calmSpeaking = idleLevel('speaking', speakingTime, CALM_MOTION) - 0.42
    expect(calmSpeaking).toBeLessThan(fullSpeaking)

    const errorTime = Math.PI / 2.2
    expect(idleLevel('error', errorTime, CALM_MOTION) - 0.07)
      .toBeLessThan(idleLevel('error', errorTime, FULL_MOTION) - 0.07)
  })

  it('clamps external levels to 0..1', () => {
    expect(normalizeLevel(-0.5)).toBe(0)
    expect(normalizeLevel(0.25)).toBe(0.25)
    expect(normalizeLevel(2)).toBe(1)
  })

  it('eases toward the target at the approved rate and never overshoots', () => {
    expect(smoothLevel(0, 1, 0.016)).toBeCloseTo(0.144, 6)
    expect(smoothLevel(0, 1, 10)).toBe(1)
    expect(smoothLevel(0.2, 1, -1)).toBe(0.2)
    expect(smoothLevel(0.9, 0, 0.001)).toBeLessThan(0.9)
  })

  it('freezes the clock only while muted', () => {
    expect(advanceTime(4, 0.5, 'muted', FULL_MOTION)).toBe(4)
    expect(advanceTime(4, 0.5, 'listening', FULL_MOTION)).toBe(4.5)
    expect(advanceTime(4, 0.5, 'listening', CALM_MOTION)).toBeCloseTo(4.225, 6)
  })
})

describe('canvas sizing', () => {
  it('clamps the device pixel ratio to 1..2 and rounds CSS dimensions', () => {
    expect(canvasSize(100, 80, 2)).toEqual({ width: 100, height: 80, ratio: 2 })
    expect(canvasSize(10.6, 9.5, 1.5)).toEqual({ width: 11, height: 10, ratio: 1.5 })
    expect(canvasSize(100, 80, 3).ratio).toBe(2)
    expect(canvasSize(100, 80, 0.5).ratio).toBe(1)
    expect(canvasSize(100, 80, 0).ratio).toBe(1)
    expect(canvasSize(100, 80, Number.NaN).ratio).toBe(1)
    expect(canvasSize(0.4, 0.49, 1)).toEqual({ width: 1, height: 1, ratio: 1 })
  })

  it('reads the accent token and falls back to the neutral white', () => {
    expect(accentFrom({ getPropertyValue: () => ' #fafafa ' })).toBe('#fafafa')
    expect(accentFrom({ getPropertyValue: () => '   ' })).toBe('#f5f5f5')
    expect(accentFrom({ getPropertyValue: () => '' })).toBe('#f5f5f5')
  })
})

describe('contour', () => {
  it('samples the full ring around the centre', () => {
    const points = contourPoints(frame('listening'))
    expect(points).toHaveLength(ORB_CONTOUR_POINTS)
    const meanX = points.reduce((sum, point) => sum + point[0], 0) / points.length
    const meanY = points.reduce((sum, point) => sum + point[1], 0) / points.length
    expect(meanX).toBeCloseTo(170, 0)
    expect(meanY).toBeCloseTo(170, 0)
  })

  it('ignores the level while muted and freezes the shape for a fixed clock', () => {
    const quiet = contourPoints(frame('muted', { level: 0 }))
    const loud = contourPoints(frame('muted', { level: 1 }))
    expect(loud).toEqual(quiet)
  })

  it('deforms further as the level rises', () => {
    const quiet = contourPoints(frame('listening', { level: 0 }))
    const loud = contourPoints(frame('listening', { level: 1 }))
    const growth = radiusOf(loud[0] as readonly [number, number]) - radiusOf(quiet[0] as readonly [number, number])
    expect(growth).toBeGreaterThan(0)
  })

  it('uses a smaller base radius for compact canvases', () => {
    const compact = contourPoints(frame('muted', { width: 100, height: 100 }))
    const regular = contourPoints(frame('muted', { width: 340, height: 340 }))
    expect(radiusOf(compact[0] as readonly [number, number], 100, 100))
      .toBeLessThan(radiusOf(regular[0] as readonly [number, number]))
  })

  it('quiets the wobble under the calm profile', () => {
    const spread = (profile: typeof FULL_MOTION): number => Math.max(
      ...contourPoints(frame('listening', { level: 0, time: 1, profile }))
        .map(point => Math.abs(radiusOf(point) - 170)),
    )
    expect(spread(CALM_MOTION)).toBeLessThan(spread(FULL_MOTION))
    expect(contourPoints(frame('listening', { level: 0, time: 1, profile: CALM_MOTION })))
      .not.toEqual(contourPoints(frame('listening', { level: 0, time: 1 })))
  })
})

describe('traceContour', () => {
  it('emits one cubic segment per sample and closes the path', () => {
    const ctx = new RecordingContext()
    const points = contourPoints(frame('listening'))
    traceContour(ctx, points)
    expect(ctx.moveToCalls).toEqual([points[0]])
    expect(ctx.bezierCalls).toHaveLength(ORB_CONTOUR_POINTS)
    expect(ctx.bezierCalls[ORB_CONTOUR_POINTS - 1]?.slice(4)).toEqual(points[0])
  })

  it('starts and stops for an empty ring', () => {
    const ctx = new RecordingContext()
    traceContour(ctx, [])
    expect(ctx.moveToCalls).toHaveLength(0)
    expect(ctx.bezierCalls).toHaveLength(0)
  })
})

describe('drawOrb', () => {
  it('paints every state with the body, highlight, shade, and rim', () => {
    for (const state of ORB_STATES) {
      const ctx = new RecordingContext()
      drawOrb(ctx, frame(state))
      expect(ctx.clearRects).toEqual([[0, 0, 340, 340]])
      expect(ctx.fills).toBeGreaterThanOrEqual(state === 'muted' ? 2 : 3)
      expect(ctx.strokes).toBeGreaterThanOrEqual(1)
      expect(ctx.clips).toBe(1)
      expect(ctx.fillRects).toBeGreaterThanOrEqual(3)
      expect(ctx.gradients[0]?.stops).toEqual([
        { offset: 0, color: paletteFor(state).light },
        { offset: 0.16, color: '#ececec' },
        { offset: 0.46, color: paletteFor(state).mid },
        { offset: 0.76, color: paletteFor(state).deep },
        { offset: 1, color: paletteFor(state).deeper },
      ])
      expect(ctx.strokeStyles.at(-1)).toBe(paletteFor(state).rim)
    }
  })

  it('draws the orbit ring only while thinking', () => {
    const thinking = new RecordingContext()
    drawOrb(thinking, frame('thinking', { time: 2, accent: '#eeeeee' }))
    expect(thinking.lineDashes).toEqual([[2, 12]])
    expect(thinking.rotations).toHaveLength(1)
    expect(thinking.strokeStyles).toContain('rgba(238, 238, 238, 0.55)')

    for (const state of ['muted', 'listening', 'speaking', 'error'] as const) {
      const ctx = new RecordingContext()
      drawOrb(ctx, frame(state))
      expect(ctx.lineDashes).toHaveLength(0)
      expect(ctx.rotations).toHaveLength(0)
    }
  })

  it('skips the halo for muted and scales the halo on larger canvases', () => {
    const muted = new RecordingContext()
    drawOrb(muted, frame('muted', { width: 100, height: 100 }))
    expect(muted.shadowBlur).toBe(0)

    const compact = new RecordingContext()
    drawOrb(compact, frame('listening', { width: 100, height: 100, level: 0.5 }))
    expect(compact.shadowBlur).toBe(8)

    const large = new RecordingContext()
    drawOrb(large, frame('listening', { width: 340, height: 340, level: 0.5 }))
    expect(large.shadowBlur).toBeCloseTo(26, 6)
    expect(large.shadowColor).toBe('rgba(255, 255, 255, 0.12)')
    expect(large.saves).toBeGreaterThan(muted.saves)
  })
})
