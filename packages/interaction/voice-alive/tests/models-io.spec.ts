/** Node filesystem adapter used by the model store in production. */
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { createNodeFileSystem } from '../src/models/host/io.ts'

const roots: string[] = []

/** @returns a fresh temporary directory registered for cleanup. */
async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-voice-models-'))
  roots.push(directory)
  return directory
}

afterEach(async () => {
  for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true })
})

it('creates nested directories, appends, and hashes a file', async () => {
  const root = await temporary()
  const fs = createNodeFileSystem()
  const nested = join(root, 'nested', 'deep')
  await fs.mkdir(nested)
  expect((await stat(nested)).isDirectory()).toBe(true)

  const path = join(nested, 'model.bin')
  const created = await fs.write(path, 'truncate')
  await created.write(new TextEncoder().encode('first'))
  await created.close()
  expect(await fs.size(path)).toBe(5)

  const appended = await fs.write(path, 'append')
  await appended.write(new TextEncoder().encode('second'))
  await appended.close()
  expect(await fs.size(path)).toBe(11)
  expect(await fs.hash(path)).toBe(createHash('sha256').update('firstsecond').digest('hex'))
})

it('reports absent paths without throwing', async () => {
  const root = await temporary()
  const fs = createNodeFileSystem()
  expect(await fs.exists(join(root, 'missing'))).toBe(false)
  expect(await fs.size(join(root, 'missing'))).toBeNull()
})

it('treats a directory as having no file size', async () => {
  const root = await temporary()
  const fs = createNodeFileSystem()
  await fs.mkdir(join(root, 'directory'))
  expect(await fs.size(join(root, 'directory'))).toBeNull()
  expect(await fs.exists(join(root, 'directory'))).toBe(true)
})

it('renames a file and removes a directory tree', async () => {
  const root = await temporary()
  const fs = createNodeFileSystem()
  const source = join(root, 'source.bin')
  const sink = await fs.write(source, 'truncate')
  await sink.write(new TextEncoder().encode('value'))
  await sink.close()

  const target = join(root, 'target.bin')
  await fs.rename(source, target)
  expect(await fs.exists(source)).toBe(false)
  expect(await fs.size(target)).toBe(5)

  await fs.remove(target)
  expect(await fs.exists(target)).toBe(false)
  await fs.remove(join(root, 'never-existed'))
})

it('rethrows a filesystem failure that is not a missing path', async () => {
  const fs = createNodeFileSystem()
  await expect(fs.size('invalid\0path')).rejects.toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }))
  await expect(fs.exists('invalid\0path')).rejects.toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }))
})
