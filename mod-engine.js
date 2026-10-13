/* ═══════════════════════════════════════════════════════════════════
   ROM Player by Coops — Mod Engine
   ───────────────────────────────────────────────────────────────────
   Pure, DOM-free logic behind the per-game Mod Loader. Lives in its own
   file (not inline in index.html) for one reason: it can be loaded
   straight into Node and tested against an independent reference patcher
   (see test/mod-engine.test.mjs). Everything that touches the page —
   IndexedDB, the Mod Loader sheet, launch() wiring — stays in index.html.

   WHAT A "MOD" IS HERE
   • Patch  — an IPS (incl. IPS32/EBP), BPS, UPS, xdelta/VCDIFF, PPF or N64 APS
              file (ROM hacks, fan translations, bug fixes, QoL patches). Applied IN MEMORY at launch time to a
              copy of the library ROM. The ROM stored in OPFS is never
              written to, so turning a mod off is always a clean revert and
              there is nothing to "restore".
   • Cheats — description + code pairs handed to EmulatorJS (EJS_cheats).

   WHAT IS DELIBERATELY NOT HERE
   • RUP, GBA-style APS, and xdelta files that use SECONDARY compression
     (LZMA/FGK/DJW — xdelta3's default on some builds): detectFormat() still
     names them so the UI can say exactly what's unsupported instead of the
     generic "not a patch file". Better an honest refusal than a silent
     mis-apply that corrupts a ROM.
   • Texture packs / engine-level mods: EmulatorJS cores don't expose a
     file-replacement layer, so there is nothing sound to hook.

   VERIFICATION POLICY
   BPS and UPS carry CRC32s of the source ROM, the target ROM and the patch
   itself; we check all three and refuse to launch a "patched" ROM whose
   CRCs don't match, because a patch applied to the wrong dump (wrong
   region/revision/header) produces garbage that looks like an emulator
   bug. IPS carries no checksums at all, so for IPS the best we can do is
   apply it to the most likely ROM variant (see romVariants()) and say so.
═══════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CoopsModEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── errors ─────────────────────────────────────────────────────── */
  // `code` is machine-readable so the UI can pick wording/icons without
  // string-matching messages; `message` is already user-presentable.
  class ModError extends Error {
    constructor(code, message, extra) {
      super(message);
      this.name = 'ModError';
      this.code = code;
      if (extra) Object.assign(this, extra);
    }
  }

  // Sanity ceilings. A corrupt/hostile patch can claim a multi-GB target
  // size; without a cap, `new Uint8Array(size)` would take the whole tab
  // down before any CRC check had a chance to reject the file.
  const MAX_PATCH_BYTES = 128 * 1024 * 1024;
  const MAX_TARGET_BYTES = 1024 * 1024 * 1024;
  const MAX_ROM_PATCHABLE = 768 * 1024 * 1024; // see applyChain() — covers a full CD image; bigger would not fit in a tab alongside the copy

  /* ── CRC32 ──────────────────────────────────────────────────────── */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8, start, end) {
    let c = 0xFFFFFFFF;
    const s = start || 0, e = end === undefined ? u8.length : end;
    for (let i = s; i < e; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  const hex8 = n => (n >>> 0).toString(16).padStart(8, '0');

  function readU32LE(u8, o) {
    return ((u8[o]) | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0;
  }

  /* ── format detection ───────────────────────────────────────────── */
  function startsWith(u8, str) {
    if (u8.length < str.length) return false;
    for (let i = 0; i < str.length; i++) if (u8[i] !== str.charCodeAt(i)) return false;
    return true;
  }

  function detectFormat(u8) {
    if (startsWith(u8, 'PATCH') || startsWith(u8, 'IPS32')) return 'ips';
    if (startsWith(u8, 'BPS1')) return 'bps';
    if (startsWith(u8, 'UPS1')) return 'ups';
    if (u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4B && (u8[2] === 3 || u8[2] === 5)) return 'zip';
    if (u8.length >= 4 && u8[0] === 0xD6 && u8[1] === 0xC3 && u8[2] === 0xC4) return 'xdelta';
    if (/^PPF[123]/.test(String.fromCharCode(u8[0] || 0, u8[1] || 0, u8[2] || 0, u8[3] || 0))) return 'ppf';
    if (startsWith(u8, 'APS10')) return 'aps';       // N64 APS
    if (startsWith(u8, 'APS')) return 'aps-gba';     // other APS dialect — named, not supported
    if (startsWith(u8, 'RUP9')) return 'rup';
    return 'unknown';
  }

  const FORMAT_NAMES = { ips: 'IPS', bps: 'BPS', ups: 'UPS', zip: 'ZIP', xdelta: 'xdelta', ppf: 'PPF', aps: 'APS', 'aps-gba': 'APS (GBA)', rup: 'RUP', unknown: 'Unknown' };
  const SUPPORTED = ['ips', 'bps', 'ups', 'xdelta', 'ppf', 'aps'];

  /* ── varint (shared by BPS + UPS) ───────────────────────────────── */
  // Uses multiplication rather than `<<` so values past 2^31 stay exact
  // (a 512 MB target size is representable; JS bit-shifts would wrap).
  function makeReader(u8, pos, end) {
    return {
      pos,
      end,
      byte() {
        if (this.pos >= this.end) throw new ModError('corrupt', 'The patch file is truncated or corrupt.');
        return u8[this.pos++];
      },
      varint() {
        let data = 0, shift = 1;
        for (let guard = 0; guard < 10; guard++) {
          const x = this.byte();
          data += (x & 0x7F) * shift;
          if (x & 0x80) return data;
          shift *= 128;
          data += shift;
        }
        throw new ModError('corrupt', 'The patch file is corrupt (bad length field).');
      },
    };
  }

  /* ── IPS ────────────────────────────────────────────────────────── */
  function parseIPS(p) {
    const recs = [];
    // IPS32 is the same format with 4-byte offsets and an "EEOF" terminator, used
    // when a hack needs addresses past IPS's 16 MB ceiling (big GBA/NDS/N64/disc hacks).
    const wide = startsWith(p, 'IPS32');
    const OW = wide ? 4 : 3;
    let pos = wide ? 5 : 5, maxEnd = 0, truncate = -1;
    const EOF = wide ? 0x45454F46 : 0x454F46; // "EOF" / "EEOF" read as a big-endian offset
    const rdOff = i => wide ? (p[i] * 16777216 + ((p[i + 1] << 16) | (p[i + 2] << 8) | p[i + 3])) : ((p[i] << 16) | (p[i + 1] << 8) | p[i + 2]);
    while (true) {
      if (pos + OW > p.length) {
        // Plenty of real-world IPS files are missing the EOF marker. Treat
        // end-of-file at a record boundary as a clean end rather than
        // rejecting an otherwise perfectly good patch.
        if (pos === p.length) break;
        throw new ModError('corrupt', 'The IPS file is truncated.');
      }
      const off = rdOff(pos);
      pos += OW;
      if (off === EOF) {
        const rest = p.length - pos;
        // EBP (EarthBound Patch) = IPS + a JSON metadata blob after the terminator.
        if (rest > 0 && p[pos] === 0x7B) break;
        // "EOF" bytes can also be a legitimate record offset (0x454F46 is a
        // valid ROM address). A true terminator is followed by nothing, or
        // by exactly a 3-byte truncation length (Lunar IPS extension).
        if (rest === 0) break;
        if (rest === OW) { truncate = rdOff(pos); break; }
      }
      if (pos + 2 > p.length) throw new ModError('corrupt', 'The IPS file is truncated.');
      const size = (p[pos] << 8) | p[pos + 1];
      pos += 2;
      if (size === 0) {
        if (pos + 3 > p.length) throw new ModError('corrupt', 'The IPS file is truncated.');
        const rle = (p[pos] << 8) | p[pos + 1];
        const val = p[pos + 2];
        pos += 3;
        recs.push({ off, len: rle, rle: val });
        if (off + rle > maxEnd) maxEnd = off + rle;
      } else {
        if (pos + size > p.length) throw new ModError('corrupt', 'The IPS file is truncated.');
        recs.push({ off, len: size, at: pos });
        pos += size;
        if (off + size > maxEnd) maxEnd = off + size;
      }
    }
    return { recs, maxEnd, truncate };
  }

  function applyIPS(rom, p) {
    const { recs, maxEnd, truncate } = parseIPS(p);
    // Final size is decided up-front so we allocate exactly once. IPS may
    // extend the ROM (records past the old end) — SNES/GBA expansion hacks
    // rely on this — and Lunar IPS may truncate it.
    let size = Math.max(rom.length, maxEnd);
    if (truncate >= 0) size = truncate;
    if (size > MAX_TARGET_BYTES) throw new ModError('too-large', 'This patch would produce an unreasonably large ROM.');
    const out = new Uint8Array(size);
    out.set(size >= rom.length ? rom : rom.subarray(0, size));
    for (const r of recs) {
      if (r.off >= size) continue; // record entirely past a truncation point
      const len = Math.min(r.len, size - r.off);
      if (r.rle !== undefined) out.fill(r.rle, r.off, r.off + len);
      else out.set(p.subarray(r.at, r.at + len), r.off);
    }
    return out;
  }

  /* ── shared: the patch's own trailing CRC ─────────────────────── */
  // BPS and UPS both end with CRC32(patch minus these last 4 bytes). It is
  // checked BEFORE the header is parsed: a single flipped bit in the header
  // would otherwise surface as an opaque "corrupt length field" instead of
  // the accurate, actionable "this download is damaged".
  function assertPatchCrc(p, label) {
    if (p.length < 16) throw new ModError('corrupt', 'The ' + label + ' file is truncated.');
    if (crc32(p, 0, p.length - 4) !== readU32LE(p, p.length - 4)) {
      throw new ModError('patch-crc', 'This ' + label + ' file is damaged (its own checksum doesn\'t match). Try downloading it again.');
    }
  }

  /* ── BPS ────────────────────────────────────────────────────────── */
  function parseBPSHeader(p) {
    if (p.length < 4 + 3 + 12) throw new ModError('corrupt', 'The BPS file is truncated.');
    const footer = p.length - 12;
    const r = makeReader(p, 4, footer);
    const sourceSize = r.varint();
    const targetSize = r.varint();
    const metaSize = r.varint();
    if (r.pos + metaSize > footer) throw new ModError('corrupt', 'The BPS file is corrupt (bad metadata length).');
    const metaStart = r.pos;
    r.pos += metaSize;
    return {
      sourceSize, targetSize, metaStart, metaSize,
      actionsStart: r.pos, footer,
      sourceCrc: readU32LE(p, footer),
      targetCrc: readU32LE(p, footer + 4),
      patchCrc: readU32LE(p, footer + 8),
    };
  }

  function applyBPS(rom, p) {
    assertPatchCrc(p, 'BPS');
    const h = parseBPSHeader(p);
    if (h.targetSize > MAX_TARGET_BYTES) throw new ModError('too-large', 'This patch would produce an unreasonably large ROM.');
    const out = new Uint8Array(h.targetSize);
    const r = makeReader(p, h.actionsStart, h.footer);
    let outPos = 0, srcRel = 0, tgtRel = 0;
    while (r.pos < h.footer) {
      const cmd = r.varint();
      const action = cmd % 4;
      const len = Math.floor(cmd / 4) + 1;
      if (outPos + len > h.targetSize) throw new ModError('corrupt', 'The BPS file is corrupt (writes past the end of the ROM).');
      switch (action) {
        case 0: // SourceRead: same offset in the source ROM
          if (outPos + len > rom.length) throw new ModError('corrupt', 'The BPS file reads past the end of the source ROM.');
          out.set(rom.subarray(outPos, outPos + len), outPos);
          outPos += len;
          break;
        case 1: // TargetRead: literal bytes stored in the patch
          if (r.pos + len > h.footer) throw new ModError('corrupt', 'The BPS file is truncated.');
          out.set(p.subarray(r.pos, r.pos + len), outPos);
          r.pos += len; outPos += len;
          break;
        case 2: { // SourceCopy: relative seek in source, then copy
          const d = r.varint();
          srcRel += (d % 2 ? -1 : 1) * Math.floor(d / 2);
          if (srcRel < 0 || srcRel + len > rom.length) throw new ModError('corrupt', 'The BPS file reads outside the source ROM.');
          out.set(rom.subarray(srcRel, srcRel + len), outPos);
          srcRel += len; outPos += len;
          break;
        }
        default: { // TargetCopy: relative seek in the OUTPUT, byte-by-byte
          // Must be a forward byte loop, not out.copyWithin(): TargetCopy is
          // how BPS expresses run-length fills (copy from 1 byte behind),
          // which only works if each byte can read what the previous
          // iteration just wrote.
          const d = r.varint();
          tgtRel += (d % 2 ? -1 : 1) * Math.floor(d / 2);
          if (tgtRel < 0 || tgtRel >= outPos) throw new ModError('corrupt', 'The BPS file is corrupt (bad self-reference).');
          for (let i = 0; i < len; i++) out[outPos++] = out[tgtRel++];
        }
      }
    }
    if (outPos !== h.targetSize) throw new ModError('corrupt', 'The BPS file is corrupt (output size mismatch).');
    if (crc32(out) !== h.targetCrc) {
      throw new ModError('target-crc', 'The patched ROM failed its checksum, so it was not used. The patch may be for a different version of this game.');
    }
    return out;
  }

  /* ── UPS ────────────────────────────────────────────────────────── */
  function parseUPSHeader(p) {
    if (p.length < 4 + 2 + 12) throw new ModError('corrupt', 'The UPS file is truncated.');
    const footer = p.length - 12;
    const r = makeReader(p, 4, footer);
    const inSize = r.varint();
    const outSize = r.varint();
    return {
      inSize, outSize, bodyStart: r.pos, footer,
      sourceCrc: readU32LE(p, footer),
      targetCrc: readU32LE(p, footer + 4),
      patchCrc: readU32LE(p, footer + 8),
    };
  }

  function applyUPS(rom, p) {
    assertPatchCrc(p, 'UPS');
    const h = parseUPSHeader(p);
    if (Math.max(h.inSize, h.outSize) > MAX_TARGET_BYTES) throw new ModError('too-large', 'This patch would produce an unreasonably large ROM.');
    // UPS is XOR-based and therefore symmetric: the same file can turn the
    // patched ROM back into the original. We only ever want the forward
    // direction, so a ROM that matches the OUTPUT size/CRC is reported as
    // "already patched" instead of being XORed back to vanilla.
    if (rom.length === h.outSize && h.outSize !== h.inSize && crc32(rom) === h.targetCrc) {
      throw new ModError('already-patched', 'This ROM already looks patched.');
    }
    const outLen = Math.max(h.inSize, h.outSize);
    const buf = new Uint8Array(outLen);
    buf.set(rom.subarray(0, Math.min(rom.length, outLen)));
    const r = makeReader(p, h.bodyStart, h.footer);
    let pos = 0;
    while (r.pos < h.footer) {
      pos += r.varint();
      while (true) {
        const x = r.byte();
        if (x === 0) { pos++; break; }
        if (pos < buf.length) buf[pos] ^= x;
        pos++;
      }
    }
    const out = buf.subarray(0, h.outSize).slice();
    if (crc32(out) !== h.targetCrc) {
      throw new ModError('target-crc', 'The patched ROM failed its checksum, so it was not used. The patch may be for a different version of this game.');
    }
    return out;
  }


  /* ── VCDIFF / xdelta (RFC 3284) ─────────────────────────────────── */
  // The dominant format for big hacks (N64, GBA, NDS, PS1 …). Implemented from
  // the RFC: default code table, near/same address caches, ADD/RUN/COPY, source
  // and target windows, plus xdelta3's Adler-32 window checksum extension.
  // NOT supported: secondary compression (headers/delta-indicators say so) and
  // custom code tables — refused up front with a message telling the author how
  // to re-export (`xdelta3 -S none`).
  const VCD_TABLE = (() => {
    const T = [], NOOP = 0, ADD = 1, RUN = 2, COPY = 3;
    T.push([RUN, 0, 0, NOOP, 0, 0]);
    T.push([ADD, 0, 0, NOOP, 0, 0]);
    for (let s = 1; s <= 17; s++) T.push([ADD, s, 0, NOOP, 0, 0]);
    for (let m = 0; m < 9; m++) { T.push([COPY, 0, m, NOOP, 0, 0]); for (let s = 4; s <= 18; s++) T.push([COPY, s, m, NOOP, 0, 0]); }
    for (const cs of [4, 5, 6]) for (let m = 0; m < 6; m++) for (let a = 1; a <= 4; a++) T.push([ADD, a, 0, COPY, cs, m]);
    for (let m = 6; m < 9; m++) for (let a = 1; a <= 4; a++) T.push([ADD, a, 0, COPY, 4, m]);
    for (let m = 0; m < 9; m++) T.push([COPY, 4, m, ADD, 1, 0]);
    return T; // 256 entries
  })();

  function adler32(u8) {
    let a = 1, b = 0;
    for (let i = 0; i < u8.length; i++) { a = (a + u8[i]) % 65521; b = (b + a) % 65521; }
    return ((b << 16) | a) >>> 0;
  }

  // Big-endian base-128 integer (VCDIFF's, which is the OPPOSITE order to BPS's).
  function vcdInt(r) {
    let v = 0;
    for (let g = 0; g < 9; g++) {
      const b = r.byte();
      v = v * 128 + (b & 0x7F);
      if (!(b & 0x80)) return v;
    }
    throw new ModError('corrupt', 'The xdelta file is corrupt (bad number).');
  }

  const XD_SECONDARY = () => new ModError('unsupported',
    'This xdelta patch uses extra (secondary) compression, which isn\'t supported yet. If you made it, re-create it with "xdelta3 -S none".');

  // Walks the container without decoding; shared by describePatch() and apply.
  function scanVCDIFF(p) {
    if (p.length < 8 || p[3] !== 0) throw new ModError('corrupt', 'The xdelta file is corrupt or an unsupported version.');
    const r = makeReader(p, 4, p.length);
    const hdr = r.byte();
    if (hdr & 1) throw XD_SECONDARY();
    if (hdr & 2) throw new ModError('unsupported', 'This xdelta patch uses a custom code table, which isn\'t supported.');
    if (hdr & 4) { const n = vcdInt(r); if (r.pos + n > p.length) throw new ModError('corrupt', 'The xdelta file is truncated.'); r.pos += n; }
    const windows = [];
    let total = 0, srcEnd = 0, adler = true;
    while (r.pos < p.length) {
      const win = r.byte(), w = { win };
      if (win & 3) { w.sSize = vcdInt(r); w.sPos = vcdInt(r); if (win & 1) srcEnd = Math.max(srcEnd, w.sPos + w.sSize); }
      const dLen = vcdInt(r); const wEnd = r.pos + dLen;
      if (wEnd > p.length) throw new ModError('corrupt', 'The xdelta file is truncated.');
      w.tLen = vcdInt(r);
      if (r.byte() !== 0) throw XD_SECONDARY();
      w.dataLen = vcdInt(r); w.instLen = vcdInt(r); w.addrLen = vcdInt(r);
      if (win & 4) { w.adler = ((r.byte() * 16777216) + (r.byte() << 16) + (r.byte() << 8) + r.byte()) >>> 0; } else adler = false;
      w.dataAt = r.pos; w.instAt = w.dataAt + w.dataLen; w.addrAt = w.instAt + w.instLen;
      if (w.addrAt + w.addrLen !== wEnd) throw new ModError('corrupt', 'The xdelta file is corrupt (section sizes disagree).');
      r.pos = wEnd; total += w.tLen;
      if (total > MAX_TARGET_BYTES) throw new ModError('too-large', 'This patch would produce an unreasonably large ROM.');
      windows.push(w);
    }
    if (!windows.length) throw new ModError('corrupt', 'The xdelta file contains no data.');
    return { windows, total, srcEnd, adler };
  }

  function applyVCDIFF(rom, p) {
    const sc = scanVCDIFF(p);
    if (sc.srcEnd > rom.length) {
      throw new ModError('source-mismatch', 'This patch needs a bigger source ROM than yours (' + fmtBig(sc.srcEnd) + ' vs ' + fmtBig(rom.length) + ') — it was made for a different version.', { expected: sc.srcEnd, actual: rom.length });
    }
    const out = new Uint8Array(sc.total);
    let outPos = 0;
    for (const w of sc.windows) {
      let src = null;
      if (w.win & 1) src = rom.subarray(w.sPos, w.sPos + w.sSize);
      else if (w.win & 2) {
        if (w.sPos + w.sSize > outPos) throw new ModError('corrupt', 'The xdelta file is corrupt (bad target-window reference).');
        src = out.subarray(w.sPos, w.sPos + w.sSize);
      }
      const S = src ? src.length : 0;
      const T = out.subarray(outPos, outPos + w.tLen);
      const data = p.subarray(w.dataAt, w.instAt), inst = p.subarray(w.instAt, w.addrAt), addr = p.subarray(w.addrAt, w.addrAt + w.addrLen);
      const ir = makeReader(inst, 0, inst.length), ar = makeReader(addr, 0, addr.length);
      let dPos = 0, tPos = 0, nslot = 0;
      const near = [0, 0, 0, 0], same = new Array(768).fill(0);
      const exec = (type, size, mode) => {
        if (type === 0) return;
        if (size === 0) size = vcdInt(ir);
        if (tPos + size > w.tLen) throw new ModError('corrupt', 'The xdelta file is corrupt (writes past the window).');
        if (type === 1) { // ADD
          if (dPos + size > data.length) throw new ModError('corrupt', 'The xdelta file is truncated.');
          T.set(data.subarray(dPos, dPos + size), tPos); dPos += size; tPos += size;
        } else if (type === 2) { // RUN
          if (dPos >= data.length) throw new ModError('corrupt', 'The xdelta file is truncated.');
          T.fill(data[dPos++], tPos, tPos + size); tPos += size;
        } else { // COPY
          const here = S + tPos;
          let a;
          if (mode === 0) a = vcdInt(ar);
          else if (mode === 1) a = here - vcdInt(ar);
          else if (mode < 6) a = near[mode - 2] + vcdInt(ar);
          else a = same[(mode - 6) * 256 + ar.byte()];
          near[nslot] = a; nslot = (nslot + 1) & 3; same[a % 768] = a;
          if (a < 0 || a >= here) throw new ModError('corrupt', 'The xdelta file is corrupt (bad copy address).');
          if (a + size <= S) { T.set(src.subarray(a, a + size), tPos); tPos += size; } // fast path: wholly in source
          else for (let i = 0; i < size; i++, a++) T[tPos++] = a < S ? src[a] : T[a - S]; // may overlap itself → byte loop
        }
      };
      while (ir.pos < inst.length) {
        const e = VCD_TABLE[ir.byte()];
        exec(e[0], e[1], e[2]);
        exec(e[3], e[4], e[5]);
      }
      if (tPos !== w.tLen) throw new ModError('corrupt', 'The xdelta file is corrupt (window size mismatch).');
      if (w.adler !== undefined && adler32(T) !== w.adler) {
        throw new ModError('target-crc', 'The patched ROM failed its checksum, so it was not used. The patch may be for a different version of this game.');
      }
      outPos += w.tLen;
    }
    return { data: out, verified: sc.adler };
  }

  function fmtBig(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n + ' B'; }

  /* ── PPF 1/2/3 (PlayStation disc patches) ───────────────────────── */
  const PPF_BLOCK = 1024;
  function parsePPF(p) {
    const ver = p[3] - 0x30; // 'PPF1x' → 1, 'PPF2x' → 2, 'PPF3x' → 3
    if (ver < 1 || ver > 3 || p.length < 60) throw new ModError('corrupt', 'The PPF file is truncated or corrupt.');
    let end = p.length;
    // Optional FILE_ID.DIZ blurb appended after the records.
    const tag = '@BEGIN_FILE_ID.DIZ';
    outer: for (let i = p.length - tag.length; i >= 56; i--) { for (let j = 0; j < tag.length; j++) if (p[i + j] !== tag.charCodeAt(j)) continue outer; end = i; break; }
    let pos = 56, block = null, blockAt = 0x9320, srcSize = -1, undo = false;
    if (ver === 2) {
      srcSize = readU32LE(p, 56); pos = 60;
      block = p.subarray(60, 60 + PPF_BLOCK); pos = 60 + PPF_BLOCK;
    } else if (ver === 3) {
      const imageType = p[56], blockCheck = p[57]; undo = !!p[58]; pos = 60;
      if (imageType === 1) blockAt = 0x80A0;
      if (blockCheck) { block = p.subarray(60, 60 + PPF_BLOCK); pos = 60 + PPF_BLOCK; }
    }
    if (pos > end) throw new ModError('corrupt', 'The PPF file is truncated.');
    const recs = []; let maxEnd = 0;
    while (pos < end) {
      let off;
      if (ver === 3) { if (pos + 9 > end) throw new ModError('corrupt', 'The PPF file is truncated.'); off = readU32LE(p, pos + 4) * 4294967296 + readU32LE(p, pos); pos += 8; }
      else { if (pos + 5 > end) throw new ModError('corrupt', 'The PPF file is truncated.'); off = readU32LE(p, pos); pos += 4; }
      const len = p[pos++];
      if (pos + len > end) throw new ModError('corrupt', 'The PPF file is truncated.');
      recs.push({ off, len, at: pos }); pos += len + (undo ? len : 0);
      if (off + len > maxEnd) maxEnd = off + len;
    }
    return { ver, recs, maxEnd, block, blockAt, srcSize };
  }
  function applyPPF(rom, p) {
    const h = parsePPF(p);
    if (h.srcSize >= 0 && h.srcSize !== rom.length) {
      throw new ModError('source-mismatch', 'This PPF was made for a disc image of a different size (' + fmtBig(h.srcSize) + ' vs your ' + fmtBig(rom.length) + ').', { expected: h.srcSize, actual: rom.length });
    }
    if (h.block) {
      let ok = h.blockAt + PPF_BLOCK <= rom.length;
      for (let i = 0; ok && i < PPF_BLOCK; i++) if (rom[h.blockAt + i] !== h.block[i]) ok = false;
      if (!ok) throw new ModError('source-mismatch', 'This PPF was made for a different disc image (its validation block doesn\'t match yours) — check the game\'s region/version.');
    }
    const size = Math.max(rom.length, h.maxEnd);
    if (size > MAX_TARGET_BYTES) throw new ModError('too-large', 'This patch would produce an unreasonably large image.');
    const out = new Uint8Array(size); out.set(rom);
    for (const r of h.recs) out.set(p.subarray(r.at, r.at + r.len), r.off);
    return { data: out, verified: !!h.block || h.srcSize >= 0 };
  }

  /* ── APS (N64) ──────────────────────────────────────────────────── */
  function parseAPS(p) {
    if (p.length < 61) throw new ModError('corrupt', 'The APS file is truncated.');
    const type = p[5]; let pos = 57, head = null;
    if (type === 1) {
      if (p.length < 78) throw new ModError('corrupt', 'The APS file is truncated.');
      head = { cart: String.fromCharCode(p[58], p[59], p[60]), crc: p.subarray(61, 69) };
      pos = 74;
    } else if (type !== 0) throw new ModError('unsupported', 'This APS patch type isn\'t supported.');
    const size = readU32LE(p, pos); pos += 4;
    if (size > MAX_TARGET_BYTES) throw new ModError('too-large', 'This patch would produce an unreasonably large ROM.');
    const recs = [];
    while (pos < p.length) {
      if (pos + 5 > p.length) throw new ModError('corrupt', 'The APS file is truncated.');
      const off = readU32LE(p, pos), len = p[pos + 4]; pos += 5;
      if (len === 0) { if (pos + 2 > p.length) throw new ModError('corrupt', 'The APS file is truncated.'); recs.push({ off, rle: p[pos], len: p[pos + 1] }); pos += 2; }
      else { if (pos + len > p.length) throw new ModError('corrupt', 'The APS file is truncated.'); recs.push({ off, len, at: pos }); pos += len; }
    }
    return { type, head, size, recs };
  }
  function applyAPS(rom, p) {
    const h = parseAPS(p);
    if (h.head) {
      let ok = rom.length >= 0x40 && String.fromCharCode(rom[0x3C], rom[0x3D], rom[0x3E]) === h.head.cart;
      for (let i = 0; ok && i < 8; i++) if (rom[0x10 + i] !== h.head.crc[i]) ok = false;
      if (!ok) throw new ModError('source-mismatch', 'This patch was made for a different version of the game (its cartridge ID/checksum doesn\'t match your ROM).');
    }
    const out = new Uint8Array(h.size); out.set(rom.subarray(0, Math.min(rom.length, h.size)));
    for (const r of h.recs) {
      if (r.off >= h.size) continue;
      const len = Math.min(r.len, h.size - r.off);
      if (r.rle !== undefined) out.fill(r.rle, r.off, r.off + len); else out.set(p.subarray(r.at, r.at + len), r.off);
    }
    return { data: out, verified: !!h.head };
  }

  /* ── describing a patch without applying it ─────────────────────── */
  // Powers the info line + "needs ROM CRC xxxxxxxx" hint in the Mod Loader.
  // Never throws: a bad file comes back as { valid:false, error }.
  function describePatch(u8) {
    const format = detectFormat(u8);
    const base = { format, label: FORMAT_NAMES[format] || 'Unknown', size: u8.length, valid: false };
    try {
      if (u8.length > MAX_PATCH_BYTES) return { ...base, error: 'Patch file is too large (over 64 MB).' };
      if (format === 'ips') {
        const { recs, maxEnd, truncate } = parseIPS(u8);
        return { ...base, valid: true, records: recs.length, minRomSize: maxEnd, truncate: truncate >= 0 ? truncate : undefined };
      }
      if (format === 'bps') {
        const h = parseBPSHeader(u8);
        const ok = crc32(u8, 0, u8.length - 4) === h.patchCrc;
        let meta = '';
        if (h.metaSize) { try { meta = new TextDecoder().decode(u8.subarray(h.metaStart, h.metaStart + Math.min(h.metaSize, 2048))); } catch (e) {} }
        return { ...base, valid: ok, error: ok ? undefined : 'Patch checksum mismatch — the file is damaged.',
          sourceSize: h.sourceSize, targetSize: h.targetSize, sourceCrc: h.sourceCrc, targetCrc: h.targetCrc, meta };
      }
      if (format === 'ups') {
        const h = parseUPSHeader(u8);
        const ok = crc32(u8, 0, u8.length - 4) === h.patchCrc;
        return { ...base, valid: ok, error: ok ? undefined : 'Patch checksum mismatch — the file is damaged.',
          sourceSize: h.inSize, targetSize: h.outSize, sourceCrc: h.sourceCrc, targetCrc: h.targetCrc };
      }
      if (format === 'xdelta') {
        const sc = scanVCDIFF(u8);
        return { ...base, valid: true, targetSize: sc.total, minRomSize: sc.srcEnd, windows: sc.windows.length, adler: sc.adler };
      }
      if (format === 'ppf') {
        const h = parsePPF(u8);
        return { ...base, valid: true, records: h.recs.length, minRomSize: h.maxEnd, ppfVersion: h.ver, validated: !!h.block || h.srcSize >= 0 };
      }
      if (format === 'aps') {
        const h = parseAPS(u8);
        return { ...base, valid: true, records: h.recs.length, targetSize: h.size, validated: !!h.head, cart: h.head ? h.head.cart : undefined };
      }
      if (format === 'zip') return { ...base, valid: true, container: true };
      if (format === 'unknown') return { ...base, error: 'Not a recognised patch file. Supported: IPS, BPS, UPS, xdelta, PPF and N64 APS.' };
      return { ...base, error: FORMAT_NAMES[format] + ' patches aren\'t supported yet. Supported: IPS, BPS, UPS, xdelta, PPF and N64 APS.' };
    } catch (e) {
      return { ...base, error: e.message };
    }
  }

  /* ── ROM variants: byte order + copier headers ──────────────────── */
  // Same game, several on-disk shapes. Patch authors build against ONE of
  // them, so applying to the wrong shape gives garbage (IPS) or a CRC
  // refusal (BPS/UPS). Both are common enough to handle explicitly:
  //
  //  • N64 dumps come in three byte orders: z64 (big-endian, the native
  //    order every N64 patch assumes), v64 (16-bit byte-swapped) and n64
  //    (32-bit little-endian). Detected from the first word, which every
  //    N64 ROM begins with (0x80371240).
  //  • SNES dumps from copier devices carry a 512-byte header. Modern
  //    patches are almost always built against the headerless ROM; old
  //    IPS patches sometimes against the headered one. Detected by the
  //    length%1024 === 512 signature.
  function n64Order(u8) {
    if (u8.length < 4) return null;
    const a = u8[0], b = u8[1], c = u8[2], d = u8[3];
    if (a === 0x80 && b === 0x37 && c === 0x12 && d === 0x40) return 'z64';
    if (a === 0x37 && b === 0x80 && c === 0x40 && d === 0x12) return 'v64';
    if (a === 0x40 && b === 0x12 && c === 0x37 && d === 0x80) return 'n64';
    return null;
  }

  function toZ64(u8, order) {
    if (order === 'z64') return u8;
    const out = new Uint8Array(u8.length);
    const n = u8.length - (u8.length % 4);
    if (order === 'v64') {
      for (let i = 0; i + 1 < u8.length; i += 2) { out[i] = u8[i + 1]; out[i + 1] = u8[i]; }
    } else { // n64: reverse every 4-byte word
      for (let i = 0; i < n; i += 4) { out[i] = u8[i + 3]; out[i + 1] = u8[i + 2]; out[i + 2] = u8[i + 1]; out[i + 3] = u8[i]; }
      for (let i = n; i < u8.length; i++) out[i] = u8[i];
    }
    return out;
  }

  const isCopierHeadered = u8 => u8.length > 512 && (u8.length % 1024) === 512;

  /* Other consoles' on-disk quirks, same idea as N64/SNES above:
       NES   16-byte iNES header ("NES\x1A") — most patches INCLUDE it, some are
             built headerless, so BPS/UPS/xdelta try both (checksum-verified);
             IPS keeps it (the iNES convention).
       Lynx  64-byte "LYNX" header — same treatment.
       PCE   512-byte copier header (size%8192 == 512) — stripped first.
       MD    Genesis "SMD" dumps: 512-byte header + 16 KB blocks with odd/even
             bytes split. Patches target the de-interleaved ROM, so it's rebuilt.  */
  const hasMagic = (u8, str) => u8.length > str.length && [...str].every((c, i) => u8[i] === c.charCodeAt(0));
  function isSMD(u8) { return u8.length > 512 && ((u8.length - 512) % 16384) === 0 && u8[8] === 0xAA && u8[9] === 0xBB; }
  function deinterleaveSMD(u8) {
    const blocks = (u8.length - 512) / 16384, out = new Uint8Array(blocks * 16384);
    for (let b = 0; b < blocks; b++) {
      const src = 512 + b * 16384, dst = b * 16384;
      for (let i = 0; i < 8192; i++) { out[dst + i * 2 + 1] = u8[src + i]; out[dst + i * 2] = u8[src + 8192 + i]; }
    }
    return out;
  }

  /**
   * Candidate shapes of `rom` to try, in preference order.
   * `kind`: 'n64' | 'snes' | 'nes' | 'lynx' | 'pce' | 'md' | anything else (as-is only).
   * `header`: 'auto' | 'keep' | 'strip' — user override for header-bearing ROMs.
   */
  function romVariants(rom, kind, header) {
    const list = [];
    const asIs = { label: 'as-is', data: rom };
    // Generic "optional header" ordering: `keepFirst` says which the convention prefers.
    const headered = (stripLen, keepFirst, what) => {
      const stripped = { label: what + ' header stripped', data: rom.subarray(stripLen) }, kept = { label: 'as-is (header kept)', data: rom };
      if (header === 'keep') return [kept];
      if (header === 'strip') return [stripped];
      return keepFirst ? [kept, stripped] : [stripped, kept];
    };
    if (kind === 'n64') {
      const order = n64Order(rom);
      if (order && order !== 'z64') list.push({ label: 'N64 ' + order + ' → z64', data: toZ64(rom, order) });
      list.push(asIs);
      return list;
    }
    if (kind === 'snes' && isCopierHeadered(rom)) return headered(512, false, 'copier');
    if (kind === 'pce' && rom.length > 512 && (rom.length % 8192) === 512) return headered(512, false, 'copier');
    if (kind === 'nes' && hasMagic(rom, 'NES\x1A')) return headered(16, true, 'iNES');
    if (kind === 'lynx' && hasMagic(rom, 'LYNX') && rom.length > 64) return headered(64, true, 'Lynx');
    if (kind === 'md' && isSMD(rom)) return [{ label: 'SMD de-interleaved', data: deinterleaveSMD(rom) }, asIs];
    list.push(asIs);
    return list;
  }

  /* ── which consoles can take patches ────────────────────────────── */
  // Cartridge/ROM-file systems: the stored file IS the ROM, so any supported
  // patch applies. Disc systems: only a RAW image (.iso/.bin/.img) can be
  // patched — .cue is a text index, .chd/.cso/.pbp are compressed containers, so
  // patching their bytes would silently corrupt them. (That IPS-on-a-container
  // corruption is exactly why this check exists rather than "try and see".)
  const DISC_CORES = ['psx', 'ppsspp', 'saturn', 'segaCD'];
  const RAW_DISC_EXT = ['iso', 'bin', 'img'];
  const KIND_BY_CORE = { n64: 'n64', snes: 'snes', nes: 'nes', lynx: 'lynx', pce: 'pce', segaMD: 'md' };
  const kindForCore = core => KIND_BY_CORE[core] || '';
  function patchSupport(core, ext) {
    if (DISC_CORES.indexOf(core) === -1) return { ok: true, disc: false };
    ext = String(ext || '').toLowerCase().replace(/^\./, '');
    if (RAW_DISC_EXT.indexOf(ext) !== -1) return { ok: true, disc: true };
    return { ok: false, disc: true, reason: ext
      ? 'This game is stored as .' + ext + ', which is a container or index file, so it can\'t be patched directly. Mods work on raw disc images (.iso, .bin or .img).'
      : 'This game\'s disc format couldn\'t be determined, so it can\'t be patched safely. Mods work on raw disc images (.iso, .bin or .img).' };
  }

  /* ── single patch application with variant selection ────────────── */
  function applyOne(rom, patch, opts) {
    const format = detectFormat(patch);
    if (SUPPORTED.indexOf(format) === -1) {
      throw new ModError('unsupported', (FORMAT_NAMES[format] || 'This') + ' patches aren\'t supported yet. Supported: IPS, BPS, UPS, xdelta, PPF and N64 APS.');
    }
    if (rom.length >= 2 && rom[0] === 0x50 && rom[1] === 0x4B && (rom[2] === 3 || rom[2] === 5)) {
      throw new ModError('rom-container', 'This game is stored as a .zip archive, which can\'t be patched directly.');
    }
    const variants = romVariants(rom, opts && opts.kind, opts && opts.header);

    if (format === 'ips' || format === 'ppf' || format === 'aps') {
      // IPS has no checksums to arbitrate, so it takes the preferred variant.
      // PPF/APS validate against the ROM themselves (and throw on mismatch).
      const v = variants[0];
      const r = format === 'ips' ? { data: applyIPS(v.data, patch), verified: false }
        : format === 'ppf' ? applyPPF(v.data, patch) : applyAPS(v.data, patch);
      return { data: r.data, variant: v.label, verified: r.verified, format };
    }

    if (format === 'xdelta') {
      // No source checksum in VCDIFF; the window Adler-32 (when present) verifies
      // the OUTPUT, so a wrong variant shows up as a failed checksum and we move on.
      let firstErr = null;
      for (const v of variants) {
        try { const r = applyVCDIFF(v.data, patch); return { data: r.data, variant: v.label, verified: r.verified, format }; }
        catch (e) { if (!firstErr) firstErr = e; if (e.code !== 'target-crc' && e.code !== 'source-mismatch' && e.code !== 'corrupt') throw e; }
      }
      throw firstErr;
    }

    assertPatchCrc(patch, FORMAT_NAMES[format]);
    const h = format === 'bps' ? parseBPSHeader(patch) : parseUPSHeader(patch);
    const want = h.sourceCrc;
    const wantSize = format === 'bps' ? h.sourceSize : h.inSize;
    let firstErr = null;
    for (const v of variants) {
      if (v.data.length !== wantSize) continue;
      if (crc32(v.data) !== want) continue;
      try {
        const data = format === 'bps' ? applyBPS(v.data, patch) : applyUPS(v.data, patch);
        return { data, variant: v.label, verified: true, format };
      } catch (e) { if (!firstErr) firstErr = e; }
    }
    if (firstErr) throw firstErr;
    // Nothing matched: build the most useful diagnostic we can.
    const got = crc32(variants[0].data);
    throw new ModError('source-mismatch',
      'This patch was made for a different version of the game ' +
      '(it expects ROM checksum ' + hex8(want).toUpperCase() + ', your ROM is ' + hex8(got).toUpperCase() + '). ' +
      'Check the region/revision, or whether your ROM has an extra header.',
      { expected: want, actual: got });
  }

  /**
   * Applies a list of patches, in order, to a ROM.
   * patches: [{ name, bytes:Uint8Array, header?:'auto'|'keep'|'strip' }]
   * Never throws for a bad individual patch — that patch is skipped and
   * reported, and the chain carries on with what it had. (Throwing would
   * mean one broken mod silently launches the game fully vanilla.)
   */
  function applyChain(rom, patches, opts) {
    const kind = opts && opts.kind;
    const result = { data: rom, applied: [], skipped: [], notes: [] };
    if (!patches || !patches.length) return result;
    if (rom.length > MAX_ROM_PATCHABLE) {
      for (const p of patches) result.skipped.push({ name: p.name, code: 'rom-too-large', reason: 'This game is too large to patch in the browser.' });
      return result;
    }
    let cur = rom;
    for (const p of patches) {
      try {
        const r = applyOne(cur, p.bytes, { kind, header: p.header });
        cur = r.data;
        result.applied.push({ name: p.name, format: r.format, variant: r.variant, verified: r.verified });
        if (r.variant !== 'as-is') result.notes.push(p.name + ': applied to ROM with ' + r.variant);
        if (!r.verified) result.notes.push(p.name + ': ' + (FORMAT_NAMES[r.format] || r.format) + ' patch couldn\'t be checksum-verified, so the result is unverified.');
      } catch (e) {
        result.skipped.push({ name: p.name, code: e.code || 'error', reason: e.message || String(e) });
      }
    }
    result.data = cur;
    return result;
  }

  /* ── zip containers ─────────────────────────────────────────────── */
  // Patch downloads are very often zipped alongside a readme. Reading just
  // the central directory + inflating the entries we care about (via the
  // browser's native DecompressionStream) avoids bundling a zip library.
  async function inflateRaw(u8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new ModError('no-inflate', 'This browser can\'t open .zip files. Unzip the patch first, then add it.');
    }
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function extractPatchesFromZip(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
      if (dv.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
    }
    if (eocd < 0) throw new ModError('corrupt', 'That .zip file looks damaged.');
    const count = dv.getUint16(eocd + 10, true);
    let cd = dv.getUint32(eocd + 16, true);
    if (count === 0xFFFF || cd === 0xFFFFFFFF) throw new ModError('unsupported', 'ZIP64 archives aren\'t supported. Unzip the patch first.');
    const found = [];
    const dec = new TextDecoder();
    for (let n = 0; n < count && n < 500; n++) {
      if (cd + 46 > u8.length || dv.getUint32(cd, true) !== 0x02014B50) break;
      const flags = dv.getUint16(cd + 8, true);
      const method = dv.getUint16(cd + 10, true);
      const csize = dv.getUint32(cd + 20, true);
      const usize = dv.getUint32(cd + 24, true);
      const nlen = dv.getUint16(cd + 28, true);
      const elen = dv.getUint16(cd + 30, true);
      const clen = dv.getUint16(cd + 32, true);
      const lho = dv.getUint32(cd + 42, true);
      const name = dec.decode(u8.subarray(cd + 46, cd + 46 + nlen));
      cd += 46 + nlen + elen + clen;

      if (/\/$/.test(name) || /(^|\/)__MACOSX\//.test(name) || /(^|\/)\._/.test(name)) continue;
      if (!/\.(ips|bps|ups|xdelta3?|vcdiff|ppf|aps|ebp)$/i.test(name)) continue;
      if (flags & 1) throw new ModError('unsupported', 'That .zip is password-protected.');
      if (usize > MAX_PATCH_BYTES) continue;
      if (lho + 30 > u8.length || dv.getUint32(lho, true) !== 0x04034B50) continue;
      const dataStart = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      const raw = u8.subarray(dataStart, dataStart + csize);
      let bytes;
      if (method === 0) bytes = raw.slice();
      else if (method === 8) bytes = await inflateRaw(raw);
      else continue;
      found.push({ name: name.split('/').pop(), bytes });
      if (found.length >= 25) break;
    }
    return found;
  }

  /* ── cheats ─────────────────────────────────────────────────────── */
  // Accepts (1) RetroArch .cht files, and (2) loose text, one cheat per
  // line, in any of: "Description: CODE", "Description = CODE",
  // "CODE  Description", "Description  CODE", or a bare CODE.
  // Code syntax is NOT validated per-system (Game Genie, Action Replay,
  // GameShark, raw RAM pokes all differ) — the core is the only thing that
  // can say whether a code is meaningful, and rejecting valid exotic codes
  // would be worse than passing a dud through.
  const MAX_CHEATS = 500, MAX_CODE_LEN = 1024;
  // Hex groups joined by - : + . or space (GameShark/Action Replay/SNES PAR/
  // Genesis & GB Game Genie are all of this shape)…
  const HEXISH = /^[0-9A-Fa-f]+(?:[-:+. ][0-9A-Fa-f]+)*$/;
  // …and NES Game Genie, which is 6 or 8 letters from a fixed 16-letter set.
  const NES_GG = /^(?:[APZLGITYEOXUKSVN]{6}|[APZLGITYEOXUKSVN]{8})$/;
  // A single whitespace-delimited token that is plausibly (part of) a code.
  const CODE_TOK = /^(?:[0-9A-Fa-f]{2,}(?:[-:+][0-9A-Fa-f]+)*|[APZLGITYEOXUKSVN]{6}|[APZLGITYEOXUKSVN]{8})$/;

  function looksLikeCode(s) {
    s = s.trim();
    if (!s || s.length > MAX_CODE_LEN) return false;
    // Requiring a digit for the hex-group form stops ordinary words that
    // happen to be spelled with a-f ("Dead", "Face") reading as codes.
    if (HEXISH.test(s) && /[0-9]/.test(s)) return true;
    return NES_GG.test(s);
  }

  function parseChtFile(text) {
    const kv = {};
    for (const raw of text.split(/\r?\n/)) {
      const m = raw.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
      if (m) kv[m[1]] = m[2];
    }
    const total = parseInt(kv.cheats, 10);
    if (!Number.isFinite(total) || total < 1) return null;
    const out = [];
    for (let i = 0; i < Math.min(total, MAX_CHEATS); i++) {
      const code = kv['cheat' + i + '_code'];
      if (!code) continue;
      out.push({ desc: (kv['cheat' + i + '_desc'] || 'Cheat ' + (i + 1)).slice(0, 120), code: code.slice(0, MAX_CODE_LEN) });
    }
    return out;
  }

  function parseCheats(text) {
    text = String(text || '');
    if (/^\s*cheats\s*=\s*\d+/mi.test(text)) {
      const cht = parseChtFile(text);
      if (cht && cht.length) return cht;
    }
    const out = [];
    let n = 0;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || /^(#|;|\/\/)/.test(line)) continue;
      if (out.length >= MAX_CHEATS) break;
      n++;
      let desc = '', code = '';
      if (looksLikeCode(line)) {
        code = line;
      } else {
        let m = line.match(/^(.*?)\s*[=\t]\s*(.+)$/) || line.match(/^(.*?[^\s:])\s*:\s+(.+)$/) || line.match(/^(.*?)\s+-\s+(.+)$/);
        if (m && looksLikeCode(m[2])) { desc = m[1]; code = m[2]; }
        else if (m && looksLikeCode(m[1])) { desc = m[2]; code = m[1]; }
        else {
          // "CODE description" / "description CODE": peel code-like tokens
          // off one end.
          const toks = line.split(/\s+/);
          let i = 0;
          while (i < toks.length && CODE_TOK.test(toks[i])) i++;
          if (i > 0 && i < toks.length) { code = toks.slice(0, i).join(' '); desc = toks.slice(i).join(' '); }
          else {
            let j = toks.length;
            while (j > 0 && CODE_TOK.test(toks[j - 1])) j--;
            if (j > 0 && j < toks.length) { desc = toks.slice(0, j).join(' '); code = toks.slice(j).join(' '); }
          }
        }
      }
      code = code.trim();
      if (!code || code.length > MAX_CODE_LEN) continue;
      out.push({ desc: (desc.trim() || 'Cheat ' + n).slice(0, 120), code });
    }
    return out;
  }

  /* ── identity of a patch file ───────────────────────────────────── */
  // NOT crc32(whole file). BPS and UPS end with their own CRC32, and the CRC of
  // "data + its own CRC (little-endian)" is the same constant (0x2144DF1C) for
  // EVERY input. Keying duplicates / fingerprints on the whole-file CRC therefore
  // made every BPS/UPS patch look identical to the first one stored — only one
  // could be kept per game. This hashes the body and the 4-byte tail separately
  // (for BPS/UPS the body already embeds source+target CRCs) and adds the length.
  function contentId(u8) {
    const n = u8.length, cut = Math.max(0, n - 4);
    return hex8(crc32(u8, 0, cut)) + ':' + hex8(crc32(u8, cut, n)) + ':' + n;
  }

  /* ── fingerprint of an active mod set ───────────────────────────── */
  // Used to stamp save states so loading a state made under a DIFFERENT mod
  // setup can be flagged (states are raw core memory snapshots: restoring
  // one into a ROM with different code is the realistic way to crash a core).
  function fingerprint(parts) {
    const enc = new TextEncoder().encode((parts || []).join('|'));
    return parts && parts.length ? hex8(crc32(enc)) : '';
  }

  return {
    ModError, crc32, hex8, detectFormat, describePatch, FORMAT_NAMES,
    applyIPS, applyBPS, applyUPS, applyOne, applyChain,
    n64Order, toZ64, isCopierHeadered, romVariants, patchSupport, kindForCore, isSMD, deinterleaveSMD,
    applyVCDIFF, applyPPF, applyAPS, adler32,
    extractPatchesFromZip, parseCheats, fingerprint, contentId,
    SUPPORTED, DISC_CORES, RAW_DISC_EXT,
    LIMITS: { MAX_PATCH_BYTES, MAX_TARGET_BYTES, MAX_ROM_PATCHABLE, MAX_CHEATS },
  };
});
