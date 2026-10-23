import type { UserConfig } from 'tsdown'
import { clientBundle } from '../../client/tsdown.client.ts'

// The TTS worker is a separate Node entry: the Host spawns it with
// ELECTRON_RUN_AS_NODE, so it must exist as lib/worker.js and keep its
// third-party imports external.
const ttsWorker: UserConfig = {
  entry: { worker: 'lib/types/engine/tts-worker.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}

export default clientBundle(import.meta.dirname, ['lib/types/index.js'], {
  hostPhase: true,
  companions: [ttsWorker],
})
