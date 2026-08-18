import { useEffect, useState } from 'react'
import { AttachmentTile, Viewer, type Attachment } from './Attachments.js'

/**
 * The pictures a sent message ended with, drawn as the tiles they were.
 *
 * A message carries paths, because that is what an agent is given — it opens a
 * file the same way you would, so there is no upload and nothing to store. The
 * cost is that your own message reads back as forty characters of
 * `/Users/…/1787054491497-3-image.png`, which is the least useful description of
 * a screenshot available and takes two lines to say it.
 *
 * So the transcript draws what the composer drew. Nothing about the message
 * changes: `splitTrailingPaths` only decides what to *show*, the text in the log
 * is untouched, and the agent received what it always received.
 *
 * **Only images become tiles.** Every candidate is checked with main, and a path
 * that is a directory, a log, or gone since is left in the words where it was.
 * That is what makes the guess safe: the failure mode is the message Chorus
 * already drew.
 */

/**
 * What each path turned out to be, kept for the life of the window.
 *
 * Module scope rather than component state, because the same message is drawn
 * again on every scroll that remounts it and on every tab it comes back to, and
 * a preview is a file read plus a base64 of the whole image. Keyed by path,
 * which is what a preview is *of* — two messages naming the same screenshot are
 * one read.
 *
 * A `null` entry is a real answer meaning "asked, and it is not a picture", so a
 * path that is not an image is not re-read on every render.
 */
const previews = new Map<string, Attachment | null>()

export function SentAttachments(props: { paths: readonly string[] }): React.JSX.Element | null {
  const { paths } = props
  const [items, setItems] = useState<Attachment[]>(() =>
    paths.map((path) => previews.get(path)).filter((item): item is Attachment => item != null)
  )
  const [viewing, setViewing] = useState<Attachment | null>(null)
  /*
   * The contents, not the array.
   *
   * This effect sets state, so depending on the array itself would re-run it for
   * any caller that builds one inline — render, resolve, set, render — which is
   * a loop rather than a wasted read. Encoded rather than joined because a path
   * may contain a space, and decoded inside the effect so the dependency list is
   * honest: one value, changing exactly when the paths do.
   */
  const key = JSON.stringify(paths)

  useEffect(() => {
    const wanted = JSON.parse(key) as string[]
    if (wanted.length === 0) return
    let live = true
    void Promise.all(
      wanted.map(async (path) => {
        const known = previews.get(path)
        if (known !== undefined) return known
        try {
          const preview = await window.chorus.previewFile({ path })
          // A file that is not a showable image is remembered as such, so this
          // asks once rather than once per render.
          const item = preview.dataUrl === null ? null : { path, ...preview }
          previews.set(path, item)
          return item
        } catch {
          // Gone, unreadable, or something main will not open: the words keep
          // the path, which is the honest thing to show for a file that is not
          // there any more.
          previews.set(path, null)
          return null
        }
      })
    ).then((resolved) => {
      if (!live) return
      setItems(resolved.filter((item): item is Attachment => item != null))
    })
    return () => {
      live = false
    }
  }, [key])

  if (items.length === 0) return null

  return (
    <div className="attachments attachments--sent">
      {items.map((item) => (
        <AttachmentTile key={item.path} item={item} onOpen={setViewing} />
      ))}
      {viewing?.dataUrl != null && (
        <Viewer
          item={viewing}
          onClose={() => {
            setViewing(null)
          }}
        />
      )}
    </div>
  )
}
