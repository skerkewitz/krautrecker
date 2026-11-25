import type { EchoSettings, HardwareSettings } from '../model/types';
import { store, useStore } from './store';
import { NumberInput, Row, Slider } from './widgets';

const FIR_PRESETS: Record<string, number[]> = {
  'Flat (no filter)': [127, 0, 0, 0, 0, 0, 0, 0],
  'Soft low-pass': [96, 16, 8, 4, 2, 1, 0, 0],
  'Dark low-pass': [48, 32, 24, 12, 6, 3, 1, 1],
  'Band-pass': [-16, 32, 64, 64, 32, -16, 0, 0],
};

export function HardwarePanel() {
  const hw = useStore((s) => s.project.hardware);
  const set = (patch: Partial<HardwareSettings>, key: string) => store.update((p) => ({ ...p, hardware: { ...p.hardware, ...patch } }), key);
  const setEcho = (patch: Partial<EchoSettings>, key: string) => set({ echo: { ...hw.echo, ...patch } }, key);

  return (
    <div className="side-panel">
      <div className="editor">
        <Row label="SFX voices" title="Voices reserved for sound effects (taken from voice 7 downwards). The music never uses them.">
          <Slider value={hw.reservedSfxVoices} min={0} max={7} onChange={(v) => set({ reservedSfxVoices: v }, 'sfx')} />
        </Row>
        <Row label="Main vol L">
          <Slider value={hw.mainVolumeL} min={-128} max={127} onChange={(v) => set({ mainVolumeL: v }, 'mvoll')} />
        </Row>
        <Row label="Main vol R" title="Negative values invert the phase of that side.">
          <Slider value={hw.mainVolumeR} min={-128} max={127} onChange={(v) => set({ mainVolumeR: v }, 'mvolr')} />
        </Row>
        <Row label="Driver reserve" title="ARAM assumed for the sound driver code until Milestone 2 picks a driver.">
          <NumberInput value={hw.driverReserve} min={0} max={32768} step={256} onChange={(v) => set({ driverReserve: v }, 'drv')} width={80} />
          <span className="dim">bytes</span>
        </Row>
        <fieldset>
          <legend>Echo (one global unit)</legend>
          <Row label="Delay" title="Each 16 ms step costs 2 KB of ARAM.">
            <Slider value={hw.echo.delay} min={0} max={15} onChange={(v) => setEcho({ delay: v }, 'edl')} format={(v) => `${v * 16} ms · ${v * 2} KB`} />
          </Row>
          <Row label="Feedback">
            <Slider value={hw.echo.feedback} min={-128} max={127} onChange={(v) => setEcho({ feedback: v }, 'efb')} />
          </Row>
          <Row label="Volume L">
            <Slider value={hw.echo.volumeL} min={-128} max={127} onChange={(v) => setEcho({ volumeL: v }, 'evl')} />
          </Row>
          <Row label="Volume R">
            <Slider value={hw.echo.volumeR} min={-128} max={127} onChange={(v) => setEcho({ volumeR: v }, 'evr')} />
          </Row>
          <Row label="FIR preset">
            <select
              value={Object.entries(FIR_PRESETS).find(([, v]) => v.join() === hw.echo.fir.join())?.[0] ?? ''}
              onChange={(e) => FIR_PRESETS[e.target.value] && setEcho({ fir: FIR_PRESETS[e.target.value].slice() }, 'firp')}
            >
              <option value="">(custom)</option>
              {Object.keys(FIR_PRESETS).map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </Row>
          <div className="fir">
            {hw.echo.fir.map((c, i) => (
              <NumberInput key={i} value={c} min={-128} max={127} width={46} onChange={(v) => setEcho({ fir: hw.echo.fir.map((x, j) => (j === i ? v : x)) }, `fir${i}`)} />
            ))}
          </div>
          <div className="dim small">FIR taps 0–7 (signed 8-bit). The sum should stay near 127 to avoid runaway feedback.</div>
        </fieldset>
      </div>
    </div>
  );
}
