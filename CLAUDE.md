# Krautrecker

A browser-based SNES music tracker: high-level song in, compiled 8-voice IR out, played by an S-DSP
model. Scope and principles come from [docs/KICKOFF.md](docs/KICKOFF.md); how and why the code works as
it does is in [docs/design.md](docs/design.md). Read both before structural changes.

## Rules every change must keep

1. **The project file is the only source.** Never store IR, BRR data or other derived data in the
   project. The IR is rebuilt from the project on every change.
2. **The compiler is deterministic.** No `Math.random()`, `Date`, locale or iteration over object keys
   in `src/compiler/`, `src/brr/` or `src/dsp/`. Randomness uses `mulberry32` seeded from
   `project.seed`. The determinism tests in `src/compiler/compile.test.ts` must stay green.
3. **One playback path.** The song is only ever played from compiled IR through `Sequencer` and `SDsp`.
   Live play goes through `LivePlayer`, which reuses the compiler's `TrackProcessor` and
   `VoiceAllocator`; put device rules there, never in a separate live-only path, and never play
   high-level data directly.
4. **The core stays pure.** `model`, `compiler`, `brr`, `dsp` (except `worklet.ts`) and `util` must not
   touch the DOM, so they run in tests and in the AudioWorklet.
5. **Hardware limits are shown, not enforced.** When the composer exceeds a limit, the compiler
   resolves it and emits a `Diagnostic` with a `SourceRef`; it never refuses input.
6. **Schema changes need a migration.** Bump `SCHEMA_VERSION` in `src/model/defaults.ts` and add a step
   to `MIGRATIONS` in `src/model/schema.ts`.

## Working rules

- `npm test` and `npm run build` must pass before you call work done.
- A new device rule, effect or allocation rule comes with a compiler test. Golden snapshots live in
  `src/compiler/__snapshots__/`; check a changed snapshot by hand before updating it with `vitest -u`.
- On Windows, run Vitest from the upper-case drive path (`cd /D/Develop/Krautrecker` in Git Bash);
  a lower-case `d:` path makes every suite fail at `describe`.
- Do not edit `docs/KICKOFF.md` unless asked. Record decisions that go beyond it in `docs/design.md`.
- Keep comments short and explain SNES-specific reasons, as the existing code does.
