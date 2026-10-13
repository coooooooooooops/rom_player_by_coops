[![Play Now](https://img.shields.io/badge/▶_Play_Now-romplayerbycoops.pages.dev-7c6af7?style=for-the-badge)](https://romplayerbycoops.pages.dev/)

*It's a PWA — open the link above, then use your browser's "Install" / "Add to Home Screen" prompt to get it as an app icon on desktop or mobile.*

# 🎮 ROM Player by Coops

A browser-based retro gaming PWA. Drop in a ROM, hit play — no installs, no extensions required.

🔗 **[romplayerbycoops.pages.dev](https://romplayerbycoops.pages.dev)**

---

## Supported Systems

| System | Notes |
|---|---|
| Nintendo NES | |
| Nintendo SNES | |
| Nintendo 64 | |
| Game Boy | |
| Game Boy Color | Color correction supported |
| Game Boy Advance | Color correction supported |
| Nintendo DS | BIOS optional |
| Virtual Boy | |
| PlayStation 1 | BIOS required |
| PlayStation Portable | BIOS optional |
| Sega Master System | |
| Sega Genesis / Mega Drive | |
| Sega CD | BIOS required |
| Sega Saturn | BIOS required |
| Sega 32X | |
| Sega Game Gear | |
| Neo Geo | |
| Neo Geo Pocket | |
| PC Engine / TurboGrafx-16 | |
| WonderSwan / WonderSwan Color | |
| Atari 2600 | |
| Atari Lynx | |
| ColecoVision | |
| Intellivision | |
| Vectrex | |
| MSX | |

**PSP notes:** runs on EmulatorJS's nightly core channel (the stable channel has a known hardware-rendering bug); defaults to the JIT CPU core rather than the slower IR JIT interpreter PPSSPP itself ships as its safe-but-slow default, since JIT measurably reduces audio grain during normal gameplay. Threaded WASM (requires the COOP/COEP headers this app already ships) and rewind is disabled outright — see `emulator-backbone.js` for the full reasoning on both.

---

## Features

**Core**
- Save states — save and load anytime
- Rewind — per-core tuned buffer sizes (PS1: 512MB, N64/GBA/SNES: 256MB, NES/GB/GBC/Genesis: 128MB). Disabled outright for PSP — it's already the heaviest core here, and periodic full-state snapshots for rewind cost more than they're worth on it (see PSP notes below)
- Cover art — auto-fetched via libretro thumbnail CDN
- Fullscreen — native + pseudo-fullscreen with iPhone notch support
- Gamepad support — plug in a controller and go
- Keyboard shortcuts — press `?` in-app for the cheat sheet
- Offline play — full PWA with service worker caching

**Mod Loader** (per game, from the game's detail page → 🧩 Mods)
- Patches — IPS (incl. IPS32 and EBP), BPS, UPS, **xdelta/VCDIFF**, **PPF 1/2/3** and **N64 APS**, also inside a .zip. Store as many as you like per game; pick which ONE plays (or the original game) with the circle next to it. Rename them, check them against your game, remove them. Applied in memory on top of the stored ROM at launch; the original is never modified
- Every cartridge/ROM-file system is supported (NES, SNES, GB/GBC, GBA, DS, N64, Genesis/Mega Drive, 32X, Master System, Game Gear, PC Engine, Neo Geo, Atari 2600/Lynx, ColecoVision, Intellivision, Vectrex, MSX, WonderSwan, Virtual Boy, NGP). Disc systems (PS1, PSP, Saturn, Sega CD) are supported for raw **.iso/.bin/.img** images; .cue/.chd/.pbp/.cso are containers or index files and are refused with an explanation rather than corrupted
- Console quirks handled automatically: N64 byte order (z64/v64/n64), SNES and PC Engine copier headers, NES iNES and Lynx headers (both tried, checksum-verified), Genesis SMD interleave
- `Check against my game` dry-runs the real patch through the same code path as launch
- BPS/UPS are checksum-verified (source, target and patch CRC32); xdelta (when built with its Adler-32), PPF 2/3 and N64 APS validate against the game; all are refused if they were built for a different version. IPS and unchecksummed xdelta/PPF1 are flagged "unverified"
- Not supported: RUP, GBA-style APS, and xdelta files built with secondary compression (re-create with `xdelta3 -S none`)
- N64 byte-order (z64/v64/n64) and SNES copier headers are handled automatically
- Cheats — paste codes or import a RetroArch `.cht`/`.txt`; enabled cheats switch on when the game starts
- Save states record which mod they were made under and warn before loading one made under a different mod (or the original)
- Everything stays on the device (IndexedDB `mods` store, DB v6) — never synced or exported. Cheats work on every system
- Engine is `mod-engine.js` (DOM-free); tests: `node --test test/mod-engine.test.mjs` (cross-checked against RomPatcher.js when `ROMPATCHER_REF` points at its `modules/` folder)

**Library**
- ROM library with metadata stored in IndexedDB
- ROM binaries stored in OPFS for fast local access
- Playtime tracking and game history

**BIOS Management**
- Upload and store BIOS files locally (OPFS)
- Required: PS1, Sega CD, Saturn
- Optional: NDS, PSP

**Themes**
- 8 free themes: Deep Space (default), Nintendo NES, Super Nintendo, Game Boy, Nintendo 64, Sega Genesis, Game Boy Advance, PlayStation
- 8 premium themes: DOOM, Dreamcast, Cyber Neon, Virtual Boy, GBA SP Cobalt, Sega Saturn, Neo Geo MVS, Famicom Disk
- Custom theme editor (premium) — pick your own background + accent colour, live preview
- CRT Screen Texture — subtle scanlines, curved-edge vignette, and a theme-tinted phosphor glow layered into the background on every theme. Pure CSS (no DOM overlay, never sits on top of anything, can't affect legibility); toggle off in Settings → App if you'd rather not see it

**Linkup Room**
- P2P room (up to 4 people) via PeerJS — no server, direct peer-to-peer
- Share a save state — pick from your saved states (with screenshot previews); recipients are asked to confirm before it's applied to their Quick Save, and it's never guessed onto a game they don't own
- Share a file — screenshots, cheat files, config exports, anything else, straight to the recipient's device
- Does not share ROMs or game files of any kind — this app never facilitates ROM distribution over Linkup Room or otherwise

---

## Free vs Premium

| Feature | Free | Premium |
|---|---|---|
| Play ROMs | ✅ | ✅ |
| Save states | ✅ | ✅ |
| Rewind | ✅ | ✅ |
| Cover art | ✅ | ✅ |
| Linkup Room | ✅ | ✅ |
| Cloud save sync | ❌ | ✅ |
| Library sync across devices | ❌ | ✅ |
| Cloud ROM storage (Drive/Dropbox) | ❌ | ✅ |

Premium is **$3 AUD/month** — or by invite code.

---

## Tech Stack

- **[EmulatorJS](https://emulatorjs.org)** (libretro cores) — the actual emulation engine. All emulation happens here; ROM Player is a frontend around it.
- **[coops_emulator_backbone](https://github.com/coops-emulator/coops_emulator_backbone)** — our own wrapper around EmulatorJS (`emulator-backbone.js`), used to boot every system it covers. Replaced this app's previous hand-rolled `EJS_*` global wiring with a promise-based `loadGame()` API, a verified system-id registry, and actionable errors instead of silent black screens. Systems it doesn't cover yet (Virtual Boy, Intellivision, Vectrex, MSX) fall back to the original direct wiring.
- **PeerJS** — P2P File Exchange
- **Supabase** — auth + user profiles + premium status
- **Cloudflare Pages** — hosting + edge functions
- **IndexedDB + OPFS** — local ROM and save state storage
- **Service Worker** — offline support + PWA caching

---

## Credits

- **[EmulatorJS](https://emulatorjs.org)** does all the actual emulation (the libretro cores, the WASM runtime, the loader). ROM Player and coops_emulator_backbone are both just frontends around it — full credit to the EmulatorJS project and the libretro cores it bundles.
- **[coops_emulator_backbone](https://github.com/coops-emulator/coops_emulator_backbone)** is our own EmulatorJS wrapper, developed alongside this app; `emulator-backbone.js` in this repo is a vendored build of it.

---

## Deployment

```bash
# Stamp a new version and deploy
sh deploy.sh
```

Version timestamps are generated at deploy time (`YYYYMMDDHHMMSS` UTC) and must be written **identically, simultaneously, to all five references**: `APP_VERSION` in `index.html`, the `emulator-backbone.js?v=` cache-bust query string (appears in both `index.html` and `sw.js`), `CACHE_VERSION` in `sw.js`, and `version.json`. Never reuse an old timestamp, and never update a subset of these — a mismatch is what causes cache/update bugs, not just an old timestamp.

---

## Notes

- ROM files are never uploaded to any server — everything stays on your device
- BIOS files are stored locally in OPFS, never transmitted
- Premium validation is handled server-side via Cloudflare Workers + Supabase

---

## Legal

ROM Player by Coops is an independent emulator project. It is not affiliated with, authorized, endorsed, or sponsored by Nintendo, Sony, Sega, SNK, Atari, NEC, Bandai, or any other hardware manufacturer or rights holder. All trademarks, system names, and brand names are the property of their respective owners.

ROM Player does not distribute, host, or facilitate the downloading of copyrighted ROM or BIOS files. Users are solely responsible for ensuring they have the legal right to use any software they load into the emulator.

This project is source-available under a proprietary license — see [LICENSE](LICENSE) for the full terms (viewing, forking for private/non-commercial experimentation, and contributions are permitted; this is not an open-source license and does not grant redistribution or commercial-use rights).

---

*Built by [Coops](https://github.com/coops-emulator)*
