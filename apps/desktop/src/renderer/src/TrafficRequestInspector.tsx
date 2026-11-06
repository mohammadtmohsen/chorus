import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DEFAULT_TRAFFIC_REQUEST_FRACTION,
  MAX_TRAFFIC_REQUEST_FRACTION,
  MIN_TRAFFIC_REQUEST_FRACTION,
  type TrafficRowShape,
} from '../../shared/ipc.js'
import {
  BODY_PAGE,
  type TrafficDetail,
  type TrafficDetailResult,
} from '../../shared/traffic-ipc.js'
import { maskHeaders } from '../../shared/traffic-mask.js'
import {
  bytesFromBase64,
  curlCommand,
  encodedFields,
  formFields,
  queryStringOf,
  textOf,
} from './traffic-body.js'
import { TrafficBody } from './TrafficBody.js'
import { isPending } from './traffic-filter.js'
import { createSignal, useSignal } from './workspace/signal.js'

const bodyLayout = createSignal({ fraction: DEFAULT_TRAFFIC_REQUEST_FRACTION, failed: false })
let bodyLayoutStarted = false
let bodyLayoutRevision = 0
let storedBodyFraction: number | null = null

function receiveBodyFraction(fraction: number): void {
  bodyLayoutRevision += 1
  if (fraction === storedBodyFraction) return
  storedBodyFraction = fraction
  bodyLayout.set({ fraction, failed: false })
}

function startBodyLayout(): void {
  if (bodyLayoutStarted) return
  bodyLayoutStarted = true
  const revision = bodyLayoutRevision
  window.chorus.onSettings((settings) => {
    receiveBodyFraction(settings.trafficRequestFraction)
  })
  void window.chorus
    .readSettings()
    .then((settings) => {
      if (revision === bodyLayoutRevision) receiveBodyFraction(settings.trafficRequestFraction)
    })
    .catch(() => undefined)
}

function changeBodyFraction(fraction: number): void {
  if (!Number.isFinite(fraction)) return
  const next = Math.max(
    MIN_TRAFFIC_REQUEST_FRACTION,
    Math.min(MAX_TRAFFIC_REQUEST_FRACTION, fraction)
  )
  if (next === bodyLayout.get().fraction) return
  bodyLayoutRevision += 1
  bodyLayout.set({
    fraction: next,
    failed: false,
  })
}

function saveBodyLayout(): void {
  const { fraction } = bodyLayout.get()
  const revision = bodyLayoutRevision
  void window.chorus
    .writeSettings({ trafficRequestFraction: fraction })
    .then((settings) => {
      if (revision === bodyLayoutRevision) receiveBodyFraction(settings.trafficRequestFraction)
    })
    .catch(() => {
      if (bodyLayout.get().fraction === fraction) bodyLayout.set({ fraction, failed: true })
    })
}

/** A capture is held to a megabyte, so this cannot be reached by an honest body. */
const MAX_BODY_PAGES = 64

type Side = 'request' | 'response'
type HttpRow = Extract<TrafficRowShape, { source: 'http' }>

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const whole = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    whole.set(chunk, at)
    at += chunk.length
  }
  return whole
}

const headerRows = (
  headers: readonly (readonly [string, string])[],
  reveal: boolean
): readonly (readonly [string, string])[] => maskHeaders(headers, reveal)

