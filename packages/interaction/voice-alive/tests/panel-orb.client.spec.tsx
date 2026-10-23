// @vitest-environment jsdom
/** The panel surface renders the real orb canvas, not only the stub. */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { panelState } from '../src/client/panel/state.ts'
import { PanelSurface } from '../src/client/surfaces/panel.tsx'

const originalGetContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // The surface starts its audio machine on mount; booting muted keeps the
  // microphone out of this visual test.
  panelState.set('muted')
  // jsdom has no canvas backend; the real orb tolerates a null context.
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: vi.fn(() => null),
  })
})

afterEach(() => {
  cleanup()
  if (originalGetContext !== undefined) {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', originalGetContext)
  }
  panelState.set('muted')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('renders the real orb and follows the store', () => {
  const view = render(<PanelSurface surface="panel" />)
  const canvas = view.container.querySelector('canvas')
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('the panel rendered no orb canvas')
  expect(canvas.dataset.orbState).toBe('muted')
  expect(canvas.getAttribute('aria-hidden')).toBe('true')

  act(() => { panelState.set('thinking') })
  expect(canvas.dataset.orbState).toBe('thinking')

  act(() => { panelState.set('speaking') })
  expect(canvas.dataset.orbState).toBe('speaking')
})
