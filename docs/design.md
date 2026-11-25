# Design notes

[KICKOFF.md](KICKOFF.md) says what Krautrecker must do. This document explains how the Milestone 1
prototype does it, and records the decisions the kickoff left open. Read it before changing the
compiler, the voice allocator or the DSP model, because most of their behaviour follows from the
reasons below.

## Data flows one way, from project to sound

Everything starts from the `Project` in `src/model/types.ts`, the only thing that is ever saved. Two
pure functions derive what the hardware needs from it. `buildSample` turns each sample into BRR data,
and `compileSong` turns the whole song into the IR: eight voice lanes of tick-stamped events plus a
global lane, with diagnostics and an ARAM estimate. The UI sends the BRR bank and the IR to an
AudioWorklet, where `Sequencer` fires each tick's events into `SDsp`, the S-DSP model.

Because nothing flows back, the editor can recompile on every keystroke and the player never needs to
know what a device or a pattern is. It only knows key-on, key-off, pitch, volume and envelope, which is
also all a real sound driver will receive in Milestone 2.

## The compiler runs in three stages

**Stage 1** parses a pattern into time-ordered column entries: notes, volume and pan changes at their
delayed tick, effects at the start of their line. It depends only on the pattern and ticks-per-line, so
its result is cached per pattern object. Editing one pattern re-parses that pattern alone, which is the
"incremental recompilation per pattern" the kickoff asks for.

**Stage 2** runs each track through its device's rules, tick by tick, and produces *logical notes*: one
for everything that wants a hardware voice, with the events it will send. Mono, legato, arpeggio and
drum behaviour, effects and vibrato all live here. **Stage 3** assigns the logical notes to the eight
hardware voices.

Stages 2 and 3 run over the whole song rather than per pattern, because a note can ring across a
pattern boundary and voice ownership carries over from one pattern to the next. Caching their output
per pattern would give wrong results at every boundary. Both stages are linear in the number of ticks,
and the demo song compiles in a few milliseconds, so this costs nothing noticeable today.

## Groups express which notes share a voice

The kickoff's first allocation rule says device-internal rules come first: mono and legato reuse their
voice, choke groups cut each other, and a poly device at its limit steals its own oldest voice. Stage 2
expresses this through a `group` on every logical note. A new note whose group already owns a voice
takes that voice over, without a key-off and without counting as a steal.

| Device mode | Group | Effect |
|---|---|---|
| mono, arp | one per track | every note or arp step re-keys the same voice |
| legato | one per track | later notes become pitch changes on the first note |
| poly | one per note column | a new note in a column replaces the old one, like a tracker channel |
| drum | one per hit | hits ring out until their sample ends, a choke, or the voice limit |

Drum hits get their own group because a drum kit should let a kick decay while the hi-hat plays in the
same column. Choke groups are resolved by the allocator: a drum note with a choke key takes the voice of
a running note with the same key, across tracks, since the key is device-wide.

## When a voice is free again

The allocator needs to know when a voice stops sounding, and the IR alone does not say. Two hardware
facts answer it. A key-off releases the envelope by 8 steps per sample from at most 0x7FF, so a voice is
silent 256 samples (8 ms) later; the compiler rounds that up to whole ticks, which is one tick at normal
tempos. And a sample without a loop ends on its own; the compiler computes when from the sample's
length and the pitch at key-on. A drum voice is therefore free as soon as its hit has finished.

"Oldest note" in the stealing order means the note assigned first, not the note with the earliest
tick. Several notes often start on the same tick; with tick order, the second steal of that tick would
take the voice the first steal had just handed out.

The allocator reports a `voiceStolen` diagnostic only when it cuts a note that was still held. Taking a
voice from a note in release, or from a finished one-shot, is normal and stays silent.

## BRR encoding chooses filters against the real decoder

The decoder in `src/brr/brr.ts` follows the S-DSP's integer arithmetic exactly, including the
16-bit wrap-around after doubling and the invalid shifts 13–15. The encoder tries every filter and
shift for each block and picks the nibble for each sample by running that same decoder, so it optimises
for what the hardware will actually output, including the drift of the prediction filters.

The first block and the loop-start block always use filter 0. Their prediction history differs
between the first pass and later loop passes, and filter 0 is the only one that ignores it.

## Loops are aligned by resampling, and the pitch is compensated

The hardware can only loop to the start of a 9-byte block, and the loop always ends at the end of the
sample, so both the loop start and the loop length must be multiples of 16 samples. The sample build
handles the length by resampling the whole sample by a tiny factor until the loop is a multiple of 16
long, and the start by padding silence in front. Resampling avoids the click that cutting or stretching
only the loop would cause.

