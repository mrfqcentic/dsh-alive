// @vitest-environment jsdom
/** The settings surface wires five tabs, keyboard selection, and session-scoped restoration. */
import { cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SETTINGS_TAB_STORAGE_KEY } from '../src/client/settings/active-tab.ts'
import { copy } from '../src/client/settings/locales.ts'
import { SETTINGS_TABS, type SettingsTabId } from '../src/client/settings/tabs.ts'
import { SettingsSurface } from '../src/client/surfaces/settings.tsx'

function tab(id: SettingsTabId): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('tab', { name: copy.tabs[id] })
}

function visiblePanel(): HTMLElement {
  return screen.getByRole('tabpanel')
}

function expectSelected(id: SettingsTabId): void {
  expect(tab(id).getAttribute('aria-selected')).toBe('true')
  expect(tab(id).tabIndex).toBe(0)
  for (const other of SETTINGS_TABS) {
    if (other.id === id) continue
    expect(tab(other.id).getAttribute('aria-selected')).toBe('false')
    expect(tab(other.id).tabIndex).toBe(-1)
  }
  expect(visiblePanel().id).toBe(`voice-settings-panel-${id}`)
}

beforeEach(() => { window.sessionStorage.clear() })

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.sessionStorage.clear()
})

it('renders the frame, five tabs, and one panel per tab', () => {
  render(<SettingsSurface surface="settings" />)

  expect(screen.getByRole('heading', { name: copy.title })).toBeTruthy()
  expect(screen.getByText(copy.eyebrow)).toBeTruthy()
  expect(screen.getByText(copy.badge)).toBeTruthy()
  expect(screen.getByText(copy.subtitle)).toBeTruthy()
  expect(screen.getByRole('region', { name: copy.window })).toBeTruthy()

  const tablist = screen.getByRole('tablist', { name: copy.tabsLabel })
  expect(within(tablist).getAllByRole('tab').map(element => element.textContent)).toEqual(SETTINGS_TABS.map(entry => entry.label))
  expect(document.querySelectorAll('[role="tabpanel"]')).toHaveLength(SETTINGS_TABS.length)
  expectSelected('models')
})

it('wires every tab to its panel and switches both on click', () => {
  render(<SettingsSurface surface="settings" />)

  for (const entry of SETTINGS_TABS) {
    const button = tab(entry.id)
    const panel = document.getElementById(`voice-settings-panel-${entry.id}`)
    expect(button.getAttribute('aria-controls')).toBe(panel?.id)
    expect(panel?.getAttribute('aria-labelledby')).toBe(button.id)
    expect(button.id).toBe(`voice-settings-tab-${entry.id}`)
  }

  for (const entry of SETTINGS_TABS) {
    fireEvent.click(tab(entry.id))
    expectSelected(entry.id)
    expect(visiblePanel().textContent).toContain(copy[entry.id].description)
    expect(window.sessionStorage.getItem(SETTINGS_TAB_STORAGE_KEY)).toBe(entry.id)
  }
})

it('moves selection and focus with arrow keys, Home, and End', () => {
  render(<SettingsSurface surface="settings" />)

  tab('models').focus()
  fireEvent.keyDown(tab('models'), { key: 'ArrowRight' })
  expectSelected('workspaces')
  expect(document.activeElement).toBe(tab('workspaces'))

  fireEvent.keyDown(tab('workspaces'), { key: 'ArrowLeft' })
  expectSelected('models')
  expect(document.activeElement).toBe(tab('models'))

  fireEvent.keyDown(tab('models'), { key: 'ArrowLeft' })
  expectSelected('privacy')
  expect(document.activeElement).toBe(tab('privacy'))

  fireEvent.keyDown(tab('privacy'), { key: 'ArrowRight' })
  expectSelected('models')

  fireEvent.keyDown(tab('models'), { key: 'End' })
  expectSelected('privacy')
  expect(document.activeElement).toBe(tab('privacy'))

  fireEvent.keyDown(tab('privacy'), { key: 'Home' })
  expectSelected('models')
  expect(document.activeElement).toBe(tab('models'))
})

it('leaves Escape and unrelated keys unclaimed for the shell', () => {
  render(<SettingsSurface surface="settings" />)

  const escape = createEvent.keyDown(tab('models'), { key: 'Escape' })
  fireEvent(tab('models'), escape)
  expect(escape.defaultPrevented).toBe(false)
  expectSelected('models')

  const unrelated = createEvent.keyDown(tab('models'), { key: 'ArrowUp' })
  fireEvent(tab('models'), unrelated)
  expect(unrelated.defaultPrevented).toBe(false)
  expectSelected('models')
})

it('restores the selected tab after a remount in the same session', () => {
  const first = render(<SettingsSurface surface="settings" />)
  fireEvent.click(tab('audio'))
  expect(window.sessionStorage.getItem(SETTINGS_TAB_STORAGE_KEY)).toBe('audio')

  first.unmount()
  render(<SettingsSurface surface="settings" />)
  expectSelected('audio')
})

it('restores a stored tab and ignores an unknown stored value', () => {
  window.sessionStorage.setItem(SETTINGS_TAB_STORAGE_KEY, 'privacy')
  render(<SettingsSurface surface="settings" />)
  expectSelected('privacy')

  cleanup()
  window.sessionStorage.setItem(SETTINGS_TAB_STORAGE_KEY, 'retired-section')
  render(<SettingsSurface surface="settings" />)
  expectSelected('models')
})

it('keeps the surface usable when session storage is unavailable', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage blocked') })
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage blocked') })

  render(<SettingsSurface surface="settings" />)
  expectSelected('models')

  fireEvent.click(tab('workspaces'))
  expectSelected('workspaces')
  expect(setItem).toHaveBeenCalledOnce()
})
