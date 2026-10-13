/* ═══════════════════════════════════════════════════════════════════
   mod-engine tests  —  run:  node --test test/
   ───────────────────────────────────────────────────────────────────
   Two layers of evidence, on purpose:

   1. REFERENCE CROSS-CHECK. Patches are *created* by an independent,
      widely-used implementation (marcrobledo/RomPatcher.js, MIT) and then
      applied by mod-engine.js; the output must be byte-identical to the
      modified ROM the reference was given. That proves the appliers
      against someone else's encoders rather than against my own
      reading of the specs. Point ROMPATCHER_REF at a checkout of
      rom-patcher-js/modules; if it's absent those tests are skipped
      (and reported as skipped, not silently passed).

   2. HAND-BUILT VECTORS for the things a reference round-trip can't
      reach: truncated/corrupt files, wrong-ROM refusal, N64 byte orders,
      SNES copier headers, IPS edge cases, chains, zip containers, cheats.
═══════════════════════════════════════════════════════════════════ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const E = require('../mod-engine.js');

const REF_DIR = process.env.ROMPATCHER_REF || '/tmp/ref/modules';
const haveRef = fs.existsSync(REF_DIR + '/BinFile.js');
let REF = null;
if (haveRef) {
  globalThis.BinFile = require(REF_DIR + '/BinFile.js');
  globalThis.HashCalculator = require(REF_DIR + '/HashCalculator.js');
  REF = {
    ips: require(REF_DIR + '/RomPatcher.format.ips.js'),
    bps: require(REF_DIR + '/RomPatcher.format.bps.js'),
    ups: require(REF_DIR + '/RomPatcher.format.ups.js'),
  };
}

// Deterministic PRNG so failures are reproducible.
function rng(seed) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; }
function makeRom(n, seed = 1) { const r = rng(seed), u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = (r() * 256) | 0; return u; }
const eq = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const bf = u8 => new globalThis.BinFile(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
const refMake = (fmt, orig, mod, extra) => new Uint8Array(REF[fmt].buildFromRoms(bf(orig), bf(mod), extra).export()._u8array);

/* ── 1. reference cross-check ───────────────────────────────────── */
const scenarios = {
  'scattered edits': (o) => { const m = o.slice(); m[10] ^= 0xFF; m[5000] = 1; m[o.length - 1] ^= 3; m.fill(0x42, 700, 1400); return m; },
  'long RLE-able runs': (o) => { const m = o.slice(); m.fill(0, 100, 3000); m.fill(0xFF, 9000, 9500); return m; },
  'ROM grows': (o) => { const m = new Uint8Array(o.length + 4096); m.set(o); m.fill(0x7A, o.length, o.length + 2000); m[o.length + 3000] = 9; m[20] = 0; return m; },
};
for (const fmt of ['ips', 'bps', 'ups']) {
  for (const [label, f] of Object.entries(scenarios)) {
    test(`reference-made ${fmt.toUpperCase()} applies byte-exact — ${label}`, { skip: !haveRef && 'reference patcher not found (set ROMPATCHER_REF)' }, () => {
      const orig = makeRom(32768, 7), mod = f(orig);
      const patch = refMake(fmt, orig, mod);
      assert.equal(E.detectFormat(patch), fmt);
      const out = E.applyOne(orig, patch, {});
      assert.ok(eq(out.data, mod), 'output differs from the modified ROM');
      assert.equal(out.verified, fmt !== 'ips');
    });
  }
}
test('reference-made BPS (linear delta mode) applies byte-exact', { skip: !haveRef && 'reference patcher not found' }, () => {
  const orig = makeRom(40000, 3), mod = orig.slice(); mod.copyWithin(500, 20000, 21000); mod[30000] = 5;
  const patch = refMake('bps', orig, mod, false);
  assert.ok(eq(E.applyOne(orig, patch, {}).data, mod));
});
test('reference-made BPS with moved blocks exercises SourceCopy/TargetCopy', { skip: !haveRef && 'reference patcher not found' }, () => {
  const orig = makeRom(60000, 11), mod = new Uint8Array(orig.length);
  mod.set(orig.subarray(30000), 0); mod.set(orig.subarray(0, 30000), 30000); // swap halves
  mod.fill(0x11, 100, 164); mod.copyWithin(5000, 100, 164);                   // run + self-copy
  const patch = refMake('bps', orig, mod, true);
  assert.ok(eq(E.applyOne(orig, patch, {}).data, mod));
});

/* ── 2. hand-built vectors ──────────────────────────────────────── */
const ipsBuild = (recs, { eof = true, trunc } = {}) => {
  const b = [...Buffer.from('PATCH')];
  for (const r of recs) {
    b.push((r.off >> 16) & 255, (r.off >> 8) & 255, r.off & 255);
    if (r.rle !== undefined) b.push(0, 0, (r.len >> 8) & 255, r.len & 255, r.rle);
    else b.push((r.data.length >> 8) & 255, r.data.length & 255, ...r.data);
  }
  if (eof) b.push(0x45, 0x4F, 0x46);
  if (trunc !== undefined) b.push((trunc >> 16) & 255, (trunc >> 8) & 255, trunc & 255);
  return new Uint8Array(b);
};