The resampling changes the sample's real playback rate, so `BuiltSample.effectiveRate` carries the
exact rate and the compiler uses it in the pitch calculation. The note plays in tune, and the sample
panel and diagnostics report what was changed.

## What the DSP model covers, and what it leaves out

`SDsp` models what defines the SNES sound: live BRR decoding (so the filter history really carries over
at the loop point), 4-point Gaussian interpolation with the hardware table, the 14-bit pitch register,
ADSR and GAIN envelopes driven by the hardware rate tables and the shared rate counter, signed per-voice
and main volume, the noise generator, pitch modulation, and the echo unit with its 8-tap FIR filter,
feedback and write enable.

It is not cycle-exact. Register writes take effect at once, the key-on delay of a few samples is
skipped, and samples are held as separate arrays rather than inside a 64 KB ARAM image with a sample
directory. The noise generator and pitch modulation follow blargg's snes_spc and Anomie's S-DSP notes
as recalled from memory; the tests confirm the noise register's maximal period and rates, but the exact
cycle order of noise and pitch-modulation updates is unverified. A real emulator core (kickoff §8, out
of scope) would replace this model as the "hardware-exact" player.

One envelope detail can look like a bug: a note with attack 10 often peaks at about 0x7E0, not 0x7FF.
The S-DSP switches from attack to decay when the computed level overflows, even on a sample where the
rate counter does not let it write that level. The model copies this deliberately.

The AudioContext is created at 32 kHz, the S-DSP's own rate, so samples reach the browser unchanged and
the browser resamples to the output device. If a browser refuses that rate, the worklet resamples
linearly instead.

## Live play runs the compiler's device rules in real time

Notes played live (MIDI, the computer keyboard, zone audition) must sound the way the same notes sound
in the song, so a mono device must stay mono and an arp device must arpeggiate. Writing a second set of
device rules for live play would let the two drift apart. Instead `LivePlayer` (`src/dsp/live.ts`)
runs the compiler's own stage 2 (`TrackProcessor`) and stage 3 (`VoiceAllocator`) inside the
worklet, one tick at a time at the song's tempo, and writes the resulting events to its own `SDsp`.
That DSP is mixed on top of the song, so live notes never take one of the song's eight voices. The song
itself is still only played from compiled IR, as principle 3 requires.

Each device being played gets one track processor, and keys become the same column entries a pattern
would contain: in poly, arp and drum mode each held key occupies a note column, and releasing it writes
a note-off. Two keyboard conventions are added on top, because a held key is not a tracker cell. In
mono and legato mode, releasing the sounding key falls back to the most recent key still held, as on a
monophonic synthesizer. And one-shot drum hits ignore key release and ring out, as on a drum machine.

A key pressed between two audio blocks plays at the start of the next block rather than at the next
tick boundary, which keeps latency at one block (4 ms) instead of up to one tick (20 ms). Editing a
device while holding notes applies to the held notes; changing its mode ends them.

Raw sample audition in the sample panel bypasses devices on purpose, so it uses a third, small `SDsp`
that renders only while a sample is sounding.

## Effects are one byte, act on their line, and remember their last value

Every effect stores a type and one byte, as in classic trackers, so it fits in one cell and is typed as
a letter plus two hex digits. Each note column has two effect columns, so a slide and a volume fade can
share a line. The byte's meaning for each of the 21 effects is documented on `Effect` in
`src/model/types.ts`, and the pattern editor shows it while the cursor is on an effect field.

Effects act on the line they are written on. To keep a slide going, you write it again on the next
line with the value `00`, which repeats the last non-zero value of that effect in the same column (the
FastTracker 2 convention). This effect memory is resolved in one place, `FxMemory`, as a line's effects
are read, so every effect implementation sees the value that actually plays. It carries across lines
and patterns in song order. Vibrato and tremolo remember each nibble separately, so `V05` after `V23`
plays as `V25`. Two consequences follow from resolving memory at compile time: playing one pattern on
its own starts with empty memory, and after the song loops back, memory continues from the song's end,
not from the loop point.

Effects fall into three groups. Note effects (slides, porta, vibrato, tremolo, volume and pan slides,
cut, retrigger, GAIN switch, noise) act on the note of their column. Track effects (`M` volume, `K`
volume slide, `X` pan) act on the whole track, and global effects (`F` tempo, main and echo volume,
echo feedback, echo freeze) act on the whole song. Track and global effects work on lines where no note
sounds, so they run through their own hooks in `TrackProcessor.tick` rather than through the per-note
effect code.

