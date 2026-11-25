# Krautrecker

Krautrecker is a browser-based music tracker for composing SNES music. You write with high-level
instruments (multisampled sampler devices with mono, legato, poly, arpeggio and drum modes), and a
compiler turns the song into low-level data for the 8 hardware voices of the SNES sound chip. What you
hear is always that compiled data, played by a model of the S-DSP running in an AudioWorklet.

This is the Milestone 1 prototype described in [docs/KICKOFF.md](docs/KICKOFF.md). It opens with a
small demo song built from synthesized samples, so it makes sound before you import anything.

## Run it

You need Node.js 22 or newer.

```sh
npm install
npm run dev        # development server at http://localhost:5173
npm test           # unit tests (Vitest)
npm run build      # type check + static build into dist/
npm run preview    # serve the static build
```

The build is a plain static site and runs from any static host. Web MIDI needs HTTPS (or localhost) and
works in Chrome, Edge and Firefox; Safari has no Web MIDI, and the app runs without it.

On Windows, run the tests from a path with an upper-case drive letter (`D:\...`, not `d:\...`).
Vitest 5 loads modules twice under a lower-case drive path and every suite fails with
"Cannot read properties of undefined (reading 'config')".

## Using it

The pattern editor works like FastTracker 2 or Renoise. The bottom line of the app lists the keys; the
most important ones:

| Key | Action |
|---|---|
| Z…M, Q…P (two piano rows) | enter a note; works by key position, so QWERTZ and AZERTY behave like QWERTY |
| 1 / ^ (key left of 1) | note off / note cut |
| Esc | toggle edit mode (off: keys only play the device) |
| Space, Shift+Space, Enter | play song / play pattern / play from cursor |
| Shift+arrows, Ctrl+C/X/V | select, copy, cut, paste |
| Ctrl+Z, Ctrl+Y | undo, redo |

Each note column has five fields: note, volume (`00`–`7F`), pan (`00`–`7F`, `40` is centre), note delay
in ticks, and one effect. Effects are a letter plus one hex byte and act only on the line they are on:
`U`/`D` slide up/down by xx/16 semitones per line, `P` glides to the note, `V` vibrato (x = depth in
quarter semitones, y = speed), `A` volume slide (x up, y down per tick), `C` cut after xx ticks, `R`
retrigger every xx ticks.

The project autosaves to the browser (IndexedDB). **Save** downloads it as a single `.json` file with the
samples inside; **Open** loads one back.

## Where to read next

- [docs/KICKOFF.md](docs/KICKOFF.md): the product brief and the source of truth for scope.
- [docs/design.md](docs/design.md): how the compiler, voice allocator and DSP model work, and why.
- [CLAUDE.md](CLAUDE.md): the rules every change must follow.
