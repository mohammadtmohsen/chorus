import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ConsoleExpansion, ConsoleValue } from '../../shared/console-ipc.js'

export function ConsoleValueView(props: {
  readonly projectId: string
  readonly value: ConsoleValue
  readonly name?: string
}): React.JSX.Element {
  const { projectId, value, name } = props
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [expansion, setExpansion] = useState<ConsoleExpansion | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const handle = value.handle

  const toggle = (): void => {
    if (handle === null) return
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (expansion !== null || loading) return
    setLoading(true)
    setFailed(false)
    window.chorus
      .expandConsole({ projectId, handle })
      .then((reply) => {
        setExpansion(reply)
      })
      .catch(() => {
        setFailed(true)
      })
      .finally(() => {
        setLoading(false)
      })
  }

  const label = (
    <>
      {name !== undefined && <span className="console-value-name">{name}: </span>}
      <span className={`console-value console-value--${value.type}`}>{value.text}</span>
    </>
  )

  if (handle === null) return <span className="console-value-line">{label}</span>

  return (
    <span className="console-value-tree">
      <button
        type="button"
        className="console-value-toggle"
        aria-expanded={open}
        aria-label={open ? t('console.collapseValue') : t('console.expandValue')}
        onClick={toggle}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        {label}
      </button>
      {open && (
        <span className="console-value-children" role="group">
          {loading && <span className="console-value-note">{t('console.loading')}</span>}
          {failed && <span className="console-value-note">{t('console.expandUnavailable')}</span>}
          {expansion?.status === 'gone' && (
            <span className="console-value-note">{t('console.gone')}</span>
          )}
          {expansion?.status === 'unavailable' && (
            <span className="console-value-note">{t('console.expandUnavailable')}</span>
          )}
          {expansion?.status === 'ok' && (
            <>
              {expansion.properties.map((property, index) => (
                <ConsoleValueView
                  key={`${property.kind}:${property.name}:${String(index)}`}
                  projectId={projectId}
                  value={property.value}
                  name={property.name}
                />
              ))}
              {expansion.omittedIndexed > 0 && (
                <span className="console-value-note">
                  {t('console.moreItems', { count: expansion.omittedIndexed })}
                </span>
              )}
              {expansion.total - expansion.properties.length - expansion.omittedIndexed > 0 && (
                <span className="console-value-note">
                  {t('console.moreProperties', {
                    count: expansion.total - expansion.properties.length - expansion.omittedIndexed,
                  })}
                </span>
              )}
            </>
          )}
        </span>
      )}
    </span>
  )
}