## Track mix: header values reset at every pattern

Each track in a pattern has a volume, pan and transpose in its header. `M`, `K` and `X` change the
track's current volume and pan, and that change lasts until the next pattern starts, where the values
return to that pattern's header. We chose the reset so that a pattern sounds the same wherever it sits
in the order list and when it is played on its own, and so that the header shows what the track really
starts with. The cost is that a fade across two patterns needs the second pattern's header value, or an
`M` on its first line.

Transpose shifts notes before zone selection, so on a drum track it changes which drum plays. A
device's fine tune adds cents to every note's pitch.

## Global effects and the song loop point

Tempo, main volume and echo settings can change during the song. Global effects are collected from all
tracks during stage 2 and resolved in a second pass in tick order, because a slide on one track must
continue from a value that another track set earlier, and stage 2 runs one track over the whole song
before the next. When two tracks set the same value on the same tick, the later track wins. The IR
keeps its tick grid; the sequencer changes its samples-per-tick at each tempo event.

`Project.loopOrderIndex` marks where the song continues after its last order entry, as almost every
SNES track plays an intro once. When playback starts mid-song or jumps back to the loop point, the
sequencer replays the last global event of each kind before that tick, so tempo, volumes and echo are
what the song has there. Replaying the events already in the IR keeps a single source for that state,
where per-line snapshots would duplicate it.

`W`, `E`, `H` and `Y` change the magnitude of the main and echo volume but keep each side's sign, so a
phase inversion set in the Hardware view survives a fade. Freezing the echo (`Z00`) stops writes to the
echo buffer, which then repeats what it holds.

## Long releases switch the voice to GAIN

The S-DSP's own key-off silences a voice in about 8 ms, which is too short for pads and strings. SNES
drivers get longer releases by switching the voice to a GAIN decrease mode at note-off and keying it off
only once it is silent, and a device's `release` setting does the same. The compiler computes when the
envelope reaches zero by simulating the hardware's step arithmetic from the worst-case level 0x7FF, and
emits the key-off then. From note-off the voice counts as releasing, so it is the first choice for
stealing and is not reported when stolen; voice demand ends at note-off, while voice use lasts until
the key-off. A cut (`^^^` or the `C` effect) is always a hard key-off.

The worst-case timing is safe but generous: an exponential fade becomes inaudible well before it
reaches zero, so a slow exponential release holds its voice longer than it is heard. A new note in the
same column, or any new note on a mono or arp device, takes over the releasing voice and ends the tail,
as on tracker channels and SNES drivers.

Tremolo only ever lowers the volume. Its dip follows a raised cosine scaled to the note's volume, so a
note at full volume dips by exactly the set depth and nothing clips. Device tremolo and the `T` effect
add up. An advanced device setting replaces ADSR by a raw GAIN byte for the whole note, and the `G`
effect switches a sounding note to a GAIN byte.

## Noise, pitch modulation and surround

A zone with `noise`, or the `N` effect, makes a note play the chip's noise generator instead of its
sample. The noise clock is a single global register, so overlapping noise notes that ask for different
clocks overwrite each other; the last write wins and the compiler warns. A noise voice still decodes
its sample underneath, so a one-shot sample ending silences the noise too. That is a legitimate way to
shape a noise burst, so the compiler only notes it rather than warning. Every noise key-on re-sends the
noise flag and its clock, which keeps mid-song starts and loops correct.

Pitch modulation lets a voice's pitch follow the output of the voice just below it. A device with a
`pitchModSource` therefore needs a voice whose lower neighbour plays a note of the source device, and
the allocator places such notes last within a tick and looks for that position. When a modulator and
its partner start on the same tick, the modulator takes the lowest free voice whose upper neighbour is
free as well, rather than simply the lowest free voice, so that the pair can sit together. When no
position exists, the
note plays unmodulated with a warning rather than being dropped, because an unmodulated note at the
right time and pitch does less damage than a missing one. The modulator may be silent: modulation uses
the voice's output before its volume.

Surround inverts a device's right channel, the classic SNES widening trick. It is applied last in the
volume calculation, so every volume write, including tremolo and track mix changes, keeps the
inversion.

## Volume, pan and the ARAM estimate

Device, zone, note and track volume multiply, tremolo then dips the result, and surround inverts the
right side last. Pan adds device, zone, note and track pan, and the pan law keeps the centre at full
volume on both sides, attenuating only the far side. That way a centred note is exactly as loud as
before, and panning never makes a sound quieter than leaving it centred.

