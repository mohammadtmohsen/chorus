import { z } from 'zod'
import {
  BROWSER_FRAME_CHANNEL,
  BROWSER_FRAME_MAX,
  type BrowserStreamRequest,
} from '../../desktop/src/shared/browser-ipc.js'
import type { ChromePage } from './chrome-browser-source.js'
import type { EnginePeer } from './peers.js'

const MAX_STREAM_PIXELS = 2_400_000
const HIGH_QUALITY = 70
const LOW_QUALITY = 50
const ScreencastFrame = z.object({
  sessionId: z.number().int(),
  data: z.string(),
  metadata: z.object({ deviceWidth: z.number().positive(), deviceHeight: z.number().positive() }),
})

interface HeldFrame {
  readonly epoch: number
  readonly data: string
  readonly width: number
  readonly height: number
}

interface Subscription {
  readonly peer: EnginePeer
  readonly browserId: string
  readonly instance: string
  readonly generation: number
  readonly visible: boolean
  readonly width: number
  readonly height: number
  readonly scale: number
  credit: number
  serial: number
  held: HeldFrame | null
}

interface Cast {
  page: ChromePage | null
  token: number | null
  geometry: string | null
  quality: number
  running: Promise<void> | null
  dirty: boolean
}

export class BrowserStreams {
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly casts = new Map<string, Cast>()
  private readonly hiddenPeers = new Set<EnginePeer>()
  private readonly epochs = new Map<string, number>()
  private closed = false

  constructor(private readonly active: (browserId: string) => ChromePage | null) {}

  stream(peer: EnginePeer, request: BrowserStreamRequest): void {
    if (this.closed || peer.isGone()) return
    const key = `${peer.id}:${request.browserId}`
    const existing = this.subscriptions.get(key)
    const sameInstance = existing?.instance === request.instance
    if (existing !== undefined && sameInstance && request.generation < existing.generation) return
    if (existing !== undefined && !sameInstance && !request.visible) return
    this.subscriptions.set(key, {
      peer,
      browserId: request.browserId,
      instance: request.instance,
      generation: request.generation,
      visible: request.visible,
      width: request.width,
      height: request.height,
      scale: request.scale,
      credit: 1,
      serial: sameInstance && existing !== undefined ? existing.serial : 0,
      held: null,
    })
    this.schedule(request.browserId)
  }

  ack(peer: EnginePeer, browserId: string, instance: string, generation: number, serial: number): void {
    const subscription = this.subscriptions.get(`${peer.id}:${browserId}`)
    if (
      subscription === undefined ||
      subscription.instance !== instance ||
      subscription.generation !== generation ||
      subscription.serial !== serial
    )
      return
    subscription.credit = 1
    this.deliver(subscription)
  }

  viewVisibility(peer: EnginePeer, visible: boolean): void {
    const wasVisible = !this.hiddenPeers.has(peer)
    if (this.closed || visible === wasVisible) return
    if (visible) this.hiddenPeers.delete(peer)
    else this.hiddenPeers.add(peer)
    for (const subscription of this.subscriptions.values())
      if (subscription.peer === peer) {
        subscription.held = null
        if (visible) subscription.credit = 1
        this.schedule(subscription.browserId)
      }
  }

  release(peer: EnginePeer): void {
    this.hiddenPeers.delete(peer)
    for (const [key, subscription] of this.subscriptions)
      if (subscription.peer === peer) {
        this.subscriptions.delete(key)
        this.schedule(subscription.browserId)
      }
  }

  activeChanged(browserId: string): void {
    this.epochs.set(browserId, (this.epochs.get(browserId) ?? 0) + 1)
    for (const subscription of this.subscriptions.values())
      if (subscription.browserId === browserId) {
        subscription.held = null
        subscription.credit = 1
      }
    this.schedule(browserId)
  }

