/** The shipped bundle stack composes every telemetry row away before boot. */

import { fileURLToPath } from 'node:url'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'

const TELEMETRY_IDS = ['otel', 'session-telemetry-otel', 'desktop-product-telemetry', 'product-analytics'] as const

/** Read one sibling bundle layer from this checkout. */
function layer(name: string) {
  return loadOverlayPatches('privacy-test', fileURLToPath(new URL(`../../${name}/cordis.patch.yml`, import.meta.url)))
}

/** Compose the layers the shipped Web and Desktop profile template selects. */
function composed() {
  return composeEntries([layer('base'), layer('web-app'), layer('voice-alive')])
}

it.each(TELEMETRY_IDS)('disables the %s row inserted by an earlier layer', (id) => {
  expect(composed().find(entry => entry.id === id)?.disabled).toBe(true)
})

it('leaves no enabled telemetry or analytics module in the composed tree', () => {
  const enabled = composed().filter(entry => entry.disabled !== true)
  expect(enabled.filter(entry => /telemetry|analytics|otel/i.test(`${entry.id} ${entry.name}`))).toEqual([])
})
