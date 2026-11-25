# Project Kickoff: SNES Web Tracker (working title)

## 1. Vision

A browser-based music tracker for composing SNES (Super Nintendo) music. It runs as a static website: no installation, anyone can open it and play.

The key idea: **the composer does not think in SNES limitations.** They work at a higher, musical level (sampler instruments with multisample zones, chords, arpeggiators, drum kits with choke groups). A **compiler** translates the song into classic low-level tracker data for the 8 hardware voices of the SNES S-DSP. The composer never edits that low-level data directly, but can always inspect it and always hears it.

Think: "Renoise-style instruments and tracks on top, FastTracker 2 / SNES-native data underneath, with a compiler in between."

## 2. Core principles (non-negotiable)

1. **Source vs. build artifact.** The project file stores only the high-level song. The low-level 8-voice data (IR) is a build artifact, regenerated on every play or export. It is never saved as the source of truth and never edited by hand.
2. **Deterministic compiler.** Same project in → byte-identical IR out. No `Math.random()`, no time or locale dependencies. Anything "random" (e.g. a random arp) uses a seeded PRNG stored in the project.
3. **One playback path.** The editor always plays the compiled IR, never the high-level data directly. What you hear is what the hardware gets.
4. **Limits are visible, not restrictive.** The composer can write more than the hardware allows. The compiler resolves it (voice stealing, etc.) and the UI shows clearly where and why (voice meter, ARAM meter, warnings).
5. **Pure core, thin UI.** Model, compiler, BRR codec and DSP model are pure TypeScript modules without DOM dependencies, fully unit-testable.

## 3. Architecture overview

```text
Project (high-level, JSON)
   │
   │  Compiler (pure, deterministic)
   │   - expand arpeggios
   │   - pick multisample zone + compute pitch per note
   │   - apply choke groups / mono / legato rules
   │   - allocate hardware voices (8, minus reserved SFX voices)
   │   - voice stealing by priority
   ▼
IR: 8 voice tracks, tick-resolution event streams (read-only, viewable)
   │
   ├──► Player: AudioWorklet running an S-DSP model (prototype)
   │
   └──► Backend (later): BRR sample bank + driver bytecode + ARAM layout → .spc / game data
```

Later backends (other consoles) should be possible from the same IR, but are out of scope.

## 4. Domain model (high level)

All IDs are stable strings. All objects are plain JSON-serializable data.

### Project

- `schemaVersion: number`
- `title`, `author`
- `timing`: `bpm`, `linesPerBeat` (LPB, default 4), `ticksPerLine` (default 6)
- `samples: Sample[]`
- `devices: Device[]`
- `patterns: Pattern[]`
- `order: PatternId[]` (song arrangement)
- `hardware`: `reservedSfxVoices` (0–7, default 0), `echo` settings (see §5)
- `seed: number` (for any seeded randomness)

### Sample

Raw audio, the only thing that costs ARAM.

- `name`
- `pcm`: original audio, mono, 16-bit, base64 in the project file, plus its original sample rate
- `targetRate`: resample rate before BRR encoding (default 32000 Hz; lower = smaller, darker)
- `rootNote`: MIDI note the sample sounds at when played at its native rate
- `fineTune`: cents
- `loop`: `{ enabled, start }` (end = sample end). The BRR encoder must align the loop start to a 16-sample block boundary (resample or pad, and report it).

### Device (the "sampler")

The instrument concept. A track plays exactly one device.

- `name`
- `zones: Zone[]`: multisample mapping
- `mode`: one of
  - `mono`: one voice, each new note retriggers
  - `legato`: one voice, overlapping notes change pitch without retriggering (optional portamento time)
  - `poly`: up to `maxVoices` simultaneous voices (chords cost real voices)
  - `arp`: chords are played as an arpeggio on one voice. Settings: `rate` (ticks per step), `direction` (`up`, `down`, `upDown`, `asPlayed`, `random`[seeded]), `octaves` (1–4)
  - `drum`: each key triggers its zone at a fixed pitch. Zones have an optional `chokeGroup`: a new note in a group cuts the running note of the same group. `maxVoices` applies.
- `maxVoices` (for `poly` and `drum`)
- `priority` (0–255, higher = less likely to be stolen)
- `volume`, `pan`
- `envelope`: default ADSR (see §5) unless the zone overrides it
- `vibrato`: `{ depth, rate, delay }` (optional)
- `echo: boolean`: route the device's voices to the echo unit

