/**
 * Assemble the voice panel document after the Vite build.
 *
 * The panel is served as a static document on the `dsh-app://shell` origin,
 * so the Host cannot inject `window.__DSH_BOOT__` into it the way the Web
 * shell's server-side index render does. This script runs the same two halves
 * of that boot protocol at build time:
 *
 * 1. compose the panel's client roster from the voice bundle's patch layer
 *    (`composeEntries`, the profile composer the application boot uses), then
 * 2. render the same row table the Host would inject (`bootInjections` +
 *    `renderIndexInjections` from the Web shell's boot contract).
 *
 * The result is a self-contained `dist/panel/` with document-relative URLs:
 * `panel.html`, its Vite assets, and one classic client bundle per roster row
 * under `plugins/`. No host, port, or origin is invented; the page loads only
 * the voice row.
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { bootInjections, orderByModuleGraph } from '@deepseek-ai/dsh-client-modules'
import type { WebBootBatch, WebBootEntry, WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'
import { renderIndexInjections } from '@deepseek-ai/dsh-host-webserver'

/** Package directory of the plugin that owns this build. */
const PACKAGE_DIR = resolve(import.meta.dirname, '..')
/** Bundle whose patch layer names the panel roster. */
const BUNDLE_DIR = resolve(PACKAGE_DIR, '../../bundle/voice-alive')
/** Emitted panel document directory. */
const PANEL_DIST = join(PACKAGE_DIR, 'dist/panel')
/** Bootstrap package the facade materializes before the module system exists. */
const BOOTSTRAP_ID = '@deepseek-ai/dsh-client-modules'

/** One `dsh.client` row read from a roster package manifest. */
interface ClientDeclaration {
  readonly platform?: string
  readonly inject?: readonly string[]
  readonly external?: readonly string[]
  readonly immediately?: boolean
}

/** The package manifest fields this assembly reads. */
interface PackageManifest {
  readonly name?: string
  readonly exports?: Readonly<Record<string, string | { readonly default?: string }>>
  readonly dsh?: { readonly client?: ClientDeclaration }
}

/** One enabled package from the composed voice bundle patch. */
interface RosterEntry {
  readonly id: string
  readonly manifestPath: string
  readonly declaration: ClientDeclaration
}

/**
 * Read the client-export path of a roster package.
 * @param manifest - parsed package manifest.
 * @returns the package-relative `./client` artifact path.
 * @throws {Error} when the manifest declares no `./client` export.
 */
function clientExport(manifest: PackageManifest): string {
  const declared = manifest.exports?.['./client']
  const relative = typeof declared === 'string' ? declared : declared?.default
  if (relative === undefined) throw new Error(`voice panel: ${manifest.name ?? '<unnamed>'} exports no "./client" bundle`)
  return relative
}

/**
 * Resolve one package's manifest through the bundle's dependency links.
 * @param packageName - npm package name from the composed roster.
 * @param bundleRequire - resolver rooted at the voice bundle.
 * @returns the absolute package.json path.
 */
function resolveManifest(packageName: string, bundleRequire: NodeRequire): string {
  try {
    return bundleRequire.resolve(`${packageName}/package.json`)
  } catch (error) {
    throw new Error(`voice panel: cannot resolve ${packageName} from the voice bundle`, { cause: error })
  }
}

/**
 * Copy one package's browser artifact (and its map and package-local chunks)
 * under `plugins/<id>/` and build its graph row.
 * @param id - package name / graph row key.
 * @param manifestPath - absolute package.json path of the roster package.
 * @param declaration - its `dsh.client` declaration.
 * @returns the graph row that addresses the copied artifact.
 */
async function copyBundle(id: string, manifestPath: string, declaration: ClientDeclaration): Promise<WebBootEntry> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest
  const source = resolve(dirname(manifestPath), clientExport(manifest))
  const bundle = await readFile(source)
  const target = join(PANEL_DIST, 'plugins', id, 'client.js')
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
  const sourceDirectory = dirname(source)
  for (const file of await readdir(sourceDirectory)) {
    if (file === 'client.js') continue
    if (!/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js(?:\.map)?$/u.test(file)) continue
    await copyFile(join(sourceDirectory, file), join(dirname(target), file))
  }
  const rev = createHash('sha256').update(bundle).digest('hex').slice(0, 12)
  return {
    id,
    url: `plugins/${id}/client.js`,
    rev,
    ...(declaration.inject === undefined || declaration.inject.length === 0 ? {} : { inject: [...declaration.inject] }),
    ...(declaration.external === undefined || declaration.external.length === 0 ? {} : { external: [...declaration.external] }),
    ...(declaration.immediately === true ? { immediately: true } : {}),
  }
}

