/**
 * Viewing-angle coverage.
 *
 * On a phone we can know where the camera is pointing: DeviceOrientationEvent
 * gives a compass heading (alpha) and a tilt (beta), which is enough to bucket
 * each shot into an azimuth sector and an elevation band around the object.
 *
 * On hardware that reports nothing (most laptops), we do NOT invent angles.
 * `available` goes false and the UI switches to counting photos and telling the
 * user what to do, instead of drawing a coverage dial that means nothing.
 */

export const AZIMUTH_SECTORS = 12;
export const ELEVATION_BANDS = ['low', 'middle', 'high'] as const;
export type ElevationBand = (typeof ELEVATION_BANDS)[number];

export interface CoverageCell {
  sector: number;
  band: ElevationBand;
  count: number;
}

export interface CoverageState {
  available: boolean;
  heading: number | null;
  band: ElevationBand | null;
  cells: Map<string, number>;
}

export const cellKey = (sector: number, band: ElevationBand) => `${sector}:${band}`;

export function sectorFor(headingDeg: number): number {
  const normalised = ((headingDeg % 360) + 360) % 360;
  return Math.floor(normalised / (360 / AZIMUTH_SECTORS)) % AZIMUTH_SECTORS;
}

/** beta is the front-to-back tilt: ~90° is holding the phone upright. */
export function bandFor(betaDeg: number): ElevationBand {
  if (betaDeg > 105) return 'low';      // tilted back: shooting upward from below
  if (betaDeg < 65) return 'high';      // tilted down: shooting from above
  return 'middle';
}

type Listener = (state: { heading: number | null; band: ElevationBand | null }) => void;

export class OrientationTracker {
  private listener: Listener | null = null;
  private handler: ((event: DeviceOrientationEvent) => void) | null = null;
  available = false;

  static needsPermission(): boolean {
    return typeof (DeviceOrientationEvent as unknown as { requestPermission?: unknown })
      ?.requestPermission === 'function';
  }

  /** Must be called from a user gesture on iOS. */
  static async requestPermission(): Promise<boolean> {
    const api = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };
    if (typeof api?.requestPermission !== 'function') return true;
    try {
      return (await api.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }

  start(listener: Listener): void {
    this.listener = listener;
    this.handler = (event: DeviceOrientationEvent) => {
      // webkitCompassHeading is the true heading on iOS; alpha is relative elsewhere.
      const webkit = (event as DeviceOrientationEvent & { webkitCompassHeading?: number })
        .webkitCompassHeading;
      const heading = typeof webkit === 'number' && Number.isFinite(webkit)
        ? webkit
        : typeof event.alpha === 'number'
          ? 360 - event.alpha
          : null;
      if (heading === null) return;
      this.available = true;
      const beta = typeof event.beta === 'number' ? event.beta : 90;
      this.listener?.({ heading, band: bandFor(beta) });
    };
    window.addEventListener('deviceorientation', this.handler, true);
  }

  stop(): void {
    if (this.handler) window.removeEventListener('deviceorientation', this.handler, true);
    this.handler = null;
    this.listener = null;
  }
}

export interface CoverageSummary {
  sectorsCovered: number;
  sectorsTotal: number;
  bandsCovered: number;
  /** Sector indices with no photo yet — used to point the user somewhere useful. */
  missingSectors: number[];
  enough: boolean;
  advice: string;
}

export function summarise(cells: Map<string, number>, photoCount: number,
                          orientationAvailable: boolean): CoverageSummary {
  const sectors = new Set<number>();
  const bands = new Set<string>();
  for (const [key, count] of cells) {
    if (count <= 0) continue;
    const [sector, band] = key.split(':');
    sectors.add(Number(sector));
    bands.add(band);
  }
  const missing: number[] = [];
  for (let i = 0; i < AZIMUTH_SECTORS; i += 1) if (!sectors.has(i)) missing.push(i);

  if (!orientationAvailable) {
    const enough = photoCount >= 24;
    return {
      sectorsCovered: 0,
      sectorsTotal: AZIMUTH_SECTORS,
      bandsCovered: 0,
      missingSectors: [],
      enough,
      advice: photoCount < 8
        ? `Take at least ${8 - photoCount} more photo${8 - photoCount === 1 ? '' : 's'}`
        : enough
          ? 'Enough photos for a good reconstruction — add a higher and a lower pass for the top and underside'
          : `${photoCount} photos — aim for about 30, moving roughly 15° between each`,
    };
  }

  const enough = sectors.size >= 9 && photoCount >= 20;
  let advice: string;
  if (photoCount < 8) advice = 'Keep going — circle the object slowly';
  else if (sectors.size < 9) advice = `Missing ${AZIMUTH_SECTORS - sectors.size} angle${AZIMUTH_SECTORS - sectors.size === 1 ? '' : 's'} — keep walking around the object`;
  else if (bands.size < 2) advice = 'Now take a pass from higher up (and lower down if you can)';
  else if (!enough) advice = `${photoCount} photos — a few more will help`;
  else advice = 'Good coverage — you can finish whenever you like';

  return {
    sectorsCovered: sectors.size,
    sectorsTotal: AZIMUTH_SECTORS,
    bandsCovered: bands.size,
    missingSectors: missing,
    enough,
    advice,
  };
}