### Zone

- `sampleId`
- `keyRange: [lowNote, highNote]`
- `rootNoteOverride?` (defaults to the sample's `rootNote`)
- `fixedPitch?`: for drum zones, play at this pitch regardless of the key
- `volume`, `pan`, `envelope?` (overrides)
- `chokeGroup?` (drum mode)

Zone selection: the zone whose range contains the note; if several overlap, the first one in the list wins. If none matches, use the zone with the nearest root note (and emit a warning).

### Pattern

- `lines: number` (default 64)
- `tracks: Track[]`

### Track

- `deviceId`
- `noteColumns: number` (1–8). More columns allow chords.
- `cells[line][column]`: `{ note?, volume?, pan?, delay?, fx? }`
  - `note`: MIDI note, or `OFF` (note release), or `CUT` (hard cut)
  - `volume`: 0–127 (optional)
  - `pan`: −64..+63 (optional)
  - `delay`: ticks 0..ticksPerLine−1 (note delay, optional)
  - `fx`: small effect set, see §6

## 5. SNES hardware facts the compiler and DSP model must respect

- **8 voices**, mixed at **32 kHz**.
- **Samples are BRR**: 4-bit ADPCM, 9-byte blocks of 16 samples, 4 prediction filters (0–3), shift range. Loops point to block boundaries.
- **Pitch register**: 14-bit; `0x1000` = sample played at 32 kHz. The maximum `0x3FFF` is just under 4×, so a sample can be pitched up by just under **2 octaves**. The compiler must clamp and warn. Pitching down is possible but sounds dull, which is why multisampling matters.
- **Interpolation**: 4-point Gaussian (implement it in the DSP model, it defines the SNES sound).
- **Envelope per voice**: ADSR (attack 16 rates, decay 8 rates, sustain level 8 steps, sustain rate 32 rates) or GAIN mode (direct, linear/bent increase, linear/exponential decrease). The model uses the real hardware rate tables.
- **Volume**: per voice left/right (signed 8-bit), main volume L/R.
- **Echo**: one global unit. Delay in 16 ms steps (0–240 ms), **each 16 ms costs 2 KB of ARAM**. 8-tap FIR filter, feedback, echo volume L/R, per-voice echo enable.
- **Noise** (per-voice enable, global noise clock) and **pitch modulation** (voice n modulated by voice n−1) exist; not in the prototype UI, but keep the IR able to express them.
- **ARAM is 64 KB total** for driver code, sample directory, BRR samples, echo buffer and song data. The prototype shows an estimate: `driverReserve` (assume 8 KB, configurable) + sample directory + BRR sizes + echo buffer + song data estimate.

## 6. Effects (high-level, minimal set for the prototype)

Per cell, at most one `fx` entry:

- `slideUp n` / `slideDown n`: pitch slide (semitones per line, fractional)
- `porta n`: portamento to note
- `vibrato depth rate`
- `volSlide n`
- `cut ticks`: cut the note after n ticks
- `retrig ticks`

Device-level behavior (arp, choke, legato) is not an effect. It comes from the device mode.

## 7. The IR (low-level, compiled)

- Exactly 8 voice lanes (voices `0..7`). Voices reserved for SFX are never used by music.
- Each lane is an ordered list of **tick-resolution events**:
  - `keyOn { sampleSlot, pitch, volL, volR, envelope, echo }`
  - `keyOff`
  - `setPitch { pitch }`
  - `setVolume { volL, volR }`
  - `setEnvelope { ... }`
  - (reserved for later: `noise`, `pitchMod`)
- Global lane: `tempo`, `echo` parameter changes, `mainVolume`.
- Each event carries a **source reference** (pattern, track, line, column) so the UI can link from the IR view back to the note that caused it.
- The compiler also emits **diagnostics**: voice stolen (which note, by whom), pitch clamped, no matching zone, loop realigned, ARAM over budget.

### Voice allocation (deterministic)

Processed in tick order. At each tick, the new note requests are sorted by (device priority desc, track index asc, column index asc). For each request:

1. Device-internal rules first (mono/legato reuse their voice; drum choke cuts the same group; a poly device at its `maxVoices` steals its own oldest voice).
2. Otherwise take a free voice (lowest index first).
3. Otherwise steal by: lowest priority → voices in release phase → oldest note. Never steal from a higher-priority device. If nothing can be stolen, drop the note and emit a diagnostic.

## 8. Prototype scope (Milestone 1)

### In scope

1. **Sample import**: WAV (and anything `decodeAudioData` handles) → mono → resample to `targetRate` → **BRR encode** (choose the best filter/shift per block by minimal error) → BRR decode for playback, so you hear the real BRR artifacts.
2. **Device editor**: zones (key range, root, fixed pitch), mode (mono, legato, poly, arp, drum), maxVoices, priority, ADSR, volume/pan, echo on/off, choke groups for drums.
3. **Pattern editor** (canvas grid, tracker-style): tracks with multiple note columns, cursor navigation, note entry via the computer keyboard (FT2 piano layout, two rows, using `KeyboardEvent.code` so it works on QWERTZ and AZERTY alike), octave switch, note off, volume/pan/fx columns, copy/paste of selections, undo/redo.
4. **Web MIDI input** (Chrome/Edge/Firefox): note entry in edit mode, live play of the selected device. Fail gracefully if unsupported (Safari).
5. **Order list**: arrange patterns into a song.
6. **Compiler** → IR, with incremental recompilation per pattern.
7. **IR view**: read-only, tracker-style 8-column display with stolen/clamped notes highlighted; clicking an event selects its source cell.
8. **Player**: AudioWorklet S-DSP model (BRR playback, Gaussian interpolation, pitch register semantics, ADSR/GAIN with hardware tables, L/R volume, echo with FIR). Play song, play pattern, play from cursor, loop.
9. **Meters**: voice usage over time (per line), ARAM estimate with breakdown.
10. **Persistence**: autosave to IndexedDB; export/import the project as a single `.json` file (samples base64-encoded). `schemaVersion` from day one.

### Out of scope (later milestones)

- SPC700 sound driver and `.spc` export (Milestone 2; evaluate existing open-source SNES drivers vs. our own)
- Running a real SPC700/S-DSP emulator (e.g. compiled to WASM) as a "hardware-exact" player
- Noise and pitch modulation in the UI
- Sample editor beyond trim/loop point
- Collaboration, accounts, server backend
- Other console backends

## 9. Tech stack

- **TypeScript** (strict), **Vite**, static build deployable to any static host (HTTPS is required for Web MIDI).
- **React** for panels/dialogs; the **pattern grid and IR view are rendered on `<canvas>`** for performance.
- **AudioWorklet** for the DSP model; the compiler runs on the main thread or in a Web Worker (it must not block the UI on large songs).
- **Vitest** for unit tests.
- No backend.

Suggested layout:

```text
src/
  model/      types, schema, migrations, defaults
  compiler/   high-level → IR, voice allocator, diagnostics
  brr/        encoder, decoder
  dsp/        S-DSP model (pure), AudioWorklet wrapper
  io/         project load/save, WAV import, IndexedDB
  midi/       Web MIDI input
  ui/         React app, canvas grid, IR view, meters
```

## 10. Quality requirements

- **Compiler tests**: golden tests (project fixture → expected IR snapshot) for each device mode, choke, arp directions, voice stealing, reserved SFX voices, pitch clamping, zone selection.
- **Determinism test**: compiling the same project twice gives identical output; compiling with a shuffled object key order gives identical output.
- **BRR tests**: encode → decode round trip within an error bound; loop alignment; known reference blocks.
- **DSP tests**: ADSR timing against the hardware rate tables; pitch `0x1000` plays at the native rate; Gaussian interpolation table correctness.
- Model types and compiler are documented with short doc comments explaining SNES-specific reasons.

## 11. Definition of done for the prototype

A user can open the site, import a few WAV samples, build a multisampled synth device in arp mode and a drum device with a choke group, write a short song with chords using keyboard or MIDI, press play, and hear it through the S-DSP model. They see the IR view with the 8 voices, the voice meter, the ARAM estimate, and diagnostics when they write more voices than available. They can save the project as JSON and reload it with an identical result.

## 12. Open decisions (defaults chosen, change if needed)

| Topic | Default for the prototype |
| --- | --- |
| UI framework | React + canvas grid |
| Timing | BPM + LPB + ticks per line (Renoise-style) |
| Driver reserve in ARAM estimate | 8 KB |
| Player | own S-DSP model in TypeScript; real emulator later |
| Sound driver | decided in Milestone 2 |
| License | MIT (decided; see [LICENSE](../LICENSE)) |
