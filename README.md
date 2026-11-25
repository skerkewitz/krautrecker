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

The window is laid out like VS Code. The pattern editor sits in the middle. The activity bar on the far
left opens the Devices, Samples, Song (order list) and Hardware views in the left sidebar, and its
☰ menu holds the file commands and the keyboard shortcuts. The bottom panel shows voice usage, the ARAM
estimate and diagnostics, and the right sidebar shows the compiled IR. Ctrl+B, Ctrl+J and Ctrl+Alt+B
show or hide the left sidebar, the panel and the IR view, and every edge can be dragged to resize.

The pattern editor works like FastTracker 2 or Renoise. ☰ → Keyboard shortcuts lists all keys; the
most important ones:

| Key | Action |
|---|---|
| Z…M, Q…P (two piano rows) | enter a note; works by key position, so QWERTZ and AZERTY behave like QWERTY |
| 1 / ^ (key left of 1) | note off / note cut |
| Esc | toggle edit mode (off: keys only play the device) |
| Space, Shift+Space, Enter | play song / play pattern / play from cursor |
| Shift+arrows, Ctrl+C/X/V | select, copy, cut, paste |
| Ctrl+Z, Ctrl+Y | undo, redo |

Each note column has six fields: note, volume (`00`–`7F`), pan (`00`–`7F`, `40` is centre), note delay
in ticks, and two effect columns. An effect is a letter plus one hex byte and acts on the line it is
on; for slides and other continuous effects, `00` repeats the last value, so you continue a slide by
writing its letter with `00` on the next lines. With the cursor on an effect field, the pattern bar
explains that effect.

| Group | Letters |
|---|---|
| Note | `U`/`D` pitch slide, `P` portamento, `V` vibrato, `T` tremolo, `A` volume slide, `L` pan slide, `C` cut, `R` retrigger, `G` switch to a GAIN envelope, `N` noise on/off |
| Track | `M` track volume, `K` track volume slide, `X` track pan |
| Song | `F` tempo, `W` main volume, `H` main volume slide, `E` echo volume, `Y` echo volume slide, `B` echo feedback, `Z` echo freeze |

Devices also offer long releases, a raw GAIN envelope, tremolo, vibrato fade-in, fine tune, surround
and pitch modulation, and each zone can play the chip's noise generator instead of its sample. The Song
view sets the loop point where playback continues after the end.

The project autosaves to the browser (IndexedDB). ☰ → **Save** downloads it as a single `.json` file with
the samples inside; ☰ → **Open** loads one back.

## Where to read next

- [docs/KICKOFF.md](docs/KICKOFF.md): the product brief and the source of truth for scope.
- [docs/design.md](docs/design.md): how the compiler, voice allocator and DSP model work, and why.
- [CLAUDE.md](CLAUDE.md): the rules every change must follow.

## License

Krautrecker is released under the [MIT License](LICENSE).
