// @vitest-environment jsdom
/** The surface registry parses the URL selection and maps each id to one component. */
import { act } from '@testing-library/react'
import type { Root } from 'react-dom/client'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  DEFAULT_SURFACE,
  parseSurface,
  SURFACE_IDS,
  SURFACE_PARAMETER,
  SURFACES,
  type SurfaceId,
} from '../src/client/surfaces.ts'

const mounted: Array<{ host: HTMLElement; root: Root }> = []
const originalGetContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // jsdom has no canvas backend; the panel's real orb tolerates a null context.
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: vi.fn(() => null),
  })
})

afterEach(async () => {
  for (const { host, root } of mounted.splice(0)) {
    await act(async () => { root.unmount() })
    host.remove()
  }
  if (originalGetContext !== undefined) {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', originalGetContext)
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function renderSurface(surface: SurfaceId): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const Surface = SURFACES[surface]
  await act(async () => { root.render(<Surface surface={surface} />) })
  mounted.push({ host, root })
  return host
}

it('parses the selected surface and falls back to the panel', () => {
  expect(DEFAULT_SURFACE).toBe('panel')
  expect(parseSurface('')).toBe('panel')
  expect(parseSurface('?surface=panel')).toBe('panel')
  expect(parseSurface(`?${SURFACE_PARAMETER}=settings`)).toBe('settings')
  expect(parseSurface('?surface=history')).toBe('history')
  expect(parseSurface('?surface=unknown')).toBe('panel')
})

it('maps every surface id to a distinct component', () => {
  expect(SURFACE_IDS).toEqual(['panel', 'settings', 'history'])
  const components = SURFACE_IDS.map(id => SURFACES[id])
  for (const component of components) expect(component).toBeTypeOf('function')
  expect(new Set(components).size).toBe(SURFACE_IDS.length)
})

it.each(['settings', 'history'] as const)('renders the %s placeholder naming its surface', async (surface) => {
  const host = await renderSurface(surface)
  const placeholder = host.querySelector('[data-voice-surface-stub]')
  expect(placeholder).not.toBeNull()
  expect(placeholder?.getAttribute('data-voice-surface')).toBe(surface)
  expect(placeholder?.textContent).toContain(surface)
})

it('renders the panel surface instead of a placeholder', async () => {
  const host = await renderSurface('panel')
  expect(host.querySelector('[data-voice-surface-stub]')).toBeNull()
  expect(host.querySelector('[data-voice-surface="panel"]')).not.toBeNull()
  expect(host.querySelector('canvas')).not.toBeNull()
})
