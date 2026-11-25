import { useEffect, useMemo, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { decodeBrr } from '../brr/brr';
import { buildSample } from '../brr/sampleBuild';
import { previewSampleKeyOn } from '../compiler/preview';
import { importAudioFile } from '../io/importAudio';
import type { Sample } from '../model/types';
import { base64ToInt16 } from '../util/base64';
import { syncEngine } from './actions';
import { store, useStore } from './store';
import { prepareCanvas, theme } from './theme';
import { NoteInput, NumberInput, Row } from './widgets';

const RATES = [32000, 24000, 16000, 12000, 8000];

export function SamplePanel() {
  const samples = useStore((s) => s.project.samples);
  const selected = useStore((s) => s.ui.selectedSampleId);
  const sample = samples.find((s) => s.id === selected);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        try {
          const s = await importAudioFile(f);
          store.update((p) => ({ ...p, samples: [...p.samples, s] }));
          store.setUi({ selectedSampleId: s.id });
        } catch (e) {
          store.setUi({ message: `Could not import ${f.name}: ${(e as Error).message}` });
        }
      }
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="side-panel">
      <div className="list">
        {samples.map((s, i) => (
          <div key={s.id} className={`list-item${s.id === selected ? ' active' : ''}`} onClick={() => store.setUi({ selectedSampleId: s.id })}>
            <span className="idx">{i.toString(16).toUpperCase().padStart(2, '0')}</span> {s.name}
            <span className="dim right">{(buildSample(s).brr.length / 1024).toFixed(1)} KB</span>
          </div>
        ))}
        {samples.length === 0 && <div className="dim pad">No samples yet. Import WAV files to start.</div>}
      </div>
      <div className="button-row">
        <button onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? 'Importing…' : 'Import audio…'}
        </button>
        <input ref={fileRef} type="file" accept="audio/*,.wav" multiple hidden onChange={(e) => void onFiles(e.target.files)} />
      </div>
      {sample && <SampleEditor sample={sample} />}
    </div>
  );
}

function SampleEditor({ sample }: { sample: Sample }) {
  const project = useStore((s) => s.project);
  const built = useMemo(() => buildSample(sample), [sample]);
  const srcLength = useMemo(() => base64ToInt16(sample.pcm).length, [sample.pcm]);
  const users = project.devices.filter((d) => d.zones.some((z) => z.sampleId === sample.id));
  const set = (patch: Partial<Sample>, key: string) =>
    store.update((p) => ({ ...p, samples: p.samples.map((s) => (s.id === sample.id ? { ...s, ...patch } : s)) }), `${key}:${sample.id}`);

  const audition = async () => {
    syncEngine();
    const k = previewSampleKeyOn(store.getState().project, sample.id);
    if (!k) return;
    await engine.sampleOn(k);
    setTimeout(() => engine.sampleOff(), Math.min(4000, (built.length / built.effectiveRate) * 1000 + 300));
  };

  const remove = () => {
    if (users.length && !confirm(`"${sample.name}" is used by ${users.map((d) => d.name).join(', ')}. Delete anyway?`)) return;
    store.update((p) => ({
      ...p,
      samples: p.samples.filter((s) => s.id !== sample.id),
      devices: p.devices.map((d) => ({ ...d, zones: d.zones.filter((z) => z.sampleId !== sample.id) })),
    }));
  };

  return (
    <div className="editor">
      <Row label="Name">
        <input value={sample.name} onChange={(e) => set({ name: e.target.value }, 'name')} />
      </Row>
      <Waveform sample={sample} />
      <div className="dim small">
        Source {srcLength} samples @ {sample.sampleRate} Hz · BRR {built.length} samples, {built.brr.length} bytes
        {built.effectiveRate !== sample.targetRate && ` · plays at ${built.effectiveRate.toFixed(1)} Hz`}
      </div>
      <Row label="Target rate" title="Resampled to this rate before BRR encoding. Lower = smaller and darker.">
        <select value={sample.targetRate} onChange={(e) => set({ targetRate: Number(e.target.value) }, 'rate')}>
          {[...new Set([...RATES, sample.targetRate])].sort((a, b) => b - a).map((r) => (
            <option key={r} value={r}>
              {r} Hz
            </option>
          ))}
        </select>
      </Row>
      <Row label="Root note" title="The note the sample sounds at when played at its native rate.">
        <NoteInput value={sample.rootNote} onChange={(v) => set({ rootNote: v }, 'root')} />
      </Row>
      <Row label="Fine tune" title="Playback correction in cents.">
        <NumberInput value={sample.fineTune} min={-100} max={100} onChange={(v) => set({ fineTune: v }, 'fine')} />
      </Row>
      <Row label="Loop" title="Loop from this start position (in source samples) to the end of the sample.">
        <input type="checkbox" checked={sample.loop.enabled} onChange={(e) => set({ loop: { ...sample.loop, enabled: e.target.checked } }, 'loop')} />
        <NumberInput value={sample.loop.start} min={0} max={Math.max(0, srcLength - 1)} onChange={(v) => set({ loop: { ...sample.loop, start: v } }, 'loopstart')} width={80} />
        <span className="dim">start</span>
      </Row>
      {built.notes.map((n, i) => (
        <div key={i} className="note-info">
          {n}
        </div>
      ))}
      <div className="dim small">Used by: {users.length ? users.map((d) => d.name).join(', ') : 'no device'}</div>
      <div className="button-row">
        <button onClick={() => void audition()}>▶ Audition</button>
        <button className="danger" onClick={remove}>
          Delete sample
        </button>
      </div>
    </div>
  );
}

/** The decoded BRR data (what the hardware plays) with the loop region marked. */
function Waveform({ sample }: { sample: Sample }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const built = buildSample(sample);
  useEffect(() => {
    const w = ref.current!.parentElement!.clientWidth - 2;
    const h = 64;
    const ctx = prepareCanvas(ref.current!, w, h);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, w, h);
    const pcm = decodeBrr(built.brr);
    if (built.loopBlock >= 0) {
      ctx.fillStyle = '#1f2d26';
      const x = ((built.loopBlock * 16) / pcm.length) * w;
      ctx.fillRect(x, 0, w - x, h);
    }
    ctx.strokeStyle = theme.vol;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const a = Math.floor((x / w) * pcm.length);
      const b = Math.max(a + 1, Math.floor(((x + 1) / w) * pcm.length));
      let lo = 0;
      let hi = 0;
      for (let i = a; i < b && i < pcm.length; i++) {
        lo = Math.min(lo, pcm[i]);
        hi = Math.max(hi, pcm[i]);
      }
      ctx.moveTo(x + 0.5, h / 2 - (hi / 32768) * (h / 2));
      ctx.lineTo(x + 0.5, h / 2 - (lo / 32768) * (h / 2) + 1);
    }
    ctx.stroke();
  }, [built]);
  return (
    <div className="waveform" title="Decoded BRR (what the S-DSP plays). Shaded: loop region.">
      <canvas ref={ref} />
    </div>
  );
}
