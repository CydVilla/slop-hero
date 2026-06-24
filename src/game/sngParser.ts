/**
 * Clone Hero `.sng` container parser.
 *
 * `.sng` (SNGPKG) is a single-file binary archive bundling a song's files
 * (notes.chart/notes.mid, audio, art) plus song metadata. File bytes are
 * position-masked with a per-file XOR scheme. Spec:
 *   https://github.com/mdsitton/SngFileFormat
 *
 * Layout (all integers little-endian):
 *   header:   "SNGPKG" (6) · version uint32 · xorMask byte[16]
 *   metadata: sectionLen uint64 · count uint64 · [int32 keyLen, key,
 *                                                  int32 valLen, val] *
 *   index:    sectionLen uint64 · count uint64 · [uint8 nameLen, name,
 *                                                  uint64 contentLen,
 *                                                  uint64 contentOffset] *
 *   data:     sectionLen uint64 · masked file bytes (at the absolute offsets)
 *
 * Unmask: byte[i] ^= xorMask[i % 16] ^ (i & 0xFF), where i is the index within
 * that file's contents.
 *
 * Pure (no DOM). Note: song.ini is NOT a packed file — its info lives in the
 * metadata section.
 */

const IDENTIFIER = "SNGPKG";

export interface SngPackage {
  version: number;
  metadata: Map<string, string>;
  /** Unmasked file contents keyed by their (original) filename. */
  files: Map<string, Uint8Array>;
}

function ascii(bytes: Uint8Array, off: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[off + i]!);
  return s;
}

function unmask(
  bytes: Uint8Array,
  offset: number,
  length: number,
  xorMask: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const key = xorMask[i % 16]! ^ (i & 0xff);
    out[i] = bytes[offset + i]! ^ key;
  }
  return out;
}

/** Parse a .sng archive into its metadata + unmasked files. */
export function parseSng(buffer: ArrayBuffer): SngPackage {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const decoder = new TextDecoder();

  if (ascii(bytes, 0, 6) !== IDENTIFIER) {
    throw new Error("Not a valid .sng file (missing SNGPKG header).");
  }

  let p = 6;
  const version = view.getUint32(p, true);
  p += 4;
  const xorMask = bytes.subarray(p, p + 16);
  p += 16;

  // Metadata section.
  const metaLen = Number(view.getBigUint64(p, true));
  p += 8;
  const metaStart = p;
  const metaCount = Number(view.getBigUint64(p, true));
  p += 8;
  const metadata = new Map<string, string>();
  for (let i = 0; i < metaCount; i++) {
    const keyLen = view.getInt32(p, true);
    p += 4;
    const key = decoder.decode(bytes.subarray(p, p + keyLen));
    p += keyLen;
    const valLen = view.getInt32(p, true);
    p += 4;
    const value = decoder.decode(bytes.subarray(p, p + valLen));
    p += valLen;
    metadata.set(key, value);
  }
  p = metaStart + metaLen; // resync to the declared section end

  // File index section.
  const indexLen = Number(view.getBigUint64(p, true));
  p += 8;
  const indexStart = p;
  const fileCount = Number(view.getBigUint64(p, true));
  p += 8;
  const index: { name: string; length: number; offset: number }[] = [];
  for (let i = 0; i < fileCount; i++) {
    const nameLen = view.getUint8(p);
    p += 1;
    const name = decoder.decode(bytes.subarray(p, p + nameLen));
    p += nameLen;
    const length = Number(view.getBigUint64(p, true));
    p += 8;
    const offset = Number(view.getBigUint64(p, true));
    p += 8;
    index.push({ name, length, offset });
  }
  p = indexStart + indexLen;

  // File data: offsets are absolute into the archive, so just unmask in place.
  const files = new Map<string, Uint8Array>();
  for (const f of index) {
    files.set(f.name, unmask(bytes, f.offset, f.length, xorMask));
  }

  return { version, metadata, files };
}
