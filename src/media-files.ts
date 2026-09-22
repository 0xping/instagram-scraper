import { closeSync, fsyncSync, fstatSync, openSync, readSync, renameSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

/** Publish an already-flushed file and persist its directory entry before SQLite records it as complete. */
export function commitMediaFile(tmp: string, final: string): void {
  renameSync(tmp, final);
  if (process.platform === 'win32') return; // Windows does not support opening directories for fsync this way.
  const fd = openSync(dirname(final), 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// ---- Paths ---------------------------------------------------------------------------------------

const USERNAME = /^[a-z0-9._]{1,30}$/;
const SHORTCODE = /^[A-Za-z0-9_-]{5,64}$/;

/**
 * data/competitors/<username>/posts/<SHORTCODE>/. Both parts are validated against Instagram's own alphabets
 * (never caption text), dot-only names are rejected, and the result is checked to stay inside the data dir.
 */
export function postDir(dataDir: string, username: string, shortcode: string): string {
  if (!USERNAME.test(username) || /^\.+$/.test(username)) throw new Error(`Unsafe username for a path: ${JSON.stringify(username)}`);
  if (!SHORTCODE.test(shortcode)) throw new Error(`Unsafe shortcode for a path: ${JSON.stringify(shortcode)}`);
  const base = resolve(dataDir, 'competitors');
  const dir = resolve(base, username, 'posts', shortcode);
  if (!dir.startsWith(base + sep)) throw new Error(`Path escapes the data directory: ${dir}`);
  return dir;
}

/** 001, 002, … by 0-based carousel position. */
export function itemStem(position: number): string {
  if (!Number.isSafeInteger(position) || position < 0) throw new Error(`Bad media position: ${position}`);
  return String(position + 1).padStart(3, '0');
}

export function relativeToData(dataDir: string, path: string): string {
  return relative(dataDir, path).split(sep).join('/');
}

// ---- Signed URLs ---------------------------------------------------------------------------------

/**
 * Instagram CDN URLs carry `oe`, the signature's expiry as hex Unix seconds. Past it, the CDN refuses the
 * request; the only legitimate fix is a fresh URL from the post page. Returns null when there is no `oe`.
 */
export function urlExpiry(url: string): Date | null {
  try {
    const oe = new URL(url).searchParams.get('oe');
    if (!oe || !/^[0-9a-f]{6,12}$/i.test(oe)) return null;
    return new Date(parseInt(oe, 16) * 1000);
  } catch {
    return null;
  }
}

export function isExpired(url: string, now = new Date(), marginMs = 60_000): boolean {
  const expiry = urlExpiry(url);
  return expiry !== null && expiry.getTime() - marginMs <= now.getTime();
}

// ---- Format checks -------------------------------------------------------------------------------

export type FileFormat = 'jpg' | 'png' | 'webp' | 'gif' | 'mp4' | 'mov' | 'heic' | 'avif';

export interface FileCheck {
  ok: boolean;
  format: FileFormat | null;
  bytes: number;
  reason: string | null;
}

/**
 * Identifies the format from its magic bytes and checks that the file is complete: a JPEG must end with its
 * EOI marker, a PNG with IEND, a WebP's RIFF length must match, and an MP4/MOV/HEIC's top-level boxes must add
 * up to exactly the file size (a truncated download breaks the chain). Reads only the head and a few box
 * headers, so large videos are never loaded into memory.
 */
export function checkMediaFile(path: string): FileCheck {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const read = (offset: number, length: number): Buffer => {
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
      if (buffer.length) readSync(fd, buffer, 0, buffer.length, offset);
      return buffer;
    };
    const fail = (format: FileFormat | null, reason: string): FileCheck => ({ ok: false, format, bytes: size, reason });
    if (size < 64) return fail(null, `file too small (${size} bytes)`);
    const head = read(0, 32);

    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
      // EOI may be followed by a little padding; look for it near the end.
      const tail = read(Math.max(0, size - 64), 64);
      for (let i = tail.length - 2; i >= 0; i -= 1) if (tail[i] === 0xff && tail[i + 1] === 0xd9) return { ok: true, format: 'jpg', bytes: size, reason: null };
      return fail('jpg', 'JPEG is truncated (no end-of-image marker)');
    }
    if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return read(size - 12, 12).subarray(4, 8).toString('latin1') === 'IEND'
        ? { ok: true, format: 'png', bytes: size, reason: null }
        : fail('png', 'PNG is truncated (no IEND chunk)');
    }
    if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') {
      const declared = head.readUInt32LE(4) + 8;
      return declared === size || declared + 1 === size
        ? { ok: true, format: 'webp', bytes: size, reason: null }
        : fail('webp', `WebP size mismatch (header says ${declared}, file has ${size})`);
    }
    if (head.toString('latin1', 0, 4) === 'GIF8') {
      return read(size - 1, 1)[0] === 0x3b ? { ok: true, format: 'gif', bytes: size, reason: null } : fail('gif', 'GIF is truncated');
    }
    if (head.toString('latin1', 4, 8) === 'ftyp') {
      const brand = head.toString('latin1', 8, 12);
      const format: FileFormat = /^(heic|heix|heim|heis|mif1|msf1)$/.test(brand) ? 'heic' : brand === 'avif' ? 'avif' : brand === 'qt  ' ? 'mov' : 'mp4';
      const boxes: string[] = [];
      let offset = 0;
      while (offset < size) {
        const header = read(offset, 16);
        if (header.length < 8) return fail(format, `truncated box header at byte ${offset}`);
        let boxSize = header.readUInt32BE(0);
        const type = header.toString('latin1', 4, 8);
        if (boxSize === 1) {
          if (header.length < 16) return fail(format, `truncated box header at byte ${offset}`);
          boxSize = Number(header.readBigUInt64BE(8));
        } else if (boxSize === 0) {
          boxSize = size - offset; // runs to end of file
        }
        if (boxSize < 8 || !/^[\x20-\x7e]{4}$/.test(type)) return fail(format, `invalid box at byte ${offset}`);
        boxes.push(type);
        offset += boxSize;
      }
      if (offset !== size) return fail(format, `truncated: last box ends at byte ${offset}, file has ${size}`);
      if ((format === 'mp4' || format === 'mov') && !boxes.includes('moov')) return fail(format, 'video has no moov box (incomplete)');
      if ((format === 'mp4' || format === 'mov') && !boxes.includes('mdat')) return fail(format, 'video has no media data');
      return { ok: true, format, bytes: size, reason: null };
    }
    const text = head.toString('utf8').trimStart().toLowerCase();
    if (text.startsWith('<') || text.startsWith('{')) return fail(null, 'received a web page or JSON, not media');
    return fail(null, 'unrecognized file format');
  } finally {
    closeSync(fd);
  }
}

