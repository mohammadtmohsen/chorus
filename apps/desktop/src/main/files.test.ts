import { describe, expect, it } from 'vitest'
import { askAgain } from './files.js'

/**
 * Which failures are worth putting again, and which are a promise that cannot
 * come true.
 *
 * Every one of these used to be `[]`, and `[]` is also what git says when it
 * simply found nothing — which is how a menu came to be empty and stay empty for
 * the life of a pane (C-003). Getting this wrong in the retryable direction
 * spawns a process on a loop to learn the same thing; getting it wrong the other
 * way is the bug.
 */

/** `execFile` rejects with the child's own fields hung off an `Error`. */
const failure = (over: Record<string, unknown>): unknown => Object.assign(new Error('git'), over)

describe('worth asking again', () => {
  it('a timeout, which under load is a busy machine rather than a huge repository', () => {
    // `execFile` kills the child at `timeout`, so `killed` is the signal for it
    // and `code` is null — checked first, before either `code` reading.
    expect(askAgain(failure({ killed: true, code: null, signal: 'SIGTERM' }))).toBe(true)
  })

  it('a fork that could not happen right now', () => {
    /*
     * The condition a suite of Electron launches actually creates, and the one
     * this whole entry is about: the spawn never happened, so git has said
     * nothing at all.
     */
    for (const code of ['EAGAIN', 'ENOMEM', 'EMFILE', 'ENFILE']) {
      expect(askAgain(failure({ code }))).toBe(true)
    }
  })

  it('a lock another git process is holding, which clears on its own', () => {
    /*
     * The case that earns the benefit of the doubt for a non-zero exit, and it
     * is produced by exactly the load this entry is about: two git processes at
     * once. Retrying is the correct response and the only one that works.
     */
    const stderr = "fatal: Unable to create '/repo/.git/index.lock': File exists"
    expect(askAgain(failure({ code: 128, stderr }))).toBe(true)
  })

  it('a non-zero exit git did not explain', () => {
    // Retried on purpose. Being wrong here costs a few bounded asks; being wrong
    // the other way is a menu that is empty until the app restarts.
    expect(askAgain(failure({ code: 128, stderr: 'fatal: bad object HEAD' }))).toBe(true)
  })
})

describe('never worth asking again', () => {
  it('no git on this machine', () => {
    // A string `code` from a spawn that failed, not an exit status.
    expect(askAgain(failure({ code: 'ENOENT' }))).toBe(false)
  })

  it('a directory that is not a repository, which is the ordinary case', () => {
    expect(
      askAgain(
        failure({
          code: 128,
          stderr: 'fatal: not a git repository (or any of the parent directories)',
        })
      )
    ).toBe(false)
  })

  it('a directory that is not there at all', () => {
    /*
     * Git's own wording for a bad `-C`, read off the binary rather than guessed:
     * `fatal: cannot change to '/no/such/dir': No such file or directory`. The
     * first version of this classifier called it retryable, and a real run
     * against a missing directory is what caught it.
     */
    const stderr = "fatal: cannot change to '/no/such/dir': No such file or directory"
    expect(askAgain(failure({ code: 128, stderr }))).toBe(false)
  })

  it('output too large for the buffer, which is the same size next time', () => {
    expect(askAgain(failure({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }))).toBe(false)
  })
})

describe('the two readings of `code`, which Node overloads', () => {
  it('a string is about starting git; a number is about what git said', () => {
    /*
     * The distinction the whole classifier rests on. `EAGAIN` and exit 128 are
     * both "code", and they are not the same kind of fact — one means git never
     * ran, the other means it ran and objected.
     */
    expect(askAgain(failure({ code: 'EAGAIN' }))).toBe(true)
    expect(askAgain(failure({ code: 128, stderr: 'fatal: not a git repository' }))).toBe(false)
  })

  it('survives an error carrying nothing useful at all', () => {
    expect(askAgain(failure({}))).toBe(true)
    expect(askAgain(undefined)).toBe(true)
  })
})
