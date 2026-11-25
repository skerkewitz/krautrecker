/**
 * Text access to the system clipboard. Browsers may deny it (permission prompt declined, insecure
 * context, no Clipboard API), so both calls fail quietly: the editor then works with its internal
 * clipboard alone.
 */

export function writeClipboardText(text: string): void {
  try {
    navigator.clipboard?.writeText(text).catch(() => {});
  } catch {
    // No clipboard access: the internal clipboard still holds the copy.
  }
}

/** The clipboard's text, or null when it cannot be read. */
export async function readClipboardText(): Promise<string | null> {
  try {
    return (await navigator.clipboard?.readText()) ?? null;
  } catch {
    return null;
  }
}
