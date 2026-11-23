// `npm run shots` writes plain RGB PNGs flattened on black (scripts/png.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crc32, deflateSync } from 'node:zlib'
import { decode, flattenOnBlack, pngInfo } from '../scripts/png.ts'

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td) >>> 0)
  return Buffer.concat([len, td, crc])
}

/** A 3×2 RGBA PNG like the simulator's: white RGB everywhere, the picture in alpha; rows use filters 1 and 2. */
function rgbaPng(alpha: number[][]): Buffer {
  const w = alpha[0].length
  const rows: number[] = []
  alpha.forEach((row, y) => {
    const f = y === 0 ? 1 : 2
    rows.push(f)
    row.forEach((a, x) => {
      const px = [255, 255, 255, a]
      for (let k = 0; k < 4; k++) {
        const left = x > 0 ? (k < 3 ? 255 : row[x - 1]) : 0
        const up = y > 0 ? (k < 3 ? 255 : alpha[y - 1][x]) : 0
        rows.push((px[k] - (f === 1 ? left : up) + 256) & 0xff)
      }
    })
  })
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(alpha.length, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('an RGBA screenshot becomes plain RGB on black, same size, same picture', () => {
  const src = rgbaPng([
    [0, 255, 128],
    [255, 0, 64],
  ])
  assert.deepEqual(pngInfo(src), { w: 3, h: 2, depth: 8, colorType: 6 })
  const flat = flattenOnBlack(src)
  assert.deepEqual(pngInfo(flat), { w: 3, h: 2, depth: 8, colorType: 2 })
  const { bpp, px } = decode(flat)
  assert.equal(bpp, 3)
  assert.deepEqual([...px], [0, 0, 0, 255, 255, 255, 128, 128, 128, 255, 255, 255, 0, 0, 0, 64, 64, 64])
  // flattening twice changes nothing
  assert.ok(flattenOnBlack(flat).equals(flat))
})
