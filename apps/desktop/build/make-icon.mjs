/**
 * Builds `icon.icns` from `icon.svg`. Plain node: `pnpm --filter @chorus/desktop icon`.
 *
 * ## Why this draws the SVG itself
 *
 * It needs a rasteriser that keeps alpha, because everything outside the
 * squircle must be transparent — macOS does not mask app icons, so an opaque
 * corner is a white box behind the tile in the Dock. Two obvious routes were
 * tried and both failed, which is why this file exists rather than a one-line
 * shell-out:
 *
 *   - Electron, the only renderer already in the dependency tree, never reaches
 *     its main script when there is no window server to attach to. `electron
 *     --version` answers; a BrowserWindow hangs. So it cannot run headless, and
 *     an icon that can only be rebuilt on a logged-in desktop is a trap.
 *   - `qlmanage -t` renders SVG correctly but composites onto white. Measured:
 *     the corner pixel of a 1024 thumbnail comes back [255,255,255,255]. The
 *     alpha channel is present and uniformly opaque, so `sips -g hasAlpha` says
 *     "yes" and the file is still wrong.
 *
 * librsvg, ImageMagick and Inkscape are none of them installed, and adding a
 * build dependency to draw one file that changes about never is the worse trade.
 * The drawing is two convex contours, a rounded rectangle and a linear gradient;
 * that is a scanline fill and an inflate away from a PNG.
 *
 * ## What it does NOT do
 *
 * It is not an SVG renderer. It reads exactly the shapes `icon.svg` uses — one
 * rect, one linearGradient, one path of M/C/Z subpaths — and throws on anything
 * else rather than silently drawing something different from what a browser
 * would. If the artwork grows a feature, this has to learn it on purpose.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const BUILD = dirname(fileURLToPath(import.meta.url))
/*
 * The artwork lives with the renderer's other assets rather than here, because
 * it is not only a packaging input: `index.html` loads the same file as the
 * favicon. One file means the icon and the mark in the app cannot drift apart,
 * which they had — the asset this replaced was three serif O's left over from a
 * wordmark that was retired.
 */
const SVG = join(BUILD, '..', 'src', 'renderer', 'src', 'assets', 'chorus-mark.svg')
const ICNS = join(BUILD, 'icon.icns')
const ICO = join(BUILD, 'icon.ico')

/**
 * What Windows asks for, and it is a different list from macOS.
 *
 * 256 is the one electron-builder actually requires and the one Explorer shows
 * at large-icon sizes; the rest are what the taskbar, Alt-Tab and the installer
 * pick from. 1024 is deliberately absent — Windows has no slot for it and the
 * entry would be dead weight in every installer.
 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

/**
 * `iconutil` reads the size out of the filename and rejects the folder if one is
 * missing, so these names are load-bearing. `@2x` is the same pixel count as the
 * next slot up, which is why 32, 256 and 512 each appear twice.
 */
const SLOTS = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]

