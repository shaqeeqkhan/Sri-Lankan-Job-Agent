/** A minimal PNG encoder (8-bit grey, grey+alpha, RGB or RGBA), so page images need no canvas package. */
import zlib from 'node:zlib';

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

const COLOR_TYPE: Record<number, number> = { 1: 0, 2: 4, 3: 2, 4: 6 };

export function encodePng(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, channels: number): Buffer {
  const colorType = COLOR_TYPE[channels];
  if (colorType === undefined) throw new Error(`Unsupported channel count ${channels}`);
  const stride = width * channels;
  if (pixels.length < stride * height) throw new Error('Pixel buffer is smaller than width × height × channels');
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
