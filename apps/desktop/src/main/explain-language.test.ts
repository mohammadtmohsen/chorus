import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_EXPLAIN_LANGUAGE, normaliseExplainLanguage } from '../shared/ipc.js'
import { readSettings, writeSettings, DEFAULT_SETTINGS } from './settings.js'

/**
 * A free-text language, bounded.
 *
 * Free text is the point — "Lebanese Arabic" is an answer a locale list cannot
 * express. What free text also accepts, unbounded, is a newline that makes a
 * one-line field look empty while holding content, whitespace that produces an
 * action doing nothing, and a paragraph that would reach a prompt and a button.
 */

const where = (): string => mkdtempSync(join(tmpdir(), 'chorus-lang-'))

describe('normaliseExplainLanguage', () => {
  it('keeps an ordinary answer as typed', () => {
    expect(normaliseExplainLanguage('Lebanese Arabic')).toBe('Lebanese Arabic')
  })

  it('trims, because a trailing space is invisible and would survive into a prompt', () => {
    expect(normaliseExplainLanguage('  Arabic  ')).toBe('Arabic')
  })

  it('flattens a pasted newline rather than rejecting it', () => {
    // A paste should not become an error message, and a one-line control holding
    // a newline looks broken in a way nothing on screen explains.
    expect(normaliseExplainLanguage('Arabic\nLebanese')).toBe('Arabic Lebanese')
  })

  it('collapses runs of whitespace', () => {
    expect(normaliseExplainLanguage('simple   Arabic')).toBe('simple Arabic')
  })

  it('treats whitespace alone as empty, which is what switches the action off', () => {
    expect(normaliseExplainLanguage('   \n  ')).toBe('')
  })

  it('bounds the length, so neither a prompt nor a button can be arbitrary', () => {
    const long = 'a'.repeat(MAX_EXPLAIN_LANGUAGE + 50)
    expect(normaliseExplainLanguage(long)).toHaveLength(MAX_EXPLAIN_LANGUAGE)
  })
})

describe('the setting on disk', () => {
  it('defaults to empty, so the action is off until someone asks for it', () => {
    expect(DEFAULT_SETTINGS.explainLanguage).toBe('')
    expect(readSettings(where()).explainLanguage).toBe('')
  })

  it('normalises on write', () => {
    const path = where()
    const written = writeSettings(path, { ...DEFAULT_SETTINGS, explainLanguage: '  Arabic \n' })
    expect(written.explainLanguage).toBe('Arabic')
    expect(readSettings(path).explainLanguage).toBe('Arabic')
  })

  it('normalises a hand-edited file on read', () => {
    // The file is the user's and they may edit it. Tidying on read means a
    // stray newline does not produce a field that looks empty but is not.
    const path = where()
    writeSettings(path, { ...DEFAULT_SETTINGS, explainLanguage: 'Arabic' })
    expect(readSettings(path).explainLanguage).toBe('Arabic')
  })

  it('still parses a settings file written before this existed', () => {
    // Every key here is a default, and a file that predates one must not reset
    // the rest of the user's preferences to get it. The single `model` is folded
    // onto Claude on read — see the schema's transform — so it survives under
    // the agent whose catalogue it was always chosen from.
    const path = where()
    writeSettings(path, { ...DEFAULT_SETTINGS, model: 'sonnet', explainLanguage: 'Arabic' })
    const reread = readSettings(path)
    expect(reread.models.claude).toBe('sonnet')
    expect(reread.explainLanguage).toBe('Arabic')
  })
})
