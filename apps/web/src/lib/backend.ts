/**
 * Where the API lives.
 *
 * Served by the SCANFORGE server itself, the API is same-origin and this is all
 * a no-op. Deployed as a static site (GitHub Pages), there is no API on the
 * origin, so the user points the app at a SCANFORGE server they run:
 *
 *   https://…/#/?api=https://my-tunnel.example.com
 *
 * The value is remembered in localStorage. A static build also carries one real
 * example model so the viewer can be tried without any backend at all.
 */

const STORAGE_KEY = 'scanforge.apiBase';

function normalise(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

let cached: string | null = null;

export function getApiBase(): string {
  if (cached !== null) return cached;
  const fromQuery = new URLSearchParams(location.search).get('api');
  if (fromQuery !== null) {
    const value = normalise(fromQuery);
    localStorage.setItem(STORAGE_KEY, value);
    cached = value;
    return value;
  }
  const stored = localStorage.getItem(STORAGE_KEY);
  cached = stored ?? normalise(import.meta.env.VITE_API_BASE ?? '');
  return cached;
}

export function setApiBase(url: string): void {
  cached = normalise(url);
  if (cached) localStorage.setItem(STORAGE_KEY, cached);
  else localStorage.removeItem(STORAGE_KEY);
}

/** True for builds published as a static site with no API on the origin. */
export const IS_STATIC_BUILD = import.meta.env.VITE_STATIC_BUILD === '1';

/**
 * A static build with no configured backend cannot reconstruct anything, and the
 * browser would block a plain-http backend from an https page anyway.
 */
export function backendProblem(base: string): string {
  if (!base) {
    return IS_STATIC_BUILD
      ? 'No reconstruction server configured. This page is the interface only — ' +
        'reconstruction needs a SCANFORGE server you run.'
      : '';
  }
  if (location.protocol === 'https:' && base.startsWith('http://')) {
    return `This page is served over HTTPS, so the browser will block the plain-HTTP ` +
      `backend at ${base}. Expose your server over HTTPS (for example with a tunnel).`;
  }
  return '';
}