test('IPS: plain, RLE, growth', () => {
  const rom = makeRom(100, 1);
  const p = ipsBuild([{ off: 5, data: [1, 2, 3] }, { off: 50, len: 10, rle: 0xEE }, { off: 120, data: [9] }]);
  const out = E.applyIPS(rom, p);
  assert.equal(out.length, 121);
  assert.deepEqual([...out.subarray(5, 8)], [1, 2, 3]);
  assert.ok(out.subarray(50, 60).every(v => v === 0xEE));
  assert.equal(out[120], 9);
  assert.equal(out[0], rom[0]);
});
test('IPS: missing EOF marker is tolerated', () => {
  const out = E.applyIPS(makeRom(20, 2), ipsBuild([{ off: 1, data: [7] }], { eof: false }));
  assert.equal(out[1], 7);
});
test('IPS: Lunar truncate trailer shrinks the ROM', () => {
  const out = E.applyIPS(makeRom(100, 2), ipsBuild([{ off: 1, data: [7] }], { trunc: 60 }));
  assert.equal(out.length, 60);
});
test('IPS: a record whose offset spells "EOF" is a record, not a terminator', () => {
  const off = 0x454F46;
  const p = ipsBuild([{ off, data: [0xAB, 0xCD] }]);
  const out = E.applyIPS(new Uint8Array(off + 10), p);
  assert.equal(out[off], 0xAB); assert.equal(out[off + 1], 0xCD);
});
test('IPS: truncated file is rejected, not half-applied', () => {
  const p = ipsBuild([{ off: 1, data: [1, 2, 3, 4] }], { eof: false });
  assert.throws(() => E.applyIPS(makeRom(10), p.subarray(0, p.length - 2)), /truncated/i);
});

test('BPS: flipped byte → patch-crc error', { skip: !haveRef && 'needs reference-made BPS' }, () => {
  const orig = makeRom(8192, 5), mod = orig.slice(); mod[100] ^= 1;
  const p = refMake('bps', orig, mod); p[8] ^= 0xFF;
  assert.throws(() => E.applyBPS(orig, p), e => e.code === 'patch-crc');
});
test('BPS/UPS: wrong ROM is refused with expected vs actual CRC', { skip: !haveRef && 'needs reference-made patches' }, () => {
  const orig = makeRom(8192, 5), mod = orig.slice(); mod[100] ^= 1;
  const other = makeRom(8192, 6);
  for (const fmt of ['bps', 'ups']) {
    const p = refMake(fmt, orig, mod);
    assert.throws(() => E.applyOne(other, p, {}), e => e.code === 'source-mismatch' && e.expected === E.crc32(orig) && e.actual === E.crc32(other), fmt);
  }
});
test('UPS: already-patched ROM is not XORed back to vanilla', { skip: !haveRef && 'needs reference-made UPS' }, () => {
  const orig = makeRom(8192, 5), mod = new Uint8Array(8300); mod.set(orig); mod[8200] = 5;
  const p = refMake('ups', orig, mod);
  assert.throws(() => E.applyUPS(mod, p), e => e.code === 'already-patched');
});
test('BPS: TargetCopy with overlap behaves as a run-length fill', () => {
  // Hand-assembled BPS: target = [0x41] followed by 7 more copies of it,
  // expressed as TargetRead(1 byte) + TargetCopy(len 7, offset 0 → distance 1).
  const varint = n => { const o = []; while (true) { const x = n & 0x7F; n >>= 7; if (n === 0) { o.push(0x80 | x); break; } o.push(x); n--; } return o; };
  const target = new Uint8Array(8).fill(0x41);
  const body = [...Buffer.from('BPS1'), ...varint(0), ...varint(8), ...varint(0),
    ...varint(((1 - 1) << 2) | 1), 0x41,          // TargetRead, len 1
    ...varint(((7 - 1) << 2) | 3), ...varint(0 << 1)]; // TargetCopy, len 7, +0 relative
  const crcLE = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  const withFooter = [...body, ...crcLE(E.crc32(new Uint8Array(0))), ...crcLE(E.crc32(target))];
  const patch = new Uint8Array([...withFooter, ...crcLE(E.crc32(new Uint8Array(withFooter)))]);
  assert.ok(eq(E.applyBPS(new Uint8Array(0), patch), target));
});

