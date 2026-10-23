/**
 * Voice panel document build. It mirrors the Web shell's build values and
 * browser externals so the panel boots the same client kernel; the only
 * difference is its entry document and its output directory.
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { clientBuildEnvironmentDefines } from '../../../../scripts/client-build-environment.ts'

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  root: here('.'),
  // Relative asset URLs: the panel document is served under /voice/ on the
  // dsh-app shell origin, so every asset must resolve beside the document.
  base: './',
  plugins: [react()],
  resolve: {
    // One instance per shared npm identity, as in the Web shell build.
    dedupe: ['react', 'react-dom'],
    // The client kernel's Loader initialization may probe `node:module`;
    // browser boot never takes that path.
    alias: [{ find: /^node:module$/, replacement: here('./node-module-stub.ts') }],
  },
  define: {
    ...clientBuildEnvironmentDefines(process.env),
    // The vendored Loader probes the Node major; "0.0.0" takes neither branch.
    'process.versions.node': '"0.0.0"',
    'process.execArgv': '[]',
    'process.env.CORDIS_SHARED': 'undefined',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // The panel document is written under the package's dist tree.
    outDir: here('../dist/panel'),
    emptyOutDir: true,
    rollupOptions: { input: here('./panel.html') },
  },
})