The ARAM estimate adds the assumed driver size (8 KB by default), 4 bytes per sample directory entry,
the real BRR sizes, the echo buffer (2 KB per 16 ms of delay) and the song data. Song data is a rough
guess until Milestone 2 picks a driver: 3 bytes per IR event the composer caused. Per-tick events from
slides and vibrato are excluded, because a driver computes those itself.

## Loudness belongs in main volume, because the voice mix clips first

The S-DSP adds the eight voices with a 16-bit clamp and applies main volume only afterwards. A song can
therefore clip inside the chip while its output peak looks harmless: with main volume at 90/128 the
output never reaches full scale, but the clamped sum underneath already distorts. The fix is headroom in
the voices (device, zone, note and track volume) and loudness in main volume, which is what the demo
song does. The DSP model counts clamped frames in the voice mix, the echo input and the output, so the
analysis command can report all three.

## Harmony is stated, not inferred

A song can declare its key, a pattern can declare a different key (a modulation), and chord markers
name the chord at a line until the next marker, also across pattern boundaries in song order. None of
this changes the sound. It records what the composer intends, so the editor can show a note's scale
degree and its relation to the chord, and the musical checks can compare the notes with that intent.
We chose stated harmony over chord detection because detection guesses, and a check built on a guess
produces hints nobody trusts. Line comments sit in the same layer: notes for the composer or feedback
anchored to a cell, never part of the compiled song.

## Musical and hardware checks

The compiler adds checks that catch problems a composer usually finds only by ear. They come in two
categories. Hardware problems are warnings; musical hints are always `info` and can be hidden, because
a clash can be intended and the tool must not nag.

- **Aliasing (hardware).** At sample build, a spectrum analysis finds the sample's highest significant
  partial: within 40 dB of the strongest one, after weighting by the Gaussian interpolation's own
  roll-off, because 40 dB is roughly BRR's quantisation noise. A note that lifts that partial above the
  16 kHz Nyquist frequency of the 32 kHz output folds it back as an off-pitch tone, so the compiler
  warns once per zone at the worst note and names the highest clean note.
- **Detune.** Instruments sounding together whose deviation from equal temperament differs by more
  than 5 cents, near the threshold of hearing for simultaneous tones. The deviation counts device fine
  tune and the 14-bit pitch register's rounding, but not a sample's fine tune, which calibrates the
  sample rather than detuning it.
- **Chord clashes and notes outside the key.** A note starting on a beat that sits a semitone or a
  tritone from a tone of the chord in force, or outside the key when no chord explains it. The bass of
  a slash chord counts as a chord tone, because "D/E" states an E pedal.
- **Register crowding.** Two instruments holding notes within two semitones of each other for at least
  a beat, which is long enough to hear as masking.

## The analysis command: the composer's measuring ears

`npm run analyze` renders a song through the real playback path and reports per section and per track:
loudness, peaks, clamping, spectral balance, masking hints, tuning, voice use, diagnostics and comments.
It exists so that a composer who cannot listen at the moment, or an AI composer that cannot listen at
all, can check a song before anyone hears it.

Stems are rendered by muting, not by removing events: each stem plays the full IR with the other
tracks' volumes at zero. Removing events would change voice allocation (a stolen note would ring on in
its own stem) and would break pitch modulation, which reads the neighbouring voice before its volume.
Without clipping, the stems add up to the mix within one sample step.

The pattern text format serves the same reader. It writes cells as the editor shows them, one pattern
line per text line, so patterns can be read and written outside the app and exchanged through the
system clipboard.

## Known gaps in this prototype

These are open on purpose, so that the prototype stays small:

- The compiler runs on the main thread. It takes milliseconds for the demo; move it to a Web Worker when
  songs get long enough to make typing lag.
- Zones can override the envelope in the model, but the device editor does not offer it yet.
- The sample editor sets the loop point but cannot trim.
- Autosave to IndexedDB has no automated test, because Node has no IndexedDB. The file round trip that
  autosave uses is tested.
- The BRR encoder runs on the main thread too. A 10-second sample takes a noticeable moment to import.
- Note lengths are converted to ticks at the base tempo. After a tempo increase the allocator can free a
  one-shot voice before its sample has finished, and after a decrease it holds voices too long. The fix
  is a tempo map in the compiler.
- Pitch slides, vibrato and tremolo freeze when a note is released, because the note leaves stage 2's
  active list at note-off.
- Live play runs at the base tempo with the Hardware view's echo settings; it does not follow tempo or
  echo changes made by effects in the song. A pitch-modulated device played live sounds unmodulated
  unless its source device is also sounding.
- Global events carry no source reference, so the IR view cannot jump from them to their cell.
