import { deflateRawSync } from 'node:zlib'

/**
 * Just enough ZIP to write a VSIX, without shelling out to `zip`.
 *
 * The build called `execFileSync('zip', ...)`, which exists on macOS and Linux
 * and not on a Windows runner — so the whole packaging pipeline stopped at the
 * extension. Adding a dependency for this was the other option and it is a
 * worse one: a VSIX is an Open Packaging Convention archive with no compression
 * requirement and no encryption, and what follows is the entire format needed
 * to write one.
 *
 * ## Deterministic on purpose
 *
 * The `zip` call carried `-X` to drop macOS's extra attributes, so that two
 * machines building the same tree produced the same bytes. That property is
 * kept here by construction: there are no extra fields, and every entry is
 * stamped with a fixed DOS timestamp rather than the file's mtime. A VSIX whose
 * bytes change with the clock defeats checksum verification for a release, and
 * `chorus-vscode.vsix.version` beside it is the only version anyone reads.
 *
 * The chosen stamp is 1980-01-01 00:00:00, which is the DOS epoch and the
 * smallest legal value.
 */

/** DOS date/time for 1980-01-01 00:00:00 — the epoch, and the smallest legal pair. */
const DOS_TIME = 0
const DOS_DATE = 0x0021

/**
 * CRC-32, which the format requires and Node does not expose.
 *
 * Table-driven because it is computed over every byte of every entry, and the
 * bitwise form is roughly eight times slower for no benefit. `>>> 0` throughout:
 * JavaScript's bitwise operators produce signed 32-bit values, and a negative
 * CRC written into a header is silently the wrong four bytes.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

/**
 * Build a ZIP from `[name, contents]` pairs.
 *
 * Names are used verbatim and must already use forward slashes — the format
 * requires them, and a Windows build joining paths with `\` would produce an
 * archive whose entries VS Code cannot find. `package.mjs` walks the staging
 * directory and is responsible for that; `zipEntriesFrom` below does it.
 *
 * Stores rather than deflates when deflating does not help, which is the
 * ordinary outcome for the small XML and JSON files in a VSIX and avoids
 * writing an entry larger than its input.
 */
export function zip(entries) {
  const locals = []
  const central = []
  let offset = 0

  for (const [name, contents] of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const raw = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8')
    const crc = crc32(raw)

    const deflated = deflateRawSync(raw, { level: 9 })
    const useDeflate = deflated.length < raw.length
    const body = useDeflate ? deflated : raw
    const method = useDeflate ? 8 : 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed: 2.0, which is deflate
    local.writeUInt16LE(0, 6) // no flags: no data descriptor, no encryption
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28) // no extra field — this is what `-X` was for
    locals.push(local, nameBytes, body)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4) // version made by
    entry.writeUInt16LE(20, 6) // version needed
    entry.writeUInt16LE(0, 8)
    entry.writeUInt16LE(method, 10)
    entry.writeUInt16LE(DOS_TIME, 12)
    entry.writeUInt16LE(DOS_DATE, 14)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(body.length, 20)
    entry.writeUInt32LE(raw.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt16LE(0, 30) // extra length
    entry.writeUInt16LE(0, 32) // comment length
    entry.writeUInt16LE(0, 34) // disk number
    entry.writeUInt16LE(0, 36) // internal attributes
    /*
     * External attributes: 0644 in the high 16 bits, which is where Unix mode
     * lives. Zero would leave VS Code's extractor to guess, and some archivers
     * write 0000 files that are then unreadable after extraction.
     */
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBytes)

    offset += local.length + nameBytes.length + body.length
  }

  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4) // this disk
  end.writeUInt16LE(0, 6) // disk with the directory
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20) // no archive comment

  return Buffer.concat([...locals, directory, end])
}
