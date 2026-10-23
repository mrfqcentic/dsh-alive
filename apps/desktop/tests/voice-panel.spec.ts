/** The voice panel document resolves inside the packaged runtime and falls back to the checkout. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { on: vi.fn(), off: vi.fn(), focus: vi.fn() },
  BrowserWindow: vi.fn(),
  globalShortcut: { register: vi.fn(), unregister: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  screen: { on: vi.fn(), off: vi.fn() },
}))

import { resolveVoicePanelRoot, serveVoicePanelDocument } from '../src/voice-panel.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'desktop-voice-panel-'))
  roots.push(root)
  return root
}

it('serves the panel document from the package the runtime closure installs', async () => {
  const project = temporaryRoot()
  const packaged = join(project, 'node_modules', '@deepseek-ai', 'dsh-voice-alive', 'dist', 'panel')
  mkdirSync(packaged, { recursive: true })
  writeFileSync(join(packaged, 'panel.html'), '<!doctype html><title>voice panel</title>')

  const root = resolveVoicePanelRoot(project, '/checkout-fallback')
  expect(root).toBe(packaged)
  const response = await serveVoicePanelDocument(new Request('dsh-app://shell/voice/panel.html'), root)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
  expect(await response.text()).toContain('voice panel')
})

it('falls back to the checkout layout when the packaged directory is absent', () => {
  const project = temporaryRoot()
  expect(resolveVoicePanelRoot(project, '/checkout-fallback')).toBe('/checkout-fallback')
})

it('reports a missing panel asset without leaving the served directory', async () => {
  const project = temporaryRoot()
  mkdirSync(join(project, 'node_modules'), { recursive: true })
  expect((await serveVoicePanelDocument(new Request('dsh-app://shell/voice/missing.html'), project)).status).toBe(404)
  expect((await serveVoicePanelDocument(new Request('dsh-app://shell/voice/%2e%2e%2fprivate'), project)).status).toBe(403)
})
