/**
 * Whether the stored TypeSafe key works, answered by using it once.
 *
 * **There is nothing to connect to, so "connected" is not a state this can
 * report.** TypeSafe has no session and no handshake — the key is presented on
 * every request — so the only honest question is whether a call made with it
 * succeeds. `api.md` documents exactly one endpoint and no `GET /v1/models`, so
 * there is no free way to ask.
 *
 * **Which makes the check billed, and that decides when it may run.** The
 * response carries a `usage` object with input and output token counts, so a
 * check on launch, on opening the sheet, or on a timer would spend the user's
 * money to draw a tick. It runs when a button is pressed and at no other time.
 *
 * **Main-side, like every other use of this key.** The value never crosses to a
 * renderer; the renderer asks for a verdict and is told one.
 */

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

/** Long enough for a cold model, short enough that a hung sheet is noticed. */
const TIMEOUT_MS = 20_000

/**
 * The smallest body the three required fields allow.
 *
 * `state`, `model` and `questions` are all required, and a `noul` question needs
 * only `instructions` — no criteria, no rubric. Read out of `api.md` rather than
 * guessed, because a shape invented here would fail in a way that looks like a
 * bad key.
 */
const PROBE = {
  state: 'ping',
  model: 'jev-latest',
  questions: { ok: { type: 'noul', instructions: 'Is this text?' } },
}

/**
 * `detail` is the transport's own words, so it is not a translation key.
 *
 * **The statuses are separated by whose problem they are**, because each one
 * sends the reader somewhere different: `rejected` to regenerate a key,
 * `malformed` to report a bug in Chorus, `busy` to wait, `unreachable` to look
 * at the network. `api.md` documents 401, 422, 429 and 529, and folding the
 * middle two into "could not be reached" would have made the first genuine test
 * of a wrong request body read as an outage.
 */
export type KeyCheck =
  | { readonly state: 'valid' }
  | { readonly state: 'missing' }
  | { readonly state: 'rejected' }
  | { readonly state: 'malformed' }
  | { readonly state: 'busy' }
  | { readonly state: 'unreachable'; readonly detail: string }

export async function checkTypesafeValue(key: string | null): Promise<KeyCheck> {
  if (key === null) return { state: 'missing' }

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(PROBE),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    /*
     * Only an authentication refusal is the key's fault, and reporting anything
     * else as "your key is wrong" would send someone to regenerate a key that
     * was fine.
     *
     * 422 is the opposite mistake and the more likely one here: it means the
     * body above is wrong, which is a bug in Chorus rather than anything the
     * reader can act on — and `PROBE` is the one shape in this feature that has
     * never been sent. Reporting it as an outage would hide exactly the defect
     * the first real press is most likely to find.
     */
    if (response.status === 401 || response.status === 403) return { state: 'rejected' }
    if (response.status === 422) return { state: 'malformed' }
    if (response.status === 429) return { state: 'busy' }
    if (!response.ok) return { state: 'unreachable', detail: `HTTP ${String(response.status)}` }
    return { state: 'valid' }
  } catch (error) {
    return { state: 'unreachable', detail: error instanceof Error ? error.message : String(error) }
  }
}