/**
 * Compose the panel roster from the voice bundle's patch layer.
 * @param bundleRequire - resolver rooted at the voice bundle.
 * @returns one entry per enabled package that declares a Web client half.
 */
async function composeRoster(bundleRequire: NodeRequire): Promise<RosterEntry[]> {
  const manifest = JSON.parse(await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8')) as {
    readonly dsh?: { readonly bundle?: { readonly patch?: string | readonly string[] } }
  }
  const declared = manifest.dsh?.bundle?.patch
  const patchFiles = typeof declared === 'string' ? [declared] : declared ?? []
  const layers = patchFiles.flatMap(file => loadOverlayPatches('voice panel', resolve(BUNDLE_DIR, file)))
  const entries = composeEntries([layers]) as ReadonlyArray<{ readonly name?: unknown; readonly disabled?: unknown }>
  const roster: RosterEntry[] = []
  for (const entry of entries) {
    if (entry.disabled === true || typeof entry.name !== 'string') continue
    const manifestPath = resolveManifest(entry.name, bundleRequire)
    const pkg = JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest
    if (pkg.name !== entry.name) throw new Error(`voice panel: ${entry.name} resolved ${pkg.name ?? '<unnamed>'}`)
    const declaration = pkg.dsh?.client
    if (declaration?.platform !== 'web') continue
    roster.push({ id: entry.name, manifestPath, declaration })
  }
  if (roster.length === 0) throw new Error('voice panel: the voice bundle patch declares no Web client row')
  return roster
}

/**
 * Build and inject the panel's voice-only boot graph.
 * @returns the emitted document path.
 */
async function main(): Promise<string> {
  const page = join(PANEL_DIST, 'panel.html')
  if (!existsSync(page)) throw new Error(`voice panel: ${page} is missing; run the Vite build first`)

  const bundleRequire = createRequire(join(BUNDLE_DIR, 'package.json'))
  const localRequire = createRequire(import.meta.url)

  const bootstrapManifest = localRequire.resolve(`${BOOTSTRAP_ID}/package.json`)
  const bootstrap = await copyBundle(BOOTSTRAP_ID, bootstrapManifest, { platform: 'web' })
  const roster = await composeRoster(bundleRequire)
  const bundles: WebBootEntry[] = []
  for (const entry of roster) bundles.push(await copyBundle(entry.id, entry.manifestPath, entry.declaration))

  const entries = orderByModuleGraph([bootstrap, ...bundles])
  const batches: WebBootBatch[] = [
    { phase: 'bootstrap', url: bootstrap.url, rev: bootstrap.rev, entries: [bootstrap.id] },
    ...bundles.map((bundle): WebBootBatch => ({
      phase: 'application',
      url: bundle.url,
      rev: bundle.rev,
      entries: [bundle.id],
    })),
  ]
  const rev = createHash('sha256').update(JSON.stringify({ entries, batches })).digest('hex').slice(0, 12)
  const graph: WebBootGraph = { rev, entries, batches }

  const html = await readFile(page, 'utf8')
  const document = renderIndexInjections(html, bootInjections(graph))
  await writeFile(page, document)

  // The document is served as a static file under /voice/; an absolute app
  // path would escape the route the shell installs.
  const absolute = /(?:src|href)="\/[^"]*"/u.exec(document)
  if (absolute !== null) throw new Error(`voice panel: panel.html carries an absolute asset URL: ${absolute[0]}`)
  if (!document.includes('globalThis["__DSH_BOOT__"]')) throw new Error('voice panel: panel.html lost its __DSH_BOOT__ row')
  if (!document.includes('data-dsh-voice-panel')) throw new Error('voice panel: panel.html lost its panel marker')
  return page
}

const page = await main()
console.log(`voice panel: wrote ${page}`)
