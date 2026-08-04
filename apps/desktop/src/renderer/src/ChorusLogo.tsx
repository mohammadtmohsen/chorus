/**
 * The wordmark, set in the app's own typeface.
 *
 * It used to be drawn: six Didone letterforms as SVG paths, with the O carrying
 * both voice colours. That reads as a masthead, and the app is now a terminal —
 * a serif logo above a monospace transcript is the one element announcing it
 * came from somewhere else. The old paths are in git history if the room ever
 * changes back.
 *
 * The idea survives the change of clothes: three voices still inhabit one
 * letter, the O carrying a gradient from Codex's hue to Claude's. Everything
 * else is the plain grid the rest of the app is set on.
 */
export function ChorusLogo(props: { className?: string; label: string }): React.JSX.Element {
  return (
    <span className={props.className} role="img" aria-label={props.label}>
      {/* Split so the O can be coloured; the parts read as one word to a reader. */}
      <span aria-hidden="true">CH</span>
      <span aria-hidden="true" className="chorus-logo__voice">
        O
      </span>
      <span aria-hidden="true">RUS</span>
    </span>
  )
}
