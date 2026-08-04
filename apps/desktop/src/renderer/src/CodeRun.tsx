import { memo } from 'react'
import { highlight } from './highlight.js'

/**
 * Highlighted code, as elements.
 *
 * One component for every place code appears — fenced blocks and the command
 * lines agents run — so a shell command reads the same in the transcript as it
 * does in a reply.
 *
 * Memoised because a streaming message re-renders on every delta, and
 * re-tokenising a finished block on each one is work nobody asked for.
 */
export const CodeRun = memo(function CodeRun(props: {
  code: string
  language: string | null
}): React.JSX.Element {
  return (
    <>
      {highlight(props.code, props.language).map((token, i) =>
        token.kind === 'plain' ? (
          token.text
        ) : (
          <span key={i} className={`tok tok--${token.kind}`}>
            {token.text}
          </span>
        )
      )}
    </>
  )
})
