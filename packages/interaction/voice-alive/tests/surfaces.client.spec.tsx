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

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })

afterEach(async () => {
  for (const { host, root } of mounted.splice(0)) {
    await act(async () => { root.unmount() })
    host.remove()
  }
  vi.unstubAllGlobals()
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

it('renders the panel placeholder naming its surface', async () => {
  const host = await renderSurface('panel')
  const placeholder = host.querySelector('[data-voice-surface-stub]')
  expect(placeholder).not.toBeNull()
  expect(placeholder?.getAttribute('data-voice-surface')).toBe('panel')
  expect(placeholder?.textContent).toContain('panel')
})

it('renders the settings surface instead of a placeholder', async () => {
  const host = await renderSurface('settings')
  expect(host.querySelector('[data-voice-surface="settings"]')).not.toBeNull()
  expect(host.querySelector('[data-voice-surface-stub]')).toBeNull()
})

it('renders the history window for the history surface', async () => {
  const host = await renderSurface('history')
  expect(host.querySelector('[data-voice-surface="history"]')).not.toBeNull()
  expect(host.querySelector('[data-voice-surface-stub]')).toBeNull()
  expect(host.querySelector('.voice-history-window')).not.toBeNull()
})
