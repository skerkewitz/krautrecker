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
ADSR and GAIN envelopes driven by the hardware rate tables and the shared rate counter, per-voice and
main volume, and the echo unit with its 8-tap FIR filter and feedback.

It is not cycle-exact. Register writes take effect at once, the key-on delay of a few samples is
skipped, and samples are held as separate arrays rather than inside a 64 KB ARAM image with a sample
directory. Noise and pitch modulation are reserved as IR event types but not modelled. A real emulator
core (kickoff §8, out of scope) would replace this model as the "hardware-exact" player.

One envelope detail can look like a bug: a note with attack 10 often peaks at about 0x7E0, not 0x7FF.
The S-DSP switches from attack to decay when the computed level overflows, even on a sample where the
rate counter does not let it write that level. The model copies this deliberately.

The AudioContext is created at 32 kHz, the S-DSP's own rate, so samples reach the browser unchanged and
the browser resamples to the output device. If a browser refuses that rate, the worklet resamples
linearly instead.

## Auditioning uses a second DSP

Live MIDI play, note entry and sample previews must not disturb the eight song voices, and they must
not bypass the compiler's rules either. So the worklet runs a second `SDsp` for auditioning, mixed on
top of the song. Its key-on data comes from `compiler/preview.ts`, which uses the compiler's own zone
selection, pitch and volume functions, so a preview sounds like the same note in playback. The song
itself is still only played from compiled IR, as principle 3 requires.

A preview is a single plain note: arpeggio, legato and voice limits do not apply to it. Making live play
follow the device modes would mean running stage 2 in real time, which is a larger change.

## Effects are one byte and last one line

Every effect stores a type and one byte, as in classic trackers, so it fits in one cell and is typed as
a letter plus two hex digits. Each effect acts only on the line it is written on; to keep a slide going,
write it on every line. The byte's meaning per effect is documented on `Effect` in
`src/model/types.ts`. Slides and portamento move `value / 16` semitones per line, spread evenly over its
ticks, which gives the fractional semitones per line the kickoff asks for.

## Volume, pan and the ARAM estimate

Device, zone and cell volume multiply. Pan adds device, zone and cell pan, and the pan law keeps the
centre at full volume on both sides, attenuating only the far side. That way a centred note is exactly
as loud as before, and panning never makes a sound quieter than leaving it centred.

The ARAM estimate adds the assumed driver size (8 KB by default), 4 bytes per sample directory entry,
the real BRR sizes, the echo buffer (2 KB per 16 ms of delay) and the song data. Song data is a rough
guess until Milestone 2 picks a driver: 3 bytes per IR event the composer caused. Per-tick events from
slides and vibrato are excluded, because a driver computes those itself.

## Known gaps in this prototype

These are open on purpose, so that Milestone 1 stays small:

- The compiler runs on the main thread. It takes milliseconds for the demo; move it to a Web Worker when
  songs get long enough to make typing lag.
- Zones can override the envelope in the model, but the device editor does not offer it yet.
- The sample editor sets the loop point but cannot trim.
- Autosave to IndexedDB has no automated test, because Node has no IndexedDB. The file round trip that
  autosave uses is tested.
- The BRR encoder runs on the main thread too. A 10-second sample takes a noticeable moment to import.
