/* ═══════════════════════════════════════════════════════════════════
   ROM Player by Coops — Mod Engine
   ───────────────────────────────────────────────────────────────────
   Pure, DOM-free logic behind the per-game Mod Loader. Lives in its own
   file (not inline in index.html) for one reason: it can be loaded
   straight into Node and tested against an independent reference patcher
   (see test/mod-engine.test.mjs). Everything that touches the page —
   IndexedDB, the Mod Loader sheet, launch() wiring — stays in index.html.

   WHAT A "MOD" IS HERE
   • Patch  — an IPS / BPS / UPS file (ROM hacks, fan translations, bug
              fixes, QoL patches). Applied IN MEMORY at launch time to a
              copy of the library ROM. The ROM stored in OPFS is never
              written to, so turning a mod off is always a clean revert and
              there is nothing to "restore".
   • Cheats — description + code pairs handed to EmulatorJS (EJS_cheats).

   WHAT IS DELIBERATELY NOT HERE
   • xdelta/VCDIFF, PPF, APS, RUP: not implemented. detectFormat() names
     them so the UI can say "xdelta isn't supported yet" instead of the
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
  const MAX_PATCH_BYTES = 64 * 1024 * 1024;
  const MAX_TARGET_BYTES = 512 * 1024 * 1024;
  const MAX_ROM_PATCHABLE = 256 * 1024 * 1024; // see applyChain()

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
    if (startsWith(u8, 'PATCH')) return 'ips';
    if (startsWith(u8, 'BPS1')) return 'bps';
    if (startsWith(u8, 'UPS1')) return 'ups';
    if (u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4B && (u8[2] === 3 || u8[2] === 5)) return 'zip';
    if (u8.length >= 4 && u8[0] === 0xD6 && u8[1] === 0xC3 && u8[2] === 0xC4) return 'xdelta';
    if (startsWith(u8, 'PPF')) return 'ppf';
    if (startsWith(u8, 'APS')) return 'aps';
    if (startsWith(u8, 'RUP9')) return 'rup';
    return 'unknown';
  }

  const FORMAT_NAMES = { ips: 'IPS', bps: 'BPS', ups: 'UPS', zip: 'ZIP', xdelta: 'xdelta', ppf: 'PPF', aps: 'APS', rup: 'RUP', unknown: 'Unknown' };

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
    let pos = 5, maxEnd = 0, truncate = -1;
    const EOF = 0x454F46; // "EOF" read as a 24-bit big-endian offset
    while (true) {
      if (pos + 3 > p.length) {
        // Plenty of real-world IPS files are missing the EOF marker. Treat
        // end-of-file at a record boundary as a clean end rather than
        // rejecting an otherwise perfectly good patch.
        if (pos === p.length) break;
        throw new ModError('corrupt', 'The IPS file is truncated.');
      }
      const off = (p[pos] << 16) | (p[pos + 1] << 8) | p[pos + 2];
      pos += 3;
      if (off === EOF) {
        const rest = p.length - pos;
        // "EOF" bytes can also be a legitimate record offset (0x454F46 is a
        // valid ROM address). A true terminator is followed by nothing, or
        // by exactly a 3-byte truncation length (Lunar IPS extension).
        if (rest === 0) break;
        if (rest === 3) { truncate = (p[pos] << 16) | (p[pos + 1] << 8) | p[pos + 2]; break; }
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
      if (format === 'zip') return { ...base, valid: true, container: true };
      if (format === 'unknown') return { ...base, error: 'Not a recognised patch file. IPS, BPS and UPS patches are supported.' };
      return { ...base, error: FORMAT_NAMES[format] + ' patches aren\'t supported yet. IPS, BPS and UPS patches are.' };
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

  /**
   * Candidate shapes of `rom` to try, in preference order.
   * `kind`: 'n64' | 'snes' | anything else (treated as "as-is only").
   * `header`: 'auto' | 'keep' | 'strip' — user override for SNES-style headers.
   */
  function romVariants(rom, kind, header) {
    const list = [];
    if (kind === 'n64') {
      const order = n64Order(rom);
      if (order && order !== 'z64') list.push({ label: 'N64 ' + order + ' → z64', data: toZ64(rom, order) });
      list.push({ label: 'as-is', data: rom });
      return list;
    }
    if (kind === 'snes' && isCopierHeadered(rom)) {
      const stripped = rom.subarray(512);
      if (header === 'keep') list.push({ label: 'as-is (header kept)', data: rom });
      else if (header === 'strip') list.push({ label: 'header stripped', data: stripped });
      else {
        // auto: headerless first (modern convention), headered as fallback.
        list.push({ label: 'header stripped', data: stripped });
        list.push({ label: 'as-is (header kept)', data: rom });
      }
      return list;
    }
    list.push({ label: 'as-is', data: rom });
    return list;
  }

  /* ── single patch application with variant selection ────────────── */
  function applyOne(rom, patch, opts) {
    const format = detectFormat(patch);
    if (!['ips', 'bps', 'ups'].includes(format)) {
      throw new ModError('unsupported', (FORMAT_NAMES[format] || 'This') + ' patches aren\'t supported yet. IPS, BPS and UPS patches are.');
    }
    const variants = romVariants(rom, opts && opts.kind, opts && opts.header);

    if (format === 'ips') {
      // No checksums to arbitrate, so take the first (preferred) variant.
      const v = variants[0];
      return { data: applyIPS(v.data, patch), variant: v.label, verified: false, format };
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
        if (!r.verified && r.format === 'ips') result.notes.push(p.name + ': IPS patches have no checksum, so the result can\'t be verified.');
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
      if (!/\.(ips|bps|ups)$/i.test(name)) continue;
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
    n64Order, toZ64, isCopierHeadered, romVariants,
    extractPatchesFromZip, parseCheats, fingerprint, contentId,
    LIMITS: { MAX_PATCH_BYTES, MAX_TARGET_BYTES, MAX_ROM_PATCHABLE, MAX_CHEATS },
  };
});
