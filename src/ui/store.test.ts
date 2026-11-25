import { beforeEach, describe, expect, it } from 'vitest';
import { demoProject } from '../model/demo';
import { initStore, liveDeviceId, store } from './store';

// Demo song tracks: 0 Drums, 1 Bass, 2 Arp lead, 3 Pad.
describe('device for live notes (MIDI and keyboard)', () => {
  beforeEach(() => initStore(demoProject()));

  it('plays the device selected in the list, not the cursor track', () => {
    store.setUi({ selectedDeviceId: 'dev_pad' });
    expect(store.getState().ui.cursor.track).toBe(0);
    expect(liveDeviceId(store.getState())).toBe('dev_pad');
  });

  it('moving the cursor to another track selects that track device', () => {
    store.setUi({ selectedDeviceId: 'dev_pad' });
    store.setUi({ cursor: { ...store.getState().ui.cursor, track: 1 } });
    expect(liveDeviceId(store.getState())).toBe('dev_bass');
  });

  it('moving within the same track keeps the device the user picked', () => {
    store.setUi({ selectedDeviceId: 'dev_pad' });
    store.setUi({ cursor: { ...store.getState().ui.cursor, line: 12 } });
    expect(liveDeviceId(store.getState())).toBe('dev_pad');
  });

  it('playback following a new pattern does not override the selection', () => {
    store.setUi({ selectedDeviceId: 'dev_arp' });
    store.setUi({ currentPatternId: 'pat_b', orderIndex: 2, playTick: 800 });
    expect(liveDeviceId(store.getState())).toBe('dev_arp');
  });
});
