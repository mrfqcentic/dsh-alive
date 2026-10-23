// @vitest-environment jsdom
/** The voice client mounts only in the panel document and renders the URL-selected surface. */
import { act } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apply, PANEL_DOCUMENT_ATTRIBUTE } from '../src/client/index.ts'

let ctx: Context | undefined

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  document.documentElement.removeAttribute(PANEL_DOCUMENT_ATTRIBUTE)
  document.body.innerHTML = '<div id="root"><div data-dsh-boot=""></div></div>'
  window.history.replaceState(null, '', '/')
})

afterEach(async () => {
  await act(async () => { await ctx?.fiber.dispose() })
  ctx = undefined
  document.body.innerHTML = ''
  document.documentElement.removeAttribute(PANEL_DOCUMENT_ATTRIBUTE)
  window.history.replaceState(null, '', '/')
  vi.unstubAllGlobals()
})

function panelRoot(): HTMLElement {
  const root = document.getElementById('root')
  if (root === null) throw new Error('the fixture has no #root')
  return root
}

function surface(): HTMLElement | null {
  return panelRoot().querySelector('[data-voice-surface]')
}

it('stays inert in a document that is not the voice panel', () => {
  const inert = new Context()
  ctx = inert
  apply(inert)
  expect(panelRoot().querySelector('[data-dsh-boot]')).not.toBeNull()
  expect(surface()).toBeNull()
})

it('renders the panel surface for a document without a surface selection', async () => {
  document.documentElement.setAttribute(PANEL_DOCUMENT_ATTRIBUTE, '')
  const first = new Context()
  ctx = first
  await act(async () => { apply(first) })
  expect(panelRoot().querySelector('[data-dsh-boot]')).toBeNull()
  expect(surface()?.dataset.voiceSurface).toBe('panel')
})

it.each(['settings', 'history'] as const)('renders the %s surface selected by the URL', async (id) => {
  document.documentElement.setAttribute(PANEL_DOCUMENT_ATTRIBUTE, '')
  window.history.replaceState(null, '', `/?surface=${id}`)
  const active = new Context()
  ctx = active
  await act(async () => { apply(active) })
  expect(surface()?.dataset.voiceSurface).toBe(id)
})

it('remounts cleanly after disposal', async () => {
  document.documentElement.setAttribute(PANEL_DOCUMENT_ATTRIBUTE, '')
  const first = new Context()
  ctx = first
  await act(async () => { apply(first) })
  expect(panelRoot().querySelectorAll('[data-voice-surface]')).toHaveLength(1)

  await act(async () => { await first.fiber.dispose() })
  ctx = undefined
  expect(panelRoot().innerHTML).toBe('')

  const remounted = new Context()
  ctx = remounted
  await act(async () => { apply(remounted) })
  expect(panelRoot().querySelectorAll('[data-voice-surface]')).toHaveLength(1)
})

it('refuses a panel document without a mount point', () => {
  document.documentElement.setAttribute(PANEL_DOCUMENT_ATTRIBUTE, '')
  document.body.innerHTML = ''
  const missing = new Context()
  ctx = missing
  expect(() => { apply(missing) }).toThrow(/panel document has no #root/u)
})
