/** Int16 PCM <-> base64 (little-endian), the storage format for samples in the project file. */

const CHUNK = 0x8000;

export function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    bytes[i * 2] = pcm[i] & 0xff;
    bytes[i * 2 + 1] = (pcm[i] >> 8) & 0xff;
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToInt16(b64: string): Int16Array {
  const binary = atob(b64);
  const out = new Int16Array(binary.length >> 1);
  for (let i = 0; i < out.length; i++) {
    const v = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
    out[i] = (v << 16) >> 16;
  }
  return out;
}

let idCounter = 0;
/** Stable-enough unique IDs for new objects (not used by the compiler, so no determinism issue). */
export function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 1679616;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36).padStart(4, '0')}`;
}