export function TrafficRequestInspector(props: {
  readonly projectId: string
  readonly subscriptionId: string
  readonly captureId: string
  readonly row: HttpRow
}): React.JSX.Element {
  const { t } = useTranslation()
  const { projectId, subscriptionId, captureId, row } = props
  const pending = isPending(row)
  const layout = useSignal(bodyLayout)
  const requestFraction = layout.fraction
  const requestPaneId = useId()
  const panesRef = useRef<HTMLDivElement>(null)
  const resizing = useRef<{
    pointerId: number
    startX: number
    fraction: number
    width: number
  } | null>(null)
  const keyboardResizing = useRef(false)
  const resizeFrame = useRef<number | null>(null)
  const queuedFraction = useRef<number | null>(null)
  const [dragging, setDragging] = useState(false)

  const flushResize = useCallback((): void => {
    if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current)
    resizeFrame.current = null
    const fraction = queuedFraction.current
    queuedFraction.current = null
    if (fraction !== null) changeBodyFraction(fraction)
  }, [])

  useEffect(() => {
    startBodyLayout()
    return () => {
      flushResize()
      const active = resizing.current
      resizing.current = null
      if (
        keyboardResizing.current ||
        (active !== null && active.fraction !== bodyLayout.get().fraction)
      ) {
        saveBodyLayout()
      }
    }
  }, [flushResize])

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || resizing.current !== null) return
    const panes = panesRef.current
    if (panes === null) return
    const width =
      panes.getBoundingClientRect().width - event.currentTarget.getBoundingClientRect().width
    if (width <= 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const fraction = bodyLayout.get().fraction
    changeBodyFraction(fraction)
    resizing.current = { pointerId: event.pointerId, startX: event.clientX, fraction, width }
    setDragging(true)
  }

  const moveResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const active = resizing.current
    if (active?.pointerId !== event.pointerId) return
    queuedFraction.current = active.fraction + (event.clientX - active.startX) / active.width
    resizeFrame.current ??= requestAnimationFrame(flushResize)
  }

  const finishResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const active = resizing.current
    if (active?.pointerId !== event.pointerId) return
    flushResize()
    resizing.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (active.fraction !== bodyLayout.get().fraction) saveBodyLayout()
  }

  const keyResize = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const fraction = bodyLayout.get().fraction
    const step = event.shiftKey ? 0.1 : 0.02
    const next =
      event.key === 'ArrowLeft'
        ? fraction - step
        : event.key === 'ArrowRight'
          ? fraction + step
          : event.key === 'Home'
            ? MIN_TRAFFIC_REQUEST_FRACTION
            : event.key === 'End'
              ? MAX_TRAFFIC_REQUEST_FRACTION
              : null
    if (next === null) return
    event.preventDefault()
    changeBodyFraction(next)
    if (fraction !== bodyLayout.get().fraction) keyboardResizing.current = true
  }

  const finishKeyResize = (): void => {
    if (!keyboardResizing.current) return
    keyboardResizing.current = false
    saveBodyLayout()
  }

  const [detail, setDetail] = useState<TrafficDetail | null>(null)
  const [gone, setGone] = useState<TrafficDetailResult | null>(null)
  const [failure, setFailure] = useState(false)
  const [reveal, setReveal] = useState(false)
  const [querySource, setQuerySource] = useState(false)
  const [queryEncoded, setQueryEncoded] = useState(false)
  const [chunks, setChunks] = useState<Record<Side, Uint8Array[]>>({ request: [], response: [] })
  const [loaded, setLoaded] = useState<Record<Side, boolean>>({ request: false, response: false })
  const [loading, setLoading] = useState<Record<Side, boolean>>({ request: false, response: false })
  const readGeneration = useRef(0)
  const inFlight = useRef<Record<Side, number | null>>({ request: null, response: null })

  /*
   * Reveal is for one request and one reading of it. A new selection is a new
   * decision about whether to show a credential, so it is taken again rather
   * than inherited from whatever was open before.
   */
  useEffect(() => {
    setReveal(false)
  }, [row.requestId])

  useEffect(() => {
    readGeneration.current += 1
    inFlight.current = { request: null, response: null }
    setChunks({ request: [], response: [] })
    setLoaded({ request: false, response: false })
    setLoading({ request: false, response: false })
    setDetail(null)
    setGone(null)
    setFailure(false)
    return () => {
      readGeneration.current += 1
    }
  }, [projectId, captureId, subscriptionId, row.requestId, pending])

  useEffect(() => {
    let cancelled = false
    void window.chorus
      .readTrafficDetail({ projectId, captureId, requestId: row.requestId, subscriptionId })
      .then((result) => {
        // A response for a request that is no longer selected describes
        // somebody else's exchange; it is dropped rather than shown.
        if (cancelled) return
        if (result.kind === 'detail') setDetail(result.detail)
        else setGone(result)
      })
      .catch(() => {
        if (!cancelled) setFailure(true)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, captureId, subscriptionId, row.requestId, pending])

  /*
   * The whole body, in one go, with no control to ask for more.
   *
   * It used to fetch a page and offer a button for the rest, which meant a body
   * was blank until someone pressed it — and the count it printed subtracted a
   * decoded length from an encoded total, so a compressed response offered to
   * load bytes that did not exist. A capture is bounded at a megabyte, so
   * reading all of it costs sixteen round trips at worst.
   */
  const loadWhole = useCallback(
    (side: Side): void => {
      const generation = readGeneration.current
      if (inFlight.current[side] === generation) return
      inFlight.current[side] = generation
      const current = (): boolean => generation === readGeneration.current
      const run = async (): Promise<void> => {
        const parts: Uint8Array[] = []
        let wants: 'encoded' | 'decoded' = 'decoded'
        let offset = 0
        setLoading((state) => ({ ...state, [side]: true }))

        for (let page = 0; page < MAX_BODY_PAGES; page++) {
          if (!current()) return
          const result = await window.chorus.readTrafficBody({
            projectId,
            captureId,
            requestId: row.requestId,
            subscriptionId,
            side,
            representation: wants,
            offset,
            length: BODY_PAGE,
          })
          if (!current()) return
          /*
           * Decoded first, because the encoded bytes of a compressed response
           * are not what anybody opened this tab to read. A body main cannot
           * decode answers `unsupported` rather than bytes, so the encoded form
           * is fetched instead — losing the decode must not lose the body.
           */
          if (result.kind === 'unsupported' && wants === 'decoded') {
            wants = 'encoded'
            parts.length = 0
            offset = 0
            continue
          }
          if (result.kind !== 'page') {
            setGone(result)
            setLoaded((current) => ({ ...current, [side]: true }))
            return
          }
          const part = bytesFromBase64(result.dataBase64)
          if (part.length === 0) break
          parts.push(part)
          offset += part.length
          if (part.length < BODY_PAGE) break
        }

        setChunks((current) => ({ ...current, [side]: parts }))
        setLoaded((current) => ({ ...current, [side]: true }))
      }

      void run()
        .catch(() => {
          if (current()) setFailure(true)
        })
        .finally(() => {
          if (!current()) return
          inFlight.current[side] = null
          setLoading((state) => ({ ...state, [side]: false }))
        })
    },
    [projectId, captureId, row.requestId, subscriptionId]
  )

  useEffect(() => {
    if (detail === null || failure || gone !== null) return
    if (!loaded.request) loadWhole('request')
    if (!loaded.response) loadWhole('response')
  }, [detail, loaded, loadWhole, failure, gone])

  const copy = useCallback((text: string): void => {
    void window.chorus.copyText({ text })
  }, [])

  const requestBytes = useMemo(() => concat(chunks.request), [chunks.request])
  const responseBytes = useMemo(() => concat(chunks.response), [chunks.response])

  const goneReason = gone !== null && gone.kind !== 'detail' ? gone.kind : failure ? 'failed' : null
  const panesOpen = goneReason === null && detail !== null

  useEffect(() => {
    if (panesOpen) return
    flushResize()
    const active = resizing.current
    resizing.current = null
    if (active !== null) setDragging(false)
    if (
      keyboardResizing.current ||
      (active !== null && active.fraction !== bodyLayout.get().fraction)
    ) {
      keyboardResizing.current = false
      saveBodyLayout()
    }
  }, [panesOpen, flushResize])

  const awaitingResponse =
    pending ||
    detail?.responseBody.state === 'pending' ||
    detail?.responseBody.state === 'streaming'

  const requestCurl = useMemo(
    () =>
      detail === null
        ? ''
        : curlCommand({
            method: detail.method,
            url: detail.forwardedUrl === '' ? detail.url : detail.forwardedUrl,
            headers: detail.forwardedHeaders,
            body: textOf(requestBytes),
          }),
    [detail, requestBytes]
  )

  const pairList = (pairs: readonly (readonly [string, string])[]): React.JSX.Element => (
    <dl className="traffic-headers">
      {pairs.map(([name, value], index) => (
        <div className="traffic-header" key={`${name}-${String(index)}`}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )

  const millis = (from: number | null, to: number | null): string =>
    from === null || to === null ? '—' : `${String(to - from)} ms`

  const query = detail === null ? '' : queryStringOf(detail.url)
  const queryRows = (queryEncoded ? encodedFields(query) : formFields(query)).map(
    ([name, value]): readonly [string, string] => [
      name,
      value === '' ? t('traffic.emptyValue') : value,
    ]
  )

  return (
    <section className="traffic-inspector" aria-label={t('traffic.detailTitle')}>
      {layout.failed && (
        <p className="traffic-stopped" role="alert">
          {t('traffic.paneSizesSaveFailed')}
        </p>
      )}

      {goneReason !== null ? (
        <p className="traffic-stopped">{t(`traffic.gone.${goneReason}`)}</p>
      ) : detail === null ? (
        <p className="traffic-stopped">{t('traffic.detailLoading')}</p>
      ) : (
        <div
          className="traffic-panes"
          ref={panesRef}
          style={{
            gridTemplateColumns: `minmax(0, ${String(requestFraction)}fr) 9px minmax(0, ${String(1 - requestFraction)}fr)`,
            gap: 0,
            userSelect: dragging ? 'none' : undefined,
          }}
        >
          <div className="traffic-pane" data-side="request" id={requestPaneId}>
            <h3 className="traffic-label">{t('traffic.tab.request')}</h3>

            {queryRows.length > 0 && (
              <details className="traffic-query" open>
                <summary>
                  {t('traffic.queryParameters')}
                  <button
                    type="button"
                    className="traffic-tab"
                    onClick={(event) => {
                      event.preventDefault()
                      setQuerySource((shown) => !shown)
                    }}
                  >
                    {querySource ? t('traffic.viewParsed') : t('traffic.viewSource')}
                  </button>
                  {!querySource && (
                    <button
                      type="button"
                      className="traffic-tab"
                      onClick={(event) => {
                        event.preventDefault()
                        setQueryEncoded((shown) => !shown)
                      }}
                    >
                      {queryEncoded ? t('traffic.viewDecoded') : t('traffic.viewEncoded')}
                    </button>
                  )}
                </summary>
                {querySource ? (
                  <pre className="traffic-body-text">{query}</pre>
                ) : (
                  pairList(queryRows)
                )}
              </details>
            )}

            {queryRows.length > 0 && detail.requestBody.observedBytes > 0 && (
              <h3 className="traffic-label">{t('traffic.bodyHeading')}</h3>
            )}

            <TrafficBody
              side="request"
              descriptor={detail.requestBody}
              bytes={requestBytes}
              waiting={false}
              loading={loading.request}
              requestCurl={requestCurl}
            />

            <details className="traffic-fold">
              <summary className="traffic-fold-summary">{t('traffic.headersAndTiming')}</summary>
              <div className="traffic-general">
                <p>
                  <span className="traffic-label">{t('traffic.requestSize')}</span>
                  <span>
                    {t('traffic.sizeOf', {
                      kept: detail.requestBody.capturedBytes,
                      seen: detail.requestBody.observedBytes,
                    })}
                  </span>
                </p>
                <p>
                  <span className="traffic-label">{t('traffic.responseSize')}</span>
                  <span>
                    {t('traffic.sizeOf', {
                      kept: detail.responseBody.capturedBytes,
                      seen: detail.responseBody.observedBytes,
                    })}
                  </span>
                </p>
              </div>
              <div className="traffic-headers-view">
                <div className="traffic-body-bar">
                  <button
                    type="button"
                    className="traffic-tab"
                    aria-pressed={reveal}
                    onClick={() => {
                      setReveal((shown) => !shown)
                    }}
                  >
                    {reveal ? t('traffic.hideCredentials') : t('traffic.reveal')}
                  </button>
                  <button
                    type="button"
                    className="traffic-tab"
                    onClick={() => {
                      copy(
                        headerRows(detail.requestHeaders, reveal)
                          .map(([name, value]) => `${name}: ${value}`)
                          .join('\n')
                      )
                    }}
                  >
                    {t('traffic.copy')}
                  </button>
                </div>
                <h3 className="traffic-label">{t('traffic.requestHeaders')}</h3>
                {pairList(headerRows(detail.requestHeaders, reveal))}
                <h3 className="traffic-label">{t('traffic.forwardedHeaders')}</h3>
                {pairList(headerRows(detail.forwardedHeaders, reveal))}
                <h3 className="traffic-label">{t('traffic.responseHeaders')}</h3>
                {pairList(headerRows(detail.responseHeaders, reveal))}
                {detail.trailers.length > 0 && (
                  <>
                    <h3 className="traffic-label">{t('traffic.trailers')}</h3>
                    {pairList(detail.trailers)}
                  </>
                )}
              </div>

              <div className="traffic-general">
                <h3 className="traffic-label">{t('traffic.tab.timing')}</h3>
                <p>
                  <span className="traffic-label">{t('traffic.timingUpstream')}</span>
                  <span>{millis(detail.timing.startedAt, detail.timing.upstreamAt)}</span>
                </p>
                <p>
                  <span className="traffic-label">{t('traffic.timingBody')}</span>
                  <span>{millis(detail.timing.upstreamAt, detail.timing.upstreamDoneAt)}</span>
                </p>
                <p>
                  <span className="traffic-label">{t('traffic.timingTotal')}</span>
                  <span>
                    {millis(
                      detail.timing.startedAt,
                      detail.timing.settledAt ?? detail.timing.upstreamDoneAt
                    )}
                  </span>
                </p>
              </div>
            </details>
          </div>

          <div
            className="conversation-sash"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('traffic.resizePanes')}
            aria-controls={requestPaneId}
            aria-valuemin={MIN_TRAFFIC_REQUEST_FRACTION * 100}
            aria-valuemax={MAX_TRAFFIC_REQUEST_FRACTION * 100}
            aria-valuenow={Math.round(requestFraction * 100)}
            tabIndex={0}
            style={{
              cursor: 'col-resize',
              touchAction: 'none',
              borderLeft: '1px solid var(--border-default)',
            }}
            onPointerDown={startResize}
            onPointerMove={moveResize}
            onPointerUp={finishResize}
            onPointerCancel={finishResize}
            onLostPointerCapture={finishResize}
            onKeyDown={keyResize}
            onKeyUp={finishKeyResize}
            onBlur={finishKeyResize}
          />

          <div className="traffic-pane" data-side="response">
            <h3 className="traffic-label">{t('traffic.tab.response')}</h3>
            {/*
            Above the body rather than inside it, because there is no body for
            these and that is the whole complaint: the pane rendered its empty
            state and the person was left to decide whether the panel was broken
            or the backend was. The reason goes first and the body follows, so a
            socket that died mid-body reads as both — what arrived, and why it
            stopped.
          */}
            {detail.transport !== null && (
              <p className="traffic-stopped">
                {t('traffic.transportFailed', { reason: detail.transport })}
              </p>
            )}
            <TrafficBody
              side="response"
              descriptor={detail.responseBody}
              bytes={responseBytes}
              waiting={awaitingResponse}
              loading={loading.response}
              requestCurl=""
            />
          </div>
        </div>
      )}
    </section>
  )
}