// ------------------------------------------------------------------ parsing

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`))
  return m === null ? null : m[1]
}
const num = (tag, name) => {
  const raw = attr(tag, name)
  if (raw === null) throw new Error(`icon.svg: <${tag.slice(1, 5)}> is missing ${name}`)
  return Number(raw)
}

function parse(source) {
  // An XML comment may not contain a doubled hyphen. Chromium answers that by
  // replacing the whole drawing with an error page, which rasterises to a
  // perfectly valid PNG of a red error box — so this is checked here, loudly,
  // rather than discovered as a shipped icon.
  const body = source.replace(/<!--[\s\S]*?-->/g, (c) => {
    if (c.slice(4, -3).includes('--')) throw new Error('icon.svg: XML comment contains a doubled hyphen')
    return ''
  })

  const rect = body.match(/<rect\b[^>]*>/)
  const grad = body.match(/<linearGradient\b[^>]*>/)
  const path = body.match(/<path\b[^>]*>/)
  if (rect === null || grad === null || path === null) throw new Error('icon.svg: expected one rect, one linearGradient and one path')

  const stops = [...body.matchAll(/<stop\b[^>]*>/g)].map((s) => {
    const hex = attr(s[0], 'stop-color')
    if (hex === null || !/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`icon.svg: bad stop-color ${String(hex)}`)
    return {
      offset: Number(attr(s[0], 'offset')),
      rgb: [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)),
    }
  })
  if (stops.length < 2) throw new Error('icon.svg: gradient needs at least two stops')

  const fillRule = attr(path[0], 'fill-rule')
  if (fillRule !== 'evenodd') throw new Error('icon.svg: this renderer only implements fill-rule="evenodd"')

  return {
    tile: {
      x: num(rect[0], 'x'),
      y: num(rect[0], 'y'),
      w: num(rect[0], 'width'),
      h: num(rect[0], 'height'),
      r: num(rect[0], 'rx'),
      rgb: [1, 3, 5].map((i) => parseInt(attr(rect[0], 'fill').slice(i, i + 2), 16)),
    },
    gradient: {
      x1: num(grad[0], 'x1'),
      y1: num(grad[0], 'y1'),
      x2: num(grad[0], 'x2'),
      y2: num(grad[0], 'y2'),
      stops,
    },
    contours: flatten(attr(path[0], 'd')),
    size: num(source.match(/<svg\b[^>]*>/)[0], 'width'),
  }
}

/**
 * Turns the path's cubics into polygons.
 *
 * 128 segments per curve is far more than needed and costs nothing: the chord
 * error on a quarter of the outer contour works out around 0.006 user units,
 * which is 1/40th of a sample at the largest size rendered.
 */
function flatten(d) {
  if (d === null) throw new Error('icon.svg: path has no d')
  const tokens = d.trim().split(/[\s,]+/)
  const contours = []
  let points = null
  let cursor = [0, 0]
  for (let i = 0; i < tokens.length; ) {
    const op = tokens[i++]
    if (op === 'M') {
      if (points !== null) contours.push(points)
      cursor = [Number(tokens[i++]), Number(tokens[i++])]
      points = [cursor]
    } else if (op === 'C') {
      const p1 = [Number(tokens[i++]), Number(tokens[i++])]
      const p2 = [Number(tokens[i++]), Number(tokens[i++])]
      const p3 = [Number(tokens[i++]), Number(tokens[i++])]
      for (let s = 1; s <= 128; s++) {
        const t = s / 128
        const u = 1 - t
        points.push([
          u * u * u * cursor[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
          u * u * u * cursor[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
        ])
      }
      cursor = p3
    } else if (op === 'Z') {
      // Closed implicitly: the crossing test wraps the last point to the first.
    } else {
      throw new Error(`icon.svg: this renderer implements M, C and Z only, found "${op}"`)
    }
  }
  if (points !== null) contours.push(points)
  if (contours.length !== 2) throw new Error(`icon.svg: expected an outer contour and a counter, found ${String(contours.length)}`)
  return contours
}

// -------------------------------------------------------------- rasterising

/**
 * Where a horizontal line at `y` enters and leaves a contour.
 *
 * Both contours here are convex, so a scanline meets each exactly twice or not
 * at all; taking the extremes of the crossings is therefore exact, and it is
 * also what keeps this a few lines instead of an active-edge table.
 */
function span(points, y) {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0, n = points.length; i < n; i++) {
    const [ax, ay] = points[i]
    const [bx, by] = points[(i + 1) % n]
    if (ay === by || y < Math.min(ay, by) || y >= Math.max(ay, by)) continue
    const x = ax + ((y - ay) / (by - ay)) * (bx - ax)
    if (x < lo) lo = x
    if (x > hi) hi = x
  }
  return lo > hi ? null : [lo, hi]
}

/** The rounded rectangle, solved per row rather than flattened. */
function tileSpan(tile, y) {
  const { x, y: ty, w, h, r } = tile
  if (y < ty || y >= ty + h) return null
  let inset = 0
  if (y < ty + r) {
    const d = ty + r - y
    inset = r - Math.sqrt(Math.max(0, r * r - d * d))
  } else if (y > ty + h - r) {
    const d = y - (ty + h - r)
    inset = r - Math.sqrt(Math.max(0, r * r - d * d))
  }
  return [x + inset, x + w - inset]
}

/** Stops resolved to a lookup table, interpolated in sRGB exactly as a browser would. */
function rampTable(stops, n = 2048) {
  const table = new Uint8Array(n * 3)
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1)
    let k = 0
    while (k < stops.length - 2 && t > stops[k + 1].offset) k++
    const a = stops[k]
    const b = stops[k + 1]
    const local = b.offset === a.offset ? 0 : (t - a.offset) / (b.offset - a.offset)
    for (let c = 0; c < 3; c++) table[i * 3 + c] = Math.round(a.rgb[c] + (b.rgb[c] - a.rgb[c]) * local)
  }
  return table
}

function render(art, size) {
  // Small sizes get more samples per pixel; they are the ones that decide
  // whether a Dock icon works, and 16px is cheap to supersample heavily.
  const ss = size <= 64 ? 16 : size <= 256 ? 8 : 4
  const scale = art.size / (size * ss)
  const [outer, inner] = art.contours
  const ramp = rampTable(art.gradient.stops)
  const steps = ramp.length / 3 - 1

  const { x1, y1, x2, y2 } = art.gradient
  const gx = x2 - x1
  const gy = y2 - y1
  const glen = gx * gx + gy * gy

  const out = Buffer.alloc(size * size * 4)
  const accR = new Float64Array(size)
  const accG = new Float64Array(size)
  const accB = new Float64Array(size)
  const accA = new Float64Array(size)
  const per = ss * ss

  for (let oy = 0; oy < size; oy++) {
    accR.fill(0)
    accG.fill(0)
    accB.fill(0)
    accA.fill(0)

    for (let sy = 0; sy < ss; sy++) {
      const y = (oy * ss + sy + 0.5) * scale
      const tile = tileSpan(art.tile, y)
      if (tile === null) continue
      const ring = span(outer, y)
      const hole = span(inner, y)

      const from = Math.max(0, Math.floor(tile[0] / scale))
      const to = Math.min(size * ss - 1, Math.ceil(tile[1] / scale))
      for (let sx = from; sx <= to; sx++) {
        const x = (sx + 0.5) * scale
        if (x < tile[0] || x >= tile[1]) continue
        const ox = (sx / ss) | 0

        let r, g, b
        if (ring !== null && x >= ring[0] && x < ring[1] && !(hole !== null && x >= hole[0] && x < hole[1])) {
          const t = Math.min(1, Math.max(0, ((x - x1) * gx + (y - y1) * gy) / glen))
          const i = ((t * steps) | 0) * 3
          r = ramp[i]
          g = ramp[i + 1]
          b = ramp[i + 2]
        } else {
          ;[r, g, b] = art.tile.rgb
        }
        // Premultiplied while accumulating, so an edge that is half tile and
        // half nothing averages to the tile's colour rather than toward black.
        accR[ox] += r
        accG[ox] += g
        accB[ox] += b
        accA[ox] += 1
      }
    }

    for (let ox = 0; ox < size; ox++) {
      const a = accA[ox] / per
      const i = (oy * size + ox) * 4
      out[i + 3] = Math.round(a * 255)
      if (a > 0) {
        out[i] = Math.round(accR[ox] / accA[ox])
        out[i + 1] = Math.round(accG[ox] / accA[ox])
        out[i + 2] = Math.round(accB[ox] / accA[ox])
      }
    }
  }
  return out
}

// ------------------------------------------------------------------ png out

const CRC = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
const crc32 = (buf) => {
  let c = -1
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, tail])
}

function png(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // depth
  ihdr[9] = 6 // truecolour with alpha
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // no per-row filter; deflate does the work
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------- assertions

/**
 * The two failures that actually happened, turned into checks.
 *
 * A broken SVG and a renderer that drops alpha both produce a valid PNG of the
 * right size, so "it wrote a file" proves nothing. These read the pixels.
 */
function verify(rgba, size, art) {
  const at = (x, y) => {
    const i = (y * size + x) * 4
    return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
  }
  const fail = (why) => {
    throw new Error(`icon render is wrong: ${why}`)
  }

  const inset = Math.round(size * 0.02)
  if (at(inset, inset)[3] !== 0) fail(`corner is not transparent (alpha ${String(at(inset, inset)[3])}) — the Dock would show a box`)

  const mid = at(size >> 1, size >> 1)
  if (mid[3] !== 255 || Math.abs(mid[0] - art.tile.rgb[0]) > 2 || Math.abs(mid[2] - art.tile.rgb[2]) > 2) {
    fail(`the counter should be the tile colour, found ${JSON.stringify(mid)}`)
  }

  // Both agents' colours have to survive. Teal is bluer than it is red; amber is
  // the reverse. If the ramp ever muds to grey these cross over.
  const left = at(Math.round(size * 0.318), size >> 1)
  const right = at(Math.round(size * 0.682), size >> 1)
  if (left[2] <= left[0]) fail(`the left of the ring is not teal, found ${JSON.stringify(left)}`)
  if (right[0] <= right[2]) fail(`the right of the ring is not amber, found ${JSON.stringify(right)}`)
}

// ---------------------------------------------------------------------- run


/**
 * An ICO wrapping the same PNGs, rather than a second rasteriser.
 *
 * Windows has accepted PNG-compressed icon entries since Vista, which is well
 * below the Windows 10 floor this release targets, so there is no BMP path here
 * and no palette arithmetic. The alternative — emitting BMP entries with their
 * upside-down rows and separate AND mask — is a second encoder to be wrong in,
 * for an OS nobody is shipping to.
 *
 * The directory is fixed-size and simple: a 6-byte header, then one 16-byte
 * entry per image, then the images themselves.
 */
function ico(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon, 2 would be a cursor
  header.writeUInt16LE(images.length, 4)

  const entries = []
  const bodies = []
  let offset = 6 + images.length * 16

  for (const { size, data } of images) {
    const entry = Buffer.alloc(16)
    // 0 means 256. The field is one byte, so 256 does not fit and this is the
    // format's own escape rather than a trick.
    entry.writeUInt8(size >= 256 ? 0 : size, 0)
    entry.writeUInt8(size >= 256 ? 0 : size, 1)
    entry.writeUInt8(0, 2) // palette size: 0 for truecolour
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel, RGBA
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    bodies.push(data)
    offset += data.length
  }

  return Buffer.concat([header, ...entries, ...bodies])
}

const art = parse(readFileSync(SVG, 'utf8'))
const staging = mkdtempSync(join(tmpdir(), 'chorus-icon-'))
const iconset = join(staging, 'icon.iconset')
mkdirSync(iconset)

try {
  const cache = new Map()
  for (const [name, size] of SLOTS) {
    if (!cache.has(size)) {
      const rgba = render(art, size)
      if (size === 1024) verify(rgba, size, art)
      cache.set(size, png(rgba, size))
    }
    writeFileSync(join(iconset, name), cache.get(size))
  }
  /*
   * `iconutil` is macOS-only, so the .icns half of this script cannot run on a
   * Windows machine. Both icons are committed artifacts rather than build
   * outputs, so that costs nothing day to day — but it does mean this script is
   * a macOS tool, and the .ico is written before it so a future split can keep
   * the portable half.
   */
  const ico_images = ICO_SIZES.map((size) => {
    if (!cache.has(size)) cache.set(size, png(render(art, size), size))
    return { size, data: cache.get(size) }
  })
  writeFileSync(ICO, ico(ico_images))
  console.log(`icon.ico written — ${String(ICO_SIZES.length)} sizes at ${ICO_SIZES.join(', ')}px`)

  execFileSync('iconutil', ['--convert', 'icns', iconset, '--output', ICNS])
  const sizes = [...cache.keys()].sort((a, b) => a - b).join(', ')
  console.log(`icon.icns written from ${basename(SVG)} — ${String(SLOTS.length)} slots at ${sizes}px`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