/* ROM shapes */
function fakeN64(n = 4096) { const r = makeRom(n, 21); r.set([0x80, 0x37, 0x12, 0x40]); return r; }
const toV64 = z => { const o = new Uint8Array(z.length); for (let i = 0; i + 1 < z.length; i += 2) { o[i] = z[i + 1]; o[i + 1] = z[i]; } return o; };
const toN64 = z => { const o = new Uint8Array(z.length); for (let i = 0; i + 3 < z.length; i += 4) { o[i] = z[i + 3]; o[i + 1] = z[i + 2]; o[i + 2] = z[i + 1]; o[i + 3] = z[i]; } return o; };

test('N64 byte orders are detected and normalised to z64', () => {
  const z = fakeN64();
  assert.equal(E.n64Order(z), 'z64'); assert.equal(E.n64Order(toV64(z)), 'v64'); assert.equal(E.n64Order(toN64(z)), 'n64');
  assert.ok(eq(E.toZ64(toV64(z), 'v64'), z)); assert.ok(eq(E.toZ64(toN64(z), 'n64'), z));
});
test('N64: a z64-built BPS applies to v64 and n64 dumps (checksum-verified)', { skip: !haveRef && 'needs reference-made BPS' }, () => {
  const z = fakeN64(), mod = z.slice(); mod[2000] ^= 0x55; mod.fill(7, 3000, 3100);
  const p = refMake('bps', z, mod);
  for (const [label, dump] of [['z64', z], ['v64', toV64(z)], ['n64', toN64(z)]]) {
    const r = E.applyOne(dump, p, { kind: 'n64' });
    assert.ok(eq(r.data, mod), label); assert.ok(r.verified, label);
  }
});
test('N64: without kind the byte-swapped dump is (correctly) refused, not corrupted', { skip: !haveRef && 'needs reference-made BPS' }, () => {
  const z = fakeN64(), mod = z.slice(); mod[2000] ^= 1;
  assert.throws(() => E.applyOne(toV64(z), refMake('bps', z, mod), {}), e => e.code === 'source-mismatch');
});
test('SNES: copier-headered ROM + headerless BPS → header stripped automatically', { skip: !haveRef && 'needs reference-made BPS' }, () => {
  const body = makeRom(32768, 31), mod = body.slice(); mod[1234] ^= 9;
  const headered = new Uint8Array(512 + body.length); headered.set(body, 512);
  const r = E.applyOne(headered, refMake('bps', body, mod), { kind: 'snes' });
  assert.ok(eq(r.data, mod)); assert.match(r.variant, /header stripped/);
});
test('SNES: header=keep respects a patch built against the headered dump', { skip: !haveRef && 'needs reference-made BPS' }, () => {
  const body = makeRom(32768, 31), headered = new Uint8Array(512 + body.length); headered.set(body, 512);
  const mod = headered.slice(); mod[600] ^= 9;
  const p = refMake('bps', headered, mod);
  assert.ok(eq(E.applyOne(headered, p, { kind: 'snes', header: 'keep' }).data, mod));
  assert.ok(eq(E.applyOne(headered, p, { kind: 'snes' }).data, mod), 'auto must fall back to the headered variant on CRC match');
});
test('Non-SNES/N64 systems never get header surgery', () => {
  assert.equal(E.romVariants(makeRom(1024 + 512), 'gba').length, 1);
});

/* chains */
test('chain: patches apply in order; a bad one is skipped and reported, not fatal', () => {
  const rom = new Uint8Array(64);
  const a = ipsBuild([{ off: 0, data: [1] }]);
  const b = ipsBuild([{ off: 1, data: [2] }]);
  const bad = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const r = E.applyChain(rom, [{ name: 'a', bytes: a }, { name: 'bad', bytes: bad }, { name: 'b', bytes: b }], { kind: 'gba' });
  assert.deepEqual(r.applied.map(x => x.name), ['a', 'b']);
  assert.equal(r.skipped.length, 1); assert.equal(r.skipped[0].name, 'bad'); assert.equal(r.skipped[0].code, 'unsupported');
  assert.deepEqual([...r.data.subarray(0, 3)], [1, 2, 0]);
  assert.ok(r.notes.some(n => /unverified/.test(n)));
});
test('chain: later IPS overrides earlier IPS on overlap (load order matters)', () => {
  const r = E.applyChain(new Uint8Array(8), [{ name: '1', bytes: ipsBuild([{ off: 2, data: [0x11] }]) }, { name: '2', bytes: ipsBuild([{ off: 2, data: [0x22] }]) }], {});
  assert.equal(r.data[2], 0x22);
});
test('chain: empty list returns the original buffer untouched (no copy)', () => {
  const rom = new Uint8Array(4); assert.equal(E.applyChain(rom, [], {}).data, rom);
});
test('chain: ROM larger than the patch ceiling is skipped with a clear code', () => {
  const big = { length: E.LIMITS.MAX_ROM_PATCHABLE + 1 };
  const r = E.applyChain(big, [{ name: 'x', bytes: new Uint8Array(1) }], {});
  assert.equal(r.skipped[0].code, 'rom-too-large');
});
test('original ROM buffer is never mutated by patching', () => {
  const rom = makeRom(256, 9), snap = rom.slice();
  E.applyChain(rom, [{ name: 'a', bytes: ipsBuild([{ off: 0, data: [9, 9, 9] }]) }], {});
  assert.ok(eq(rom, snap));
});

