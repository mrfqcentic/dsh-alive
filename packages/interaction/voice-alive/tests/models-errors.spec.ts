/** Failure projection and the disk-step wrapper shared by the store and downloader. */
import { expect, it } from 'vitest'
import { ModelStoreError, diskStep, failureOf, reasonOf } from '../src/models/host/errors.ts'

it('projects a model failure unchanged and keeps its code', () => {
  const error = new ModelStoreError('hash-mismatch', 'checksum differs')
  expect(error.failure).toEqual({ code: 'hash-mismatch', message: 'checksum differs' })
  expect(failureOf(error)).toEqual({ code: 'hash-mismatch', message: 'checksum differs' })
})

it('projects an untyped value onto the fallback category', () => {
  expect(failureOf(new Error('boom'), 'network')).toEqual({ code: 'network', message: 'boom' })
  expect(failureOf('boom')).toEqual({ code: 'internal', message: 'boom' })
})

it('describes an error by its code when it has one', () => {
  expect(reasonOf(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))).toBe('ENOSPC')
  expect(reasonOf(new Error('plain failure'))).toBe('plain failure')
  expect(reasonOf(42)).toBe('42')
})

it('wraps a rejected filesystem call as a disk failure', async () => {
  const rejected = diskStep(Promise.reject(Object.assign(new Error('read only'), { code: 'EROFS' })), 'create the directory')
  await expect(rejected).rejects.toThrow(expect.objectContaining({ code: 'disk' }))
  await expect(rejected).rejects.toThrow('model store could not create the directory (EROFS)')
})

it('passes a fulfilled filesystem call through', async () => {
  await expect(diskStep(Promise.resolve(7), 'measure a file')).resolves.toBe(7)
})
