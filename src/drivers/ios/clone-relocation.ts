import type { TreeRewrite } from "../../ports/index.js";

const WAL_MAGIC = new Set([0x377f0682, 0x377f0683]);
const WAL_HEADER_SIZE = 32;
const WAL_FRAME_HEADER_SIZE = 24;

/** why: a device stores its UDID as UTF-8 text, and as UTF-16LE text in CloudKit's `cloudd_db`. */
const ENCODINGS = ["utf8", "utf16le"] as const;

/**
 * why: A simulator that has booted stores absolute paths to its own device and log folders
 * (symbolic links, plists, JSON, SQLite rows), and `simctl clone` copies them byte for byte. A
 * copy left that way has its daemons read and write the original's folders once it boots. Both
 * folders are named by the UDID, and every UDID has the same length, so replacing `from` with `to`
 * in place keeps each file's length and offsets. A rewritten SQLite write-ahead log has its frame
 * checksums sealed again, or SQLite would drop the transactions after the first changed page.
 */
export function relocationRewrite(from: string, to: string): TreeRewrite {
  if (from.length !== to.length) {
    throw new Error(`cannot point ${to} at itself: UDIDs ${from} and ${to} differ in length`);
  }
  const replacements = ENCODINGS.map(
    (encoding) => [Buffer.from(from, encoding), Buffer.from(to, encoding)] as const,
  );
  return {
    file: (bytes) => {
      if (!replacements.some(([old]) => bytes.includes(old))) return undefined;
      const wal = walReplayedFrames(bytes);
      for (const [old, next] of replacements) {
        for (let at = bytes.indexOf(old); at >= 0; at = bytes.indexOf(old, at + next.length)) {
          next.copy(bytes, at);
        }
      }
      if (wal !== undefined) resealWal(bytes, wal);
      return bytes;
    },
    link: (target) => (target.includes(from) ? target.replaceAll(from, to) : undefined),
    // why: while the screen is locked the host cannot open a file of data-protection class A or B, so whether it names the original is unknown; iOS may delete any `Library/Caches` folder and the copy has not booted, so such a file leaves the copy, and any other fails it.
    unreadable: (relativePath) => {
      const parts = relativePath.split("/");
      return parts.some((part, index) => part === "Library" && parts[index + 1] === "Caches");
    },
  };
}

interface WalFrames {
  readonly pageSize: number;
  readonly bigEndian: boolean;
  readonly frames: readonly number[];
}

function walChecksum(
  bytes: Buffer,
  start: number,
  length: number,
  seed: readonly [number, number],
  bigEndian: boolean,
): [number, number] {
  let [s0, s1] = seed;
  for (let at = start; at < start + length; at += 8) {
    const first = bigEndian ? bytes.readUInt32BE(at) : bytes.readUInt32LE(at);
    const second = bigEndian ? bytes.readUInt32BE(at + 4) : bytes.readUInt32LE(at + 4);
    s0 = (s0 + first + s1) >>> 0;
    s1 = (s1 + second + s0) >>> 0;
  }
  return [s0, s1];
}

/** why: a write-ahead log's header, when its magic and its checksum hold; anything else is not a log to seal again. */
function walHeader(
  bytes: Buffer,
): { readonly bigEndian: boolean; readonly checksum: [number, number] } | undefined {
  if (bytes.length < WAL_HEADER_SIZE || !WAL_MAGIC.has(bytes.readUInt32BE(0))) return undefined;
  const bigEndian = (bytes.readUInt32BE(0) & 1) === 1;
  const checksum = walChecksum(bytes, 0, 24, [0, 0], bigEndian);
  const holds = checksum[0] === bytes.readUInt32BE(24) && checksum[1] === bytes.readUInt32BE(28);
  return holds ? { bigEndian, checksum } : undefined;
}

/** why: the frames SQLite replays are the run whose salts and chained checksums hold; they are read before the bytes change. */
function walReplayedFrames(bytes: Buffer): WalFrames | undefined {
  const header = walHeader(bytes);
  if (header === undefined) return undefined;
  const { bigEndian } = header;
  let { checksum } = header;
  const pageSize = bytes.readUInt32BE(8);
  const frames: number[] = [];
  const frameSize = WAL_FRAME_HEADER_SIZE + pageSize;
  for (let at = WAL_HEADER_SIZE; at + frameSize <= bytes.length; at += frameSize) {
    const salted = bytes.readBigUInt64BE(at + 8) === bytes.readBigUInt64BE(16);
    checksum = walChecksum(bytes, at, 8, checksum, bigEndian);
    checksum = walChecksum(bytes, at + WAL_FRAME_HEADER_SIZE, pageSize, checksum, bigEndian);
    if (
      !salted ||
      checksum[0] !== bytes.readUInt32BE(at + 16) ||
      checksum[1] !== bytes.readUInt32BE(at + 20)
    ) {
      break;
    }
    frames.push(at);
  }
  return { bigEndian, frames, pageSize };
}

/** why: each frame's checksum chains over every earlier frame, so one rewritten page breaks it and every frame after it. */
function resealWal(bytes: Buffer, wal: WalFrames): void {
  let checksum = walChecksum(bytes, 0, 24, [0, 0], wal.bigEndian);
  for (const at of wal.frames) {
    checksum = walChecksum(bytes, at, 8, checksum, wal.bigEndian);
    checksum = walChecksum(
      bytes,
      at + WAL_FRAME_HEADER_SIZE,
      wal.pageSize,
      checksum,
      wal.bigEndian,
    );
    bytes.writeUInt32BE(checksum[0], at + 16);
    bytes.writeUInt32BE(checksum[1], at + 20);
  }
}
