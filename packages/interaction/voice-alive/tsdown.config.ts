import { clientBundle } from '../../client/tsdown.client.ts'

// The Host half keeps its entry in lib/index.js. `lib/worker.js` is the single
// `./worker` export: a dispatcher that loads the ASR or TTS role module named by
// its role argument, so a packaged Electron app launches both engines through
// one published ELECTRON_RUN_AS_NODE entry. Each worker entry is its own
// bundle, so the exact `files` list publishes every artifact they need.
export default clientBundle(import.meta.dirname, ['lib/types/index.js'], {
  lib: {
    entry: {
      index: 'lib/types/index.js',
      worker: 'lib/types/engine/worker.js',
      'asr-worker': 'lib/types/engine/asr-worker.js',
      'tts-worker': 'lib/types/engine/tts-worker.js',
    },
  },
})