// ---- MP4 probe -----------------------------------------------------------------------------------

export interface VideoProbe {
  durationSeconds: number;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
}

/** moov is metadata only (usually well under 1 MB); refuse absurd sizes instead of loading them. */
const MAX_MOOV_BYTES = 64 * 1024 * 1024;

/**
 * Reads duration (mvhd), frame size (video track tkhd) and which tracks exist (hdlr) straight from the MP4's
 * boxes, with no ffmpeg. Throws when the structure is not a playable MP4.
 */
export function probeMp4(path: string): VideoProbe {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const read = (offset: number, length: number): Buffer => {
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
      if (buffer.length) readSync(fd, buffer, 0, buffer.length, offset);
      return buffer;
    };
    let moov: Buffer | null = null;
    for (let offset = 0; offset < size;) {
      const header = read(offset, 16);
      if (header.length < 8) break;
      let boxSize = header.readUInt32BE(0);
      let headerSize = 8;
      if (boxSize === 1) { boxSize = Number(header.readBigUInt64BE(8)); headerSize = 16; }
      if (boxSize === 0) boxSize = size - offset;
      if (boxSize < headerSize) throw new Error(`invalid box at byte ${offset}`);
      if (header.toString('latin1', 4, 8) === 'moov') {
        if (boxSize > MAX_MOOV_BYTES) throw new Error('moov box is implausibly large');
        moov = read(offset + headerSize, boxSize - headerSize);
        break;
      }
      offset += boxSize;
    }
    if (!moov) throw new Error('no moov box');

    const mvhd = childBoxes(moov).find((b) => b.type === 'mvhd');
    if (!mvhd) throw new Error('no mvhd box');
    const v1 = mvhd.body[0] === 1;
    const timescale = mvhd.body.readUInt32BE(v1 ? 20 : 12);
    const duration = v1 ? Number(mvhd.body.readBigUInt64BE(24)) : mvhd.body.readUInt32BE(16);
    if (!timescale) throw new Error('mvhd timescale is zero');

    const probe: VideoProbe = { durationSeconds: Math.round((duration / timescale) * 1000) / 1000, width: null, height: null, hasVideo: false, hasAudio: false };
    for (const trak of childBoxes(moov).filter((b) => b.type === 'trak')) {
      const children = childBoxes(trak.body);
      const mdia = children.find((b) => b.type === 'mdia');
      const hdlr = mdia && childBoxes(mdia.body).find((b) => b.type === 'hdlr');
      const handler = hdlr?.body.toString('latin1', 8, 12);
      if (handler === 'soun') probe.hasAudio = true;
      if (handler === 'vide') {
        probe.hasVideo = true;
        const tkhd = children.find((b) => b.type === 'tkhd');
        if (tkhd) {
          const at = tkhd.body[0] === 1 ? 88 : 76; // width/height are 16.16 fixed point after the matrix
          if (tkhd.body.length >= at + 8) {
            probe.width = Math.round(tkhd.body.readUInt32BE(at) / 65536) || null;
            probe.height = Math.round(tkhd.body.readUInt32BE(at + 4) / 65536) || null;
          }
        }
      }
    }
    if (!probe.hasVideo) throw new Error('no video track');
    return probe;
  } finally {
    closeSync(fd);
  }
}

function childBoxes(buffer: Buffer): Array<{ type: string; body: Buffer }> {
  const boxes: Array<{ type: string; body: Buffer }> = [];
  for (let offset = 0; offset + 8 <= buffer.length;) {
    let size = buffer.readUInt32BE(offset);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > buffer.length) break;
      size = Number(buffer.readBigUInt64BE(offset + 8));
      headerSize = 16;
    }
    if (size === 0) size = buffer.length - offset;
    if (size < headerSize || offset + size > buffer.length) break;
    boxes.push({ type: buffer.toString('latin1', offset + 4, offset + 8), body: buffer.subarray(offset + headerSize, offset + size) });
    offset += size;
  }
  return boxes;
}
