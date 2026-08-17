/**
 * The bridge the Electron shell injects. Absent in a plain browser, which is how
 * the app decides whether to show the desktop home or the phone capture flow.
 */
export interface DesktopBridge {
  desktop: true;
  platform: string;
  pickPhotos(): Promise<string[]>;
  readFile(path: string): Promise<{ name: string; bytes: Uint8Array }>;
  reveal(target: string): Promise<void>;
  onOpenFiles(handler: (paths: string[], options: { generate?: boolean }) => void): () => void;
}

declare global {
  interface Window {
    scanforge?: DesktopBridge;
  }
}

export const bridge = (): DesktopBridge | undefined =>
  typeof window !== 'undefined' ? window.scanforge : undefined;

export const IS_DESKTOP = Boolean(bridge()?.desktop);

/** Turn a path handed over by the shell into something uploadable. */
export async function fileFromPath(path: string): Promise<File> {
  const api = bridge();
  if (!api) throw new Error('not running in the desktop shell');
  const { name, bytes } = await api.readFile(path);
  const ext = name.split('.').pop()?.toLowerCase() ?? 'jpg';
  const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return new File([new Uint8Array(bytes)], name, { type });
}
