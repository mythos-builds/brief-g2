// PNG helpers for `npm run shots`, Node only, no dependency. The simulator's glasses screenshot is RGBA with the
// picture in the alpha channel; a README or a video shows it as a blank or checkered box. `flattenOnBlack` composites
// it on black and writes plain 8-bit RGB (colour type 2), so it shows the same everywhere.
import { crc32, deflateSync, inflateSync } from 'node:zlib'

const SIG = Buffer.from('89504e470d0a1a0a', 'hex')

export interface PngInfo {
  w: number
  h: number
  depth: number
  colorType: number // 2 = RGB, 6 = RGBA
}

export function pngInfo(buf: Buffer): PngInfo {
  if (!buf.subarray(0, 8).equals(SIG) || buf.subarray(12, 16).toString('ascii') !== 'IHDR') throw new Error('not a PNG')
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), depth: buf[24], colorType: buf[25] }
}

function chunks(buf: Buffer): { type: string; data: Buffer }[] {
  const out: { type: string; data: Buffer }[] = []
  let p = 8
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.subarray(p + 4, p + 8).toString('ascii')
    out.push({ type, data: buf.subarray(p + 8, p + 8 + len) })
    p += 12 + len
  }
  return out
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Decoded 8-bit pixels, `bpp` bytes each (3 = RGB, 4 = RGBA). Non-interlaced 8-bit RGB / RGBA only. */
export function decode(buf: Buffer): { info: PngInfo; bpp: number; px: Buffer } {
  const info = pngInfo(buf)
  const ihdr = chunks(buf)[0].data
  if (info.depth !== 8 || (info.colorType !== 2 && info.colorType !== 6) || ihdr[12] !== 0)
    throw new Error(`unsupported PNG: depth ${info.depth}, colour type ${info.colorType}, interlace ${ihdr[12]}`)
  const bpp = info.colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(chunks(buf).filter((c) => c.type === 'IDAT').map((c) => c.data)))
  const stride = info.w * bpp
  const px = Buffer.alloc(stride * info.h)
  for (let y = 0; y < info.h; y++) {
    const f = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const row = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp] : 0
      const b = y > 0 ? px[row - stride + x] : 0
      const c = x >= bpp && y > 0 ? px[row - stride + x - bpp] : 0
      const v = src[x]
      px[row + x] = (f === 0 ? v : f === 1 ? v + a : f === 2 ? v + b : f === 3 ? v + ((a + b) >> 1) : v + paeth(a, b, c)) & 0xff
    }
  }
  return { info, bpp, px }
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td) >>> 0)
  return Buffer.concat([len, td, crc])
}

/** RGBA (or RGB) PNG → the same picture composited on black, as plain 8-bit RGB. */
export function flattenOnBlack(buf: Buffer): Buffer {
  const { info, bpp, px } = decode(buf)
  const stride = info.w * 3
  const raw = Buffer.alloc((stride + 1) * info.h)
  for (let y = 0; y < info.h; y++) {
    raw[y * (stride + 1)] = 0
    for (let x = 0; x < info.w; x++) {
      const s = (y * info.w + x) * bpp
      const alpha = bpp === 4 ? px[s + 3] : 255
      for (let k = 0; k < 3; k++) raw[y * (stride + 1) + 1 + x * 3 + k] = Math.round((px[s + k] * alpha) / 255)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(info.w, 0)
  ihdr.writeUInt32BE(info.h, 4)
  ihdr[8] = 8 // depth
  ihdr[9] = 2 // RGB
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