  frame(browserId: string, page: ChromePage, params: unknown): void {
    const frame = ScreencastFrame.parse(params)
    void page.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined)
    const cast = this.casts.get(browserId)
    if (this.closed || cast?.page !== page || this.active(browserId) !== page) return
    cast.token ??= frame.sessionId
    if (cast.token !== frame.sessionId) return
    if (frame.data.length > BROWSER_FRAME_MAX) {
      if (cast.quality !== LOW_QUALITY) {
        cast.quality = LOW_QUALITY
        cast.geometry = null
        this.schedule(browserId)
      }
      return
    }
    for (const subscription of this.subscriptions.values()) {
      if (subscription.browserId !== browserId || !this.showing(subscription)) continue
      subscription.held = {
        epoch: this.epochs.get(browserId) ?? page.generation,
        data: frame.data,
        width: frame.metadata.deviceWidth,
        height: frame.metadata.deviceHeight,
      }
      this.deliver(subscription)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const cast of this.casts.values()) {
      cast.dirty = false
      if (cast.page !== null)
        void cast.page.send('Page.stopScreencast', {}).catch(() => undefined)
    }
    this.subscriptions.clear()
    this.hiddenPeers.clear()
    this.epochs.clear()
    this.casts.clear()
  }

  private deliver(subscription: Subscription): void {
    if (subscription.credit === 0 || subscription.held === null || !this.showing(subscription)) return
    const held = subscription.held
    subscription.held = null
    subscription.credit = 0
    subscription.serial += 1
    subscription.peer.send(BROWSER_FRAME_CHANNEL, {
      browserId: subscription.browserId,
      instance: subscription.instance,
      generation: subscription.generation,
      epoch: held.epoch,
      serial: subscription.serial,
      data: held.data,
      width: held.width,
      height: held.height,
    })
  }

  private showing(subscription: Subscription): boolean {
    return (
      !this.closed &&
      subscription.visible &&
      !this.hiddenPeers.has(subscription.peer) &&
      !subscription.peer.isGone()
    )
  }

  private schedule(browserId: string): void {
    if (this.closed) return
    const cast: Cast = this.casts.get(browserId) ?? {
      page: null,
      token: null,
      geometry: null,
      quality: HIGH_QUALITY,
      running: null,
      dirty: false,
    }
    this.casts.set(browserId, cast)
    cast.dirty = true
    cast.running ??= this.apply(browserId, cast).catch(() => undefined).finally(() => {
      cast.running = null
      if (cast.dirty && !this.closed) this.schedule(browserId)
    })
  }

  private async apply(browserId: string, cast: Cast): Promise<void> {
    while (cast.dirty && !this.closed) {
      cast.dirty = false
      const page = this.active(browserId)
      const viewer = [...this.subscriptions.values()]
        .filter((subscription) => subscription.browserId === browserId && this.showing(subscription))
        .at(-1)
      const geometry = viewer === undefined || page === null
        ? null
        : `${String(viewer.width)}x${String(viewer.height)}@${String(viewer.scale)}`
      if (cast.page !== null && (cast.page !== page || cast.geometry !== geometry)) {
        await cast.page.send('Page.stopScreencast', {}).catch(() => undefined)
        cast.page = null
        cast.token = null
        cast.geometry = null
      }
      if (this.closed || cast.dirty || page === null || viewer === undefined || geometry === null) continue
      if (cast.page === page && cast.geometry === geometry) continue
      const scale = Math.min(viewer.scale, Math.sqrt(MAX_STREAM_PIXELS / (viewer.width * viewer.height)))
      try {
        await page.send('Emulation.setDeviceMetricsOverride', {
          width: viewer.width,
          height: viewer.height,
          deviceScaleFactor: viewer.scale,
          mobile: false,
        })
        if (this.closed || cast.dirty || this.active(browserId) !== page) continue
        cast.page = page
        cast.geometry = geometry
        cast.token = null
        await page.send('Page.startScreencast', {
          format: 'jpeg',
          quality: cast.quality,
          maxWidth: Math.max(1, Math.floor(viewer.width * scale)),
          maxHeight: Math.max(1, Math.floor(viewer.height * scale)),
        })
      } catch {
        if (cast.page === page)
          await page.send('Page.stopScreencast', {}).catch(() => undefined)
        cast.page = null
        cast.token = null
        cast.geometry = null
      }
    }
  }
}
