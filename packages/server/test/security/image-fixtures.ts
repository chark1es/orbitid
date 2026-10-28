/**
 * Minimal, valid one-pixel images used by the upload tests. Each fixture ends with the terminator its
 * format declares, because the sniffer refuses a header followed by a foreign payload.
 */
const chunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, crcBuf]);
};

export const PNG_1X1: Buffer = (() => {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const idat = Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]);
  return Buffer.concat([header, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
})();

/** SOI + a minimal APP0 segment + EOI. */
export const JPEG_1X1: Buffer = Buffer.from([
  0xff, 0xd8,
  0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xd9,
]);

/** GIF89a header, logical screen descriptor, trailer. */
export const GIF_1X1: Buffer = Buffer.from([
  ...Buffer.from("GIF89a", "ascii"),
  0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x3b,
]);

/** RIFF/WEBP container whose declared size matches the file exactly. */
export const WEBP_1X1: Buffer = (() => {
  const payload = Buffer.concat([Buffer.from("WEBPVP8 ", "ascii"), Buffer.alloc(8)]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(payload.length, 4);
  return Buffer.concat([riff, payload]);
})();

export const SVG_PAYLOAD = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

/** A real image header followed by HTML/script: the classic trailing-payload polyglot. */
export const GIF_POLYGLOT = Buffer.concat([GIF_1X1.subarray(0, GIF_1X1.length - 1), Buffer.from('<html><script>alert(1)</script></html>')]);

/** A complete PNG followed by a script payload: refused because the body carries markup. */
export const PNG_WITH_TRAILER = Buffer.concat([PNG_1X1, Buffer.from("<script>alert(1)</script>")]);
