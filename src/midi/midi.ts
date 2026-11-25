/**
 * Web MIDI input: note on/off from every connected input. Browsers without Web MIDI (Safari)
 * or users who deny access get a status message and the app keeps working without it.
 */

export interface MidiHandlers {
  noteOn: (note: number, velocity: number) => void;
  noteOff: (note: number) => void;
  status: (text: string) => void;
}

export async function startMidi(h: MidiHandlers): Promise<void> {
  if (!('requestMIDIAccess' in navigator)) {
    h.status('MIDI: not supported in this browser');
    return;
  }
  let access: MIDIAccess;
  try {
    access = await navigator.requestMIDIAccess();
  } catch {
    h.status('MIDI: access denied');
    return;
  }
  const attach = () => {
    const names: string[] = [];
    access.inputs.forEach((input) => {
      names.push(input.name ?? 'input');
      input.onmidimessage = (e: MIDIMessageEvent) => {
        const d = e.data;
        if (!d || d.length < 3) return;
        const cmd = d[0] & 0xf0;
        if (cmd === 0x90 && d[2] > 0) h.noteOn(d[1], d[2]);
        else if (cmd === 0x80 || (cmd === 0x90 && d[2] === 0)) h.noteOff(d[1]);
      };
    });
    h.status(names.length ? `MIDI: ${names.join(', ')}` : 'MIDI: no input connected');
  };
  access.onstatechange = attach;
  attach();
}
