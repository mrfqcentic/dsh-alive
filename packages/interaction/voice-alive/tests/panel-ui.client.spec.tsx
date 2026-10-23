// @vitest-environment jsdom
/**
 * Panel surface: orb state, mute paths, icon actions, drag regions, focus,
 * and the no-prose rule. The orb is stubbed; one test renders the real one.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  PANEL_PROTOCOL_VERSION,
  type VoicePanelBridgeApi,
} from '../src/client/panel/bridge.ts'
import { copy } from '../src/client/panel/locales.ts'
import { PANEL_STATES, panelState } from '../src/client/panel/state.ts'
import { PanelSurface } from '../src/client/surfaces/panel.tsx'
import css from '../src/client/panel/panel.module.css'

vi.mock('../src/client/orb/Orb.tsx', async () => {
  const { createElement } = await import('react')
  return {
    Orb: ({ state }: { readonly state: string }) => createElement('canvas', { 'data-orb-state': state }),
  }
})

interface FakeBridge {
  readonly openSurface: ReturnType<typeof vi.fn>
  readonly offToggle: ReturnType<typeof vi.fn>
  readonly offVisibility: ReturnType<typeof vi.fn>
  readonly fireToggle: () => void
}

function installBridge(): FakeBridge {
  let toggle: (() => void) | undefined
  const openSurface = vi.fn(async () => {})
  const offToggle = vi.fn()
  const offVisibility = vi.fn()
  const api: VoicePanelBridgeApi = {
    protocolVersion: PANEL_PROTOCOL_VERSION,
    state: async () => ({ visible: true, shortcutRegistered: true }),
    subscribe: () => offVisibility,
    openSurface,
    close: async () => {},
    onToggleMute(listener) {
      toggle = listener
      return offToggle
    },
  }
  window.dshVoicePanel = api
  return {
    openSurface,
    offToggle,
    offVisibility,
    fireToggle: () => { toggle?.() },
  }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  panelState.set('muted')
  delete window.dshVoicePanel
})

afterEach(() => {
  cleanup()
  delete window.dshVoicePanel
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function root(view: ReturnType<typeof render>): HTMLElement {
  const section = view.container.querySelector('section')
  if (!(section instanceof HTMLElement)) throw new Error('the panel did not render a section')
  return section
}

function orb(view: ReturnType<typeof render>): HTMLCanvasElement {
  const canvas = view.container.querySelector('canvas')
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('the panel did not render the orb stage')
  return canvas
}

it('renders only the orb and icon controls, with no visible prose', () => {
  const view = render(<PanelSurface surface="panel" />)
  const panel = root(view)
  expect(panel.dataset.voiceSurface).toBe('panel')
  expect(panel.dataset.muted).toBe('true')
  expect(panel.getAttribute('aria-label')).toBe(copy.panel)
  expect(orb(view).dataset.orbState).toBe('muted')
  expect(panel.textContent?.trim()).toBe('')
  expect(view.getAllByRole('button')).toHaveLength(3)
})

it.each(PANEL_STATES)('maps the %s panel state onto the orb', (state) => {
  const view = render(<PanelSurface surface="panel" />)
  act(() => { panelState.set(state) })
  expect(root(view).dataset.state).toBe(state)
  expect(root(view).dataset.muted).toBe(String(state === 'muted'))
  expect(orb(view).dataset.orbState).toBe(state)
})

it('toggles mute by clicking the orb', () => {
  const view = render(<PanelSurface surface="panel" />)
  const stage = view.getByRole('button', { name: copy.unmute })
  expect(stage.getAttribute('aria-pressed')).toBe('true')

  fireEvent.click(stage)
  expect(panelState.get()).toBe('listening')
  expect(stage.getAttribute('aria-pressed')).toBe('false')
  expect(stage.getAttribute('aria-label')).toBe(copy.mute)
  expect(root(view).dataset.muted).toBe('false')

  fireEvent.click(stage)
  expect(panelState.get()).toBe('muted')
  expect(stage.getAttribute('aria-pressed')).toBe('true')
})

it('toggles mute when the shell fires the chord while the panel is visible', () => {
  const bridge = installBridge()
  const view = render(<PanelSurface surface="panel" />)
  act(() => { bridge.fireToggle() })
  expect(panelState.get()).toBe('listening')
  act(() => { bridge.fireToggle() })
  expect(panelState.get()).toBe('muted')

  view.unmount()
  expect(bridge.offToggle).toHaveBeenCalledTimes(1)
})

it('opens settings and history through the shell bridge', () => {
  const bridge = installBridge()
  const view = render(<PanelSurface surface="panel" />)

  fireEvent.click(view.getByRole('button', { name: copy.settings }))
  fireEvent.click(view.getByRole('button', { name: copy.history }))
  expect(bridge.openSurface.mock.calls).toEqual([['settings'], ['history']])
})

it('makes the panel the drag region and every control no-drag', () => {
  const view = render(<PanelSurface surface="panel" />)
  expect(root(view).className).toContain(css.surface)
  expect(view.getByRole('button', { name: copy.settings }).className).toContain(css.noDrag)
  expect(view.getByRole('button', { name: copy.history }).className).toContain(css.noDrag)
  expect(view.getByRole('button', { name: copy.unmute }).className).toContain(css.noDrag)

  const source = readFileSync(
    resolve(process.cwd(), 'packages/interaction/voice-alive/src/client/panel/panel.module.css'),
    'utf8',
  )
  expect(source).toMatch(/\.surface\s*\{[\s\S]*?-webkit-app-region:\s*drag/)
  expect(source).toMatch(/\.noDrag\s*\{\s*-webkit-app-region:\s*no-drag;\s*\}/)
  expect(source).toContain('--stage-size: 132px')
  expect(source).toMatch(/:global\(html\[data-dsh-voice-panel\]\)[\s\S]*?background: transparent/)
  expect(source).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.surface \{ animation: none; \}/)
})

it('focuses the panel on open and leaves both icons in the tab order', () => {
  const view = render(<PanelSurface surface="panel" />)
  const panel = root(view)
  expect(document.activeElement).toBe(panel)

  const buttons = [...panel.querySelectorAll('button')]
  expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual([
    copy.settings,
    copy.history,
    copy.unmute,
  ])
  for (const button of buttons) expect(button.tabIndex).toBe(0)
})
