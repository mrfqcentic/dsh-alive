import { clientBundle } from '../../client/tsdown.client.ts'

// The Host half keeps its entry in lib/index.js and emits the worker beside it so
// the packaged application can launch lib/worker.js through ELECTRON_RUN_AS_NODE.
export default clientBundle(import.meta.dirname, ['lib/types/index.js'], {
  lib: {
    entry: {
      index: 'lib/types/index.js',
      worker: 'lib/types/engine/asr-worker.js',
    },
  },
})