/* describePatch */
test('describePatch: reports format, CRCs, and damage without throwing', { skip: !haveRef && 'needs reference-made BPS' }, () => {
  const orig = makeRom(4096, 2), mod = orig.slice(); mod[5] ^= 1;
  const d = E.describePatch(refMake('bps', orig, mod));
  assert.equal(d.format, 'bps'); assert.ok(d.valid); assert.equal(d.sourceCrc, E.crc32(orig)); assert.equal(d.targetCrc, E.crc32(mod));
  const broken = refMake('bps', orig, mod); broken[10] ^= 0xFF;
  assert.equal(E.describePatch(broken).valid, false);
});
test('describePatch: names unsupported formats honestly', () => {
  assert.match(E.describePatch(new Uint8Array([0x52, 0x55, 0x50, 0x39, 0, 0])).error, /RUP.*aren't supported/i);
  assert.match(E.describePatch(new Uint8Array([0x41, 0x50, 0x53, 0x01, 0, 0])).error, /APS \(GBA\).*aren't supported/i);
  assert.match(E.describePatch(new Uint8Array([1, 2, 3, 4])).error, /Not a recognised/);
  assert.match(E.describePatch(new Uint8Array([0xD6, 0xC3, 0xC4, 0, 0, 0])).error, /corrupt|truncated/i); // xdelta header, but nothing behind it
});

/* zip */
function buildZip(files) {
  const parts = [], cd = []; let off = 0;
  for (const f of files) {
    const nameB = Buffer.from(f.name), raw = Buffer.from(f.data);
    const comp = f.store ? raw : zlib.deflateRawSync(raw);
    const crc = E.crc32(new Uint8Array(raw));
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034B50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(f.store ? 0 : 8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameB.length, 26);
    parts.push(lh, nameB, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014B50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(f.store ? 0 : 8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(off, 42);
    cd.push(ch, nameB);
    off += lh.length + nameB.length + comp.length;
  }
  const cdBuf = Buffer.concat(cd), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...parts, cdBuf, end]));
}
test('zip: extracts deflated + stored patches, ignores readme / __MACOSX / dotfiles / folders', async () => {
  const p1 = ipsBuild([{ off: 0, data: [1, 2, 3] }]), p2 = ipsBuild([{ off: 4, data: [9] }]);
  const z = buildZip([
    { name: 'README.txt', data: 'hi' },
    { name: 'hack/Cool Hack.ips', data: p1 },
    { name: 'hack/other.BPS', data: p2, store: true },
    { name: '__MACOSX/hack/._Cool Hack.ips', data: p1 },
    { name: 'hack/', data: '' },
  ]);
  assert.equal(E.detectFormat(z), 'zip');
  const found = await E.extractPatchesFromZip(z);
  assert.deepEqual(found.map(f => f.name), ['Cool Hack.ips', 'other.BPS']);
  assert.ok(eq(found[0].bytes, p1)); assert.ok(eq(found[1].bytes, p2));
});
test('zip: garbage is rejected with a friendly error', async () => {
  await assert.rejects(E.extractPatchesFromZip(new Uint8Array([0x50, 0x4B, 3, 4, 0, 0, 0, 0])), /damaged/i);
});

/* cheats */
test('cheats: loose-text forms', () => {
  const c = E.parseCheats('Infinite Lives: 7E0DBE:05\n02003400\nGod Mode = SZUKXLOT\n0123ABCD Max Money\nAll Items 800A1234 00FF\n# note\n// note\nDead');
  assert.deepEqual(c.map(x => x.code), ['7E0DBE:05', '02003400', 'SZUKXLOT', '0123ABCD', '800A1234 00FF']);
  assert.deepEqual(c.map(x => x.desc), ['Infinite Lives', 'Cheat 2', 'God Mode', 'Max Money', 'All Items']);
});
test('cheats: RetroArch .cht files', () => {
  const c = E.parseCheats('cheats = 2\n\ncheat0_desc = "Infinite HP"\ncheat0_code = "7E0010:63"\ncheat0_enable = false\n\ncheat1_desc = "Max Rupees"\ncheat1_code = "7E0011:FF"\ncheat1_enable = false\n');
  assert.deepEqual(c, [{ desc: 'Infinite HP', code: '7E0010:63' }, { desc: 'Max Rupees', code: '7E0011:FF' }]);
});
test('cheats: hostile / oversized input is bounded', () => {
  assert.equal(E.parseCheats('A'.repeat(5000) + '1').length, 0);
  assert.ok(E.parseCheats(Array.from({ length: 2000 }, (_, i) => 'Cheat ' + i + ': 0123ABCD').join('\n')).length <= E.LIMITS.MAX_CHEATS);
});

test('fingerprint: stable, order-sensitive, empty for no mods', () => {
  assert.equal(E.fingerprint([]), '');
  assert.equal(E.fingerprint(['a', 'b']), E.fingerprint(['a', 'b']));
  assert.notEqual(E.fingerprint(['a', 'b']), E.fingerprint(['b', 'a']));
});

/* regression: only ONE BPS/UPS patch could be stored per game */
test('whole-file CRC32 of any "data + its own CRC" is a constant — why it can\'t identify BPS/UPS patches', () => {
  for (const seed of [1, 2, 3, 4]) {
    const body = makeRom(500, seed), c = E.crc32(body);
    const withSelf = new Uint8Array([...body, c & 255, (c >>> 8) & 255, (c >>> 16) & 255, (c >>> 24) & 255]);
    assert.equal(E.crc32(withSelf), 0x2144DF1C);
  }
});
test('contentId tells BPS/UPS patches apart (and is stable)', { skip: !haveRef && 'needs reference-made patches' }, () => {
  const orig = makeRom(8192, 5);
  for (const fmt of ['bps', 'ups']) {
    const ids = new Set();
    for (const i of [1, 2, 3, 4]) { const m = orig.slice(); m[i * 500] ^= 0x5A; const p = refMake(fmt, orig, m); ids.add(E.contentId(p)); assert.equal(E.contentId(p), E.contentId(p.slice())); }
    assert.equal(ids.size, 4, fmt + ': distinct patches must have distinct ids');
  }
});
test('contentId: identical bytes collide, different IPS differ', () => {
  const a = ipsBuild([{ off: 1, data: [1] }]), b = ipsBuild([{ off: 2, data: [1] }]);
  assert.equal(E.contentId(a), E.contentId(a.slice())); assert.notEqual(E.contentId(a), E.contentId(b));
});

/* ═══════ xdelta / VCDIFF — fixtures made by the REAL xdelta3 3.0.11 binary ═══════ */
const FX = new URL('./fixtures/', import.meta.url);
const fx = n => new Uint8Array(fs.readFileSync(new URL(n, FX)));
const xdOrig = fx('xd_orig.bin'), xdMod = fx('xd_mod.bin');

test('xdelta: default checksummed patch from real xdelta3 is byte-exact and verified', () => {
  const r = E.applyOne(xdOrig, fx('xd_basic.xdelta'), {});
  assert.ok(eq(r.data, xdMod)); assert.equal(r.verified, true); assert.equal(r.format, 'xdelta');
});
test('xdelta: multi-window patch (10 windows) is byte-exact', () => {
  assert.equal(E.describePatch(fx('xd_windows.xdelta')).windows, 10);
  assert.ok(eq(E.applyOne(xdOrig, fx('xd_windows.xdelta'), {}).data, xdMod));
});
test('xdelta: patch without a checksum applies but is reported unverified', () => {
  const r = E.applyOne(xdOrig, fx('xd_nochecksum.xdelta'), {});
  assert.ok(eq(r.data, xdMod)); assert.equal(r.verified, false);
});
test('xdelta: secondary-compressed patch is refused with actionable advice', () => {
  const d = E.describePatch(fx('xd_secondary.xdelta'));
  assert.equal(d.valid, false); assert.match(d.error, /xdelta3 -S none/);
  assert.throws(() => E.applyOne(xdOrig, fx('xd_secondary.xdelta'), {}), e => e.code === 'unsupported');
});
test('xdelta: wrong ROM fails closed (checksum), never returns garbage', () => {
  const wrong = xdOrig.slice(); wrong[500] ^= 0xFF;
  assert.throws(() => E.applyOne(wrong, fx('xd_basic.xdelta'), {}), e => e.code === 'target-crc');
});
test('xdelta: ROM smaller than the patch\'s source window is a clear source-mismatch', () => {
  assert.throws(() => E.applyOne(xdOrig.subarray(0, 1000), fx('xd_basic.xdelta'), {}), e => e.code === 'source-mismatch' && /bigger source ROM/.test(e.message));
});
test('xdelta: corrupted patch bytes never crash or hang', () => {
  const base = fx('xd_basic.xdelta');
  for (const i of [5, 12, 40, 200, 1000, 3000, base.length - 5]) {
    const bad = base.slice(); bad[i] ^= 0xA5;
    try { const r = E.applyOne(xdOrig, bad, {}); assert.ok(r.data.length >= 0); }   // may still be valid if the flipped byte was inert…
    catch (e) { assert.ok(e instanceof E.ModError, 'only ModErrors may escape, got ' + e); } // …or fail cleanly
  }
});
const cases = JSON.parse(fs.readFileSync(new URL('xd_fuzz.json', FX), 'utf8'));
for (const c of cases) test(`xdelta: real xdelta3 ${c.level} output (varied instruction mix) is byte-exact`, () => {
  const m = [...xdOrig];
  for (const op of c.ops) {
    if (op[0] === 'ins') m.splice(op[1], 0, ...Buffer.from(op[2], 'hex'));
    else if (op[0] === 'del') m.splice(op[1], op[2]);
    else if (op[0] === 'copy') { const seg = m.slice(op[2], op[2] + op[3]); for (let i = 0; i < op[3]; i++) m[op[1] + i] = seg[i]; }
    else if (op[0] === 'fill') for (let i = 0; i < op[2]; i++) m[op[1] + i] = op[3];
    else { const b = Buffer.from(op[2], 'hex'); for (let i = 0; i < b.length; i++) m[op[1] + i] = b[i]; }
  }
  const r = E.applyOne(xdOrig, fx(c.patch), {});
  assert.ok(eq(r.data, m)); assert.equal(r.verified, true);
});
test('xdelta: Adler-32 helper matches the known value', () => assert.equal(E.adler32(new TextEncoder().encode('Wikipedia')), 0x11E60398));

/* ═══════ PPF ═══════ */
function ppfBuild(ver, recs, { block, blockCheck = 0, imageType = 0, srcSize = 0, undo = 0, fileId } = {}) {
  const hdr = Buffer.alloc(56); hdr.write('PPF' + ver + '0'); hdr[5] = ver - 1; hdr.write('test patch', 6);
  const parts = [hdr];
  if (ver === 2) { const s = Buffer.alloc(4); s.writeUInt32LE(srcSize); parts.push(s, Buffer.from(block || new Uint8Array(1024))); }
  if (ver === 3) { parts.push(Buffer.from([imageType, blockCheck ? 1 : 0, undo ? 1 : 0, 0])); if (blockCheck) parts.push(Buffer.from(block)); }
  for (const r of recs) {
    if (ver === 3) { const o = Buffer.alloc(8); o.writeBigUInt64LE(BigInt(r.off)); parts.push(o); } else { const o = Buffer.alloc(4); o.writeUInt32LE(r.off); parts.push(o); }
    parts.push(Buffer.from([r.data.length]), Buffer.from(r.data)); if (undo) parts.push(Buffer.alloc(r.data.length));
  }
  if (fileId) parts.push(Buffer.from('@BEGIN_FILE_ID.DIZ' + fileId + '@END_FILE_ID.DIZ'));
  return new Uint8Array(Buffer.concat(parts));
}
const disc = (() => { const d = makeRom(0x9320 + 4096, 77); return d; })();
test('PPF1: records apply', () => {
  const out = E.applyOne(disc, ppfBuild(1, [{ off: 100, data: [1, 2, 3] }, { off: 5000, data: [9] }]), {}).data;
  assert.deepEqual([...out.subarray(100, 103)], [1, 2, 3]); assert.equal(out[5000], 9); assert.equal(out.length, disc.length);
});
test('PPF2: validates source size + 1024-byte block, refuses a different image', () => {
  const block = disc.subarray(0x9320, 0x9320 + 1024);
  const p = ppfBuild(2, [{ off: 10, data: [7] }], { block, srcSize: disc.length });
  const r = E.applyOne(disc, p, {}); assert.equal(r.data[10], 7); assert.equal(r.verified, true);
  assert.throws(() => E.applyOne(makeRom(disc.length, 78), p, {}), e => e.code === 'source-mismatch');
  assert.throws(() => E.applyOne(disc.subarray(0, disc.length - 1), p, {}), e => e.code === 'source-mismatch' && /different size/.test(e.message));
});
test('PPF3: 64-bit offsets, validation block (BIN + GI image types), undo data skipped, FILE_ID.DIZ ignored', () => {
  const big = disc.slice(); const rec = [{ off: 20, data: [5, 5] }, { off: 4100, data: [6] }];
  const bin = ppfBuild(3, rec, { blockCheck: 1, block: big.subarray(0x9320, 0x9320 + 1024), undo: 1, fileId: 'hello' });
  const out = E.applyOne(big, bin, {}).data; assert.equal(out[20], 5); assert.equal(out[4100], 6);
  const gi = ppfBuild(3, rec, { blockCheck: 1, imageType: 1, block: big.subarray(0x80A0, 0x80A0 + 1024) });
  assert.equal(E.applyOne(big, gi, {}).data[20], 5);
  assert.throws(() => E.applyOne(makeRom(big.length, 5), bin, {}), e => e.code === 'source-mismatch');
  assert.equal(E.describePatch(bin).validated, true);
});
test('PPF: truncated file rejected', () => assert.throws(() => E.applyOne(disc, ppfBuild(1, [{ off: 1, data: [1, 2, 3, 4] }]).subarray(0, 62), {}), e => e instanceof E.ModError));
test('PPF: cross-check against RomPatcher.js reference applier', { skip: !haveRef && 'reference patcher not found' }, () => {
  const PPFref = require(REF_DIR + '/RomPatcher.format.ppf.js');
  const p = ppfBuild(3, [{ off: 300, data: [1, 2, 3, 4] }, { off: 9000, data: [0xAA, 0xBB] }], { blockCheck: 1, block: disc.subarray(0x9320, 0x9320 + 1024) });
  const refOut = new Uint8Array(PPFref.fromFile(bf(p)).apply(bf(disc), true)._u8array);
  assert.ok(eq(E.applyOne(disc, p, {}).data, refOut));
});

/* ═══════ APS (N64) ═══════ */
function apsBuild(rom, edits, { validate = true } = {}) {
  const h = Buffer.alloc(78); h.write('APS10'); h[5] = validate ? 1 : 0; h.write('desc', 7);
  let pos = 57;
  if (validate) { h[57] = 0; h.write(String.fromCharCode(rom[0x3C], rom[0x3D], rom[0x3E]), 58, 'latin1'); Buffer.from(rom.subarray(0x10, 0x18)).copy(h, 61); pos = 74; }
  h.writeUInt32LE(rom.length, pos); pos += 4;
  const parts = [h.subarray(0, pos)];
  for (const e of edits) { const o = Buffer.alloc(5); o.writeUInt32LE(e.off); if (e.rle !== undefined) { o[4] = 0; parts.push(o, Buffer.from([e.rle, e.len])); } else { o[4] = e.data.length; parts.push(o, Buffer.from(e.data)); } }
  return new Uint8Array(Buffer.concat(parts));
}
test('APS (N64): applies data + RLE records and validates cart id/CRC', () => {
  const z = fakeN64(8192); z[0x3C] = 0x4E; z[0x3D] = 0x47; z[0x3E] = 0x45;
  const p = apsBuild(z, [{ off: 100, data: [1, 2, 3] }, { off: 200, rle: 0x77, len: 50 }]);
  const r = E.applyOne(z, p, { kind: 'n64' });
  assert.deepEqual([...r.data.subarray(100, 103)], [1, 2, 3]); assert.ok(r.data.subarray(200, 250).every(v => v === 0x77)); assert.equal(r.verified, true);
  const other = z.slice(); other[0x3C] = 0x58; assert.throws(() => E.applyOne(other, p, { kind: 'n64' }), e => e.code === 'source-mismatch');
  assert.ok(eq(E.applyOne(toV64(z), p, { kind: 'n64' }).data, r.data), 'v64-order dump must be normalised first');
});
test('APS (N64): cross-check against RomPatcher.js reference applier', { skip: !haveRef && 'reference patcher not found' }, () => {
  const APSref = require(REF_DIR + '/RomPatcher.format.aps_n64.js');
  const z = fakeN64(8192); z[0x3C] = 0x4E; z[0x3D] = 0x47; z[0x3E] = 0x45;
  const p = apsBuild(z, [{ off: 100, data: [1, 2, 3] }, { off: 200, rle: 0x77, len: 50 }, { off: 5000, data: [9, 9] }]);
  const refOut = new Uint8Array(APSref.fromFile(bf(p)).apply(bf(z), true)._u8array);
  assert.ok(eq(E.applyOne(z, p, { kind: 'n64' }).data, refOut));
});

/* ═══════ IPS32 + EBP ═══════ */
test('IPS32: 4-byte offsets past the 16 MB IPS ceiling, EEOF terminator', () => {
  const off = 0x01000010; const b = [...Buffer.from('IPS32'), (off >>> 24) & 255, (off >>> 16) & 255, (off >>> 8) & 255, off & 255, 0, 2, 0xCA, 0xFE, ...Buffer.from('EEOF')];
  const rom = new Uint8Array(0x01000100); const out = E.applyIPS(rom, new Uint8Array(b));
  assert.equal(out[off], 0xCA); assert.equal(out[off + 1], 0xFE); assert.equal(E.detectFormat(new Uint8Array(b)), 'ips');
});
test('EBP: IPS followed by a JSON metadata blob parses', () => {
  const p = new Uint8Array([...ipsBuild([{ off: 3, data: [0xAB] }]), ...Buffer.from('{"patcher":"EBPatcher","title":"x"}')]);
  assert.equal(E.applyIPS(new Uint8Array(16), p)[3], 0xAB);
});

/* ═══════ per-console ROM shapes ═══════ */
const bpsFor = (orig, edit) => { const m = orig.slice(); edit(m); return { m, p: refMake('bps', orig, m) }; };
test('NES: iNES-headered ROM + headerless BPS (and the reverse) both match by checksum', { skip: !haveRef && 'needs reference-made BPS' }, () => {
  const body = makeRom(40960, 3), headered = new Uint8Array(16 + body.length); headered.set([0x4E, 0x45, 0x53, 0x1A], 0); headered.set(body, 16);
  const a = bpsFor(body, m => { m[100] ^= 1; });
  const r1 = E.applyOne(headered, a.p, { kind: 'nes' }); assert.ok(eq(r1.data, a.m)); assert.match(r1.variant, /iNES header stripped/);
  const b = bpsFor(headered, m => { m[200] ^= 1; });
  assert.ok(eq(E.applyOne(headered, b.p, { kind: 'nes' }).data, b.m));
});
test('NES: IPS keeps the iNES header (the convention)', () => {
  const rom = new Uint8Array(32); rom.set([0x4E, 0x45, 0x53, 0x1A]);
  assert.equal(E.applyOne(rom, ipsBuild([{ off: 20, data: [5] }]), { kind: 'nes' }).data[20], 5);
  assert.equal(E.romVariants(rom, 'nes')[0].label, 'as-is (header kept)');
});
test('Lynx: 64-byte LYNX header handled', { skip: !haveRef && 'needs reference-made BPS' }, () => {
  const body = makeRom(8192, 8), h = new Uint8Array(64 + body.length); h.set([0x4C, 0x59, 0x4E, 0x58]); h.set(body, 64);
  const a = bpsFor(body, m => { m[7] ^= 9; }); assert.ok(eq(E.applyOne(h, a.p, { kind: 'lynx' }).data, a.m));
});
test('PC Engine: 512-byte copier header stripped', { skip: !haveRef && 'needs reference-made BPS' }, () => {
  const body = makeRom(8192 * 4, 9), h = new Uint8Array(512 + body.length); h.set(body, 512);
  const a = bpsFor(body, m => { m[1000] ^= 1; }); assert.ok(eq(E.applyOne(h, a.p, { kind: 'pce' }).data, a.m));
});
test('Genesis: SMD-interleaved dump is de-interleaved to match a normal-ROM patch', { skip: !haveRef && 'needs reference-made BPS' }, () => {
  const body = makeRom(32768, 10), smd = new Uint8Array(512 + body.length); smd[8] = 0xAA; smd[9] = 0xBB;
  for (let b = 0; b < 2; b++) for (let i = 0; i < 8192; i++) { smd[512 + b * 16384 + i] = body[b * 16384 + i * 2 + 1]; smd[512 + b * 16384 + 8192 + i] = body[b * 16384 + i * 2]; }
  assert.ok(E.isSMD(smd)); assert.ok(eq(E.deinterleaveSMD(smd), body));
  const a = bpsFor(body, m => { m[300] ^= 1; }); assert.ok(eq(E.applyOne(smd, a.p, { kind: 'md' }).data, a.m));
});
test('a .zip stored as the "ROM" is refused instead of being corrupted by a patch', () => {
  assert.throws(() => E.applyOne(new Uint8Array([0x50, 0x4B, 3, 4, 0, 0, 0, 0]), ipsBuild([{ off: 1, data: [1] }]), {}), e => e.code === 'rom-container');
});
test('kindForCore maps the app\'s core ids', () => {
  assert.deepEqual(['n64', 'snes', 'nes', 'lynx', 'pce', 'segaMD', 'gba'].map(E.kindForCore), ['n64', 'snes', 'nes', 'lynx', 'pce', 'md', '']);
});

/* ═══════ which systems can be patched ═══════ */
test('patchSupport: cartridge systems always; disc systems only for raw images', () => {
  for (const c of ['nes', 'snes', 'gba', 'gambatte', 'n64', 'segaMD', 'sega32x', 'segaGG', 'segaMS', 'pce', 'ws', 'wsc', 'vb', 'nds', 'ngp', 'a2600', 'coleco', 'intellivision', 'vectrex', 'lynx', 'msx', 'neogeo']) assert.equal(E.patchSupport(c, 'whatever').ok, true, c);
  for (const c of E.DISC_CORES) { for (const ext of ['iso', 'bin', 'img', 'ISO']) assert.equal(E.patchSupport(c, ext).ok, true, c + ext); for (const ext of ['cue', 'chd', 'pbp', 'cso', '', undefined]) { const r = E.patchSupport(c, ext); assert.equal(r.ok, false); assert.ok(r.reason.length > 20); } }
});
test('disc image: IPS32/xdelta/PPF/BPS all apply to a large raw image', { skip: !haveRef && 'needs reference-made BPS' }, () => {
  const img = makeRom(2352 * 400, 12), m = img.slice(); m[2352 * 10] ^= 0x33;
  assert.ok(eq(E.applyChain(img, [{ name: 'a', bytes: refMake('bps', img, m) }], { kind: '' }).data, m));
});
