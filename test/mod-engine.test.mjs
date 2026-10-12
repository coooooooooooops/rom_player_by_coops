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
  assert.ok(r.notes.some(n => /no checksum/.test(n)));
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
  assert.match(E.describePatch(new Uint8Array([0xD6, 0xC3, 0xC4, 0, 0, 0])).error, /xdelta.*aren't supported/i);
  assert.match(E.describePatch(new Uint8Array([1, 2, 3, 4])).error, /Not a recognised/);
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
