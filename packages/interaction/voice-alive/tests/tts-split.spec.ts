/** Sentence splitting preserves abbreviations, quotes, decimals, and the length cap. */
import { describe, expect, it } from 'vitest'
import { resolveWorkerEntry, splitSentences, workerArguments } from '../src/engine/tts.ts'

describe('splitSentences', () => {
  it('splits ordinary sentence punctuation in reading order', () => {
    expect(splitSentences('Hello world. How are you? Fine!')).toEqual([
      'Hello world.', 'How are you?', 'Fine!',
    ])
  })

  it('keeps abbreviations, initials, and dotted initialisms inside one sentence', () => {
    expect(splitSentences('Dr. Smith met Mrs. Jones at the U.S. embassy. They talked.')).toEqual([
      'Dr. Smith met Mrs. Jones at the U.S. embassy.', 'They talked.',
    ])
    expect(splitSentences('Use e.g. this and i.e. that.').length).toBe(1)
    expect(splitSentences('J. K. Rowling wrote it.').length).toBe(1)
    expect(splitSentences('St. Louis vs. Chicago ends at 5 p.m. tomorrow.').length).toBe(1)
  })

  it('does not split decimals or ellipses into empty sentences', () => {
    expect(splitSentences('Pi is 3.14 today. Next.')).toEqual(['Pi is 3.14 today.', 'Next.'])
    expect(splitSentences('Wait... Then go.')).toEqual(['Wait...', 'Then go.'])
    expect(splitSentences('Really?! Yes.')).toEqual(['Really?!', 'Yes.'])
  })

  it('keeps closing quotes and brackets with their sentence', () => {
    expect(splitSentences('He said "Go." Then left.')).toEqual(['He said "Go."', 'Then left.'])
    expect(splitSentences('Look (really.) Next.')).toEqual(['Look (really.)', 'Next.'])
  })

  it('treats newlines as boundaries and ignores blank text', () => {
    expect(splitSentences('One\nTwo\n\nThree')).toEqual(['One', 'Two', 'Three'])
    expect(splitSentences('   \n  ')).toEqual([])
  })

  it('caps a long sentence at clause or word boundaries', () => {
    const long = `${Array.from({ length: 120 }, (_, index) => `word${String(index)}`).join(' ')}.`
    const chunks = splitSentences(long)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(240)
    expect(chunks.join(' ')).toBe(long.trim())
  })

  it('hard-caps an unbroken run of characters', () => {
    const chunks = splitSentences('a'.repeat(1000))
    expect(chunks.map(chunk => chunk.length)).toEqual([240, 240, 240, 240, 40])
  })
})

describe('workerArguments', () => {
  it('loads source through tsx and runs built output directly', () => {
    const config = { modelDirectory: '/models/kokoro', voice: 'af_heart' }
    const source = workerArguments('/repo/src/engine/tts-worker.ts', config)
    expect(source[0]).toBe('--import')
    expect(source[1]).toContain('tsx')
    expect(source.slice(2)).toEqual(['/repo/src/engine/tts-worker.ts', JSON.stringify(config)])
    expect(workerArguments('/repo/lib/worker.js', config)).toEqual([
      '/repo/lib/worker.js', JSON.stringify(config),
    ])
  })
})

describe('resolveWorkerEntry', () => {
  it('selects the TypeScript worker beside source and the built worker beside lib', () => {
    expect(resolveWorkerEntry('file:///repo/src/engine/tts.ts').pathname).toBe('/repo/src/engine/tts-worker.ts')
    expect(resolveWorkerEntry('file:///repo/lib/index.js').pathname).toBe('/repo/lib/worker.js')
  })
})
