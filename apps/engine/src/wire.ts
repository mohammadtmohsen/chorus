import { StringDecoder } from 'node:string_decoder'
import { MAX_FRAME_BYTES } from './protocol.js'

export class FrameReader {
  private buffer = ''
  private readonly decoder = new StringDecoder('utf8')
  constructor(
    private readonly receive: (value: unknown) => void,
    private readonly limit = MAX_FRAME_BYTES
  ) {}
  push(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk)
    let end = this.buffer.indexOf('\n')
    while (end >= 0) {
      const frame = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 1)
      if (Buffer.byteLength(frame) > this.limit) throw new Error('frame-too-large')
      if (frame !== '') this.receive(JSON.parse(frame) as unknown)
      end = this.buffer.indexOf('\n')
    }
    if (Buffer.byteLength(this.buffer) > this.limit) throw new Error('frame-too-large')
  }
}

export function encodeFrame(value: unknown): string {
  const frame = JSON.stringify(value) + '\n'
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new Error('frame-too-large')
  return frame
}
