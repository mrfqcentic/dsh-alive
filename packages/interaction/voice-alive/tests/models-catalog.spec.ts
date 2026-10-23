/** The pinned catalog is complete: URLs, hashes, sizes, licenses, and engine layouts. */
import { expect, it } from 'vitest'
import { MODEL_CATALOG, catalogEntry, modelBytes } from '../src/models/catalog.ts'
import type { ModelId } from '../src/models/types.ts'
import { voiceModelsRoot } from '../src/models/host/index.ts'
import { filePath, modelDirectory, partPath, stagingDirectory } from '../src/models/host/layout.ts'

/** Pinned Hugging Face file URL: repository, immutable revision, and file path. */
const PINNED_URL = /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\/.+$/u
/** Lowercase hex SHA-256 of the complete file. */
const SHA256 = /^[0-9a-f]{64}$/u

it('ships exactly one required entry per kind', () => {
  const asr = MODEL_CATALOG.filter(record => record.kind === 'asr')
  const tts = MODEL_CATALOG.filter(record => record.kind === 'tts')
  expect(MODEL_CATALOG.map(record => record.id)).toEqual(['whisper-base', 'parakeet-v3', 'kokoro'])
  expect(asr.filter(record => record.required)).toHaveLength(1)
  expect(tts.filter(record => record.required)).toHaveLength(1)
  expect(catalogEntry('kokoro')?.required).toBe(true)
  expect(catalogEntry('parakeet-v3')?.required).toBe(false)
})

it('maps every entry to the engine that loads its directory', () => {
  for (const record of MODEL_CATALOG) {
    if (record.kind === 'asr') expect(['whisper', 'parakeet']).toContain(record.engine)
    else expect(record.engine).toBe('kokoro')
  }
})

it('pins every file to an immutable https revision with an exact size and hash', () => {
  for (const record of MODEL_CATALOG) {
    expect(record.files.length).toBeGreaterThan(0)
    const revisions = new Set(record.files.map(file => file.url.split('/resolve/')[1]?.split('/')[0]))
    expect(revisions.size).toBe(1)
    for (const file of record.files) {
      expect(file.url).toMatch(PINNED_URL)
      expect(file.sha256).toMatch(SHA256)
      expect(Number.isSafeInteger(file.bytes)).toBe(true)
      expect(file.bytes).toBeGreaterThan(0)
      expect(file.path.startsWith('/')).toBe(false)
      expect(file.path.split('/')).not.toContain('..')
    }
  }
})

it('sums the pinned byte count of an entry', () => {
  const kokoro = catalogEntry('kokoro')
  if (kokoro === undefined) throw new Error('the catalog is missing kokoro')
  expect(modelBytes(kokoro)).toBe(kokoro.files.reduce((total, file) => total + file.bytes, 0))
})

it('declares the file names the ASR worker discovers', () => {
  for (const record of MODEL_CATALOG.filter(entry => entry.kind === 'asr')) {
    const paths = record.files.map(file => file.path)
    expect(paths).toContain('encoder.int8.onnx')
    expect(paths).toContain('decoder.int8.onnx')
    expect(paths).toContain('tokens.txt')
    if (record.engine === 'parakeet') expect(paths).toContain('joiner.int8.onnx')
    else expect(paths).not.toContain('joiner.int8.onnx')
  }
})

it('declares the Kokoro layout kokoro-js loads', () => {
  const paths = (catalogEntry('kokoro')?.files ?? []).map(file => file.path)
  expect(paths).toEqual(['onnx/model_quantized.onnx', 'config.json', 'tokenizer.json', 'tokenizer_config.json'])
})

it('carries the metadata the pane and attribution need', () => {
  for (const record of MODEL_CATALOG) {
    expect(record.name).not.toBe('')
    expect(record.summary).not.toBe('')
    expect(record.languages.length).toBeGreaterThan(0)
    expect(record.license).not.toBe('')
    expect(record.attribution).not.toBe('')
  }
})

it('reports no entry for an id outside the catalog', () => {
  expect(catalogEntry('whisper-base')).toBeDefined()
  expect(catalogEntry('sensevoice' as ModelId)).toBeUndefined()
})

it('places the store under the profile voice directory', () => {
  expect(voiceModelsRoot('/home/user/.dsh')).toBe('/home/user/.dsh/voice/models')
})

it('derives the staging, partial, and final paths from the store root', () => {
  expect(modelDirectory('/models', 'kokoro')).toBe('/models/kokoro')
  expect(stagingDirectory('/models', 'kokoro')).toBe('/models/.staging/kokoro')
  expect(filePath('/models/kokoro', 'onnx/model.onnx')).toBe('/models/kokoro/onnx/model.onnx')
  expect(partPath('/models/.staging/kokoro', 'onnx/model.onnx')).toBe('/models/.staging/kokoro/onnx/model.onnx.part')
})
