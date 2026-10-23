// @vitest-environment jsdom
/** The voice client mounts only in the panel document and releases its root with the plugin. */
import { act } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apply, PANEL_DOCUMENT_ATTRIBUTE } from '../src/client/index.ts'
import { PanelPlaceholder } from '../src/client/PanelPlaceholder.tsx'

let ctx: Context | undefined

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  document.documentElement.removeAttribute(PANEL_DOCUMENT_ATTRIBUTE)
  document.body.innerHTML = '<div id="root"><div data-dsh-boot=""></div></div>'
})

afterEach(async () => {
  await act(async () => { await ctx?.fiber.dispose() })
  ctx = undefined
  document.body.innerHTML = ''
  document.documentElement.removeAttribute(PANEL_DOCUMENT_ATTRIBUTE)
  vi.unstubAllGlobals()
})

function panelRoot(): HTMLElement {
  const root = document.getElementById('root')
  if (root === null) throw new Error('the fixture has no #root')
  return root
}

it('stays inert in a document that is not the voice panel', () => {
  const inert = new Context()
  ctx = inert
  apply(inert)
  expect(panelRoot().querySelector('[data-dsh-boot]')).not.toBeNull()
  expect(panelRoot().querySelector('[data-voice-panel-placeholder]')).toBeNull()
})

it('replaces the boot page with the panel root and remounts cleanly after disposal', async () => {
  document.documentElement.setAttribute(PANEL_DOCUMENT_ATTRIBUTE, '')
  const first = new Context()
  ctx = first
  await act(async () => { apply(first) })
  expect(panelRoot().querySelector('[data-dsh-boot]')).toBeNull()
  expect(panelRoot().querySelector('[data-voice-panel-placeholder]')).not.toBeNull()

  await act(async () => { await first.fiber.dispose() })
  ctx = undefined
  expect(panelRoot().innerHTML).toBe('')

  const remounted = new Context()
  ctx = remounted
  await act(async () => { apply(remounted) })
  expect(panelRoot().querySelectorAll('[data-voice-panel-placeholder]')).toHaveLength(1)
})

it('refuses a panel document without a mount point', () => {
  document.documentElement.setAttribute(PANEL_DOCUMENT_ATTRIBUTE, '')
  document.body.innerHTML = ''
  const missing = new Context()
  ctx = missing
  expect(() => { apply(missing) }).toThrow(/panel document has no #root/u)
})

it('renders the placeholder mark as the panel root', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => { root.render(<PanelPlaceholder />) })
  const mark = host.querySelector('[data-voice-panel-placeholder]')
  expect(mark).not.toBeNull()
  expect(mark?.childElementCount).toBe(1)
  await act(async () => { root.unmount() })
})
