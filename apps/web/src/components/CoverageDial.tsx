import { ELEVATION_BANDS, cellKey, type ElevationBand } from '../lib/coverage';

interface Props {
  cells: Map<string, number>;
  currentSector: number | null;
  available: boolean;
  sectors: number;
}

const RADII: Record<ElevationBand, [number, number]> = {
  high: [30, 38],
  middle: [40, 48],
  low: [50, 58],
};

/**
 * Which angles have been photographed. Three rings = three elevation bands,
 * twelve wedges = twelve compass sectors. When the device reports no orientation
 * the dial is drawn dimmed and labelled, rather than being filled in with
 * guesses about where the camera was pointing.
 */
export function CoverageDial({ cells, currentSector, available, sectors }: Props) {
  const step = 360 / sectors;

  const wedge = (sector: number, inner: number, outer: number) => {
    const start = (sector * step - 90) * (Math.PI / 180);
    const end = ((sector + 1) * step - 90 - 2) * (Math.PI / 180);
    const p = (r: number, a: number) => `${64 + r * Math.cos(a)} ${64 + r * Math.sin(a)}`;
    return [
      `M ${p(inner, start)}`,
      `A ${inner} ${inner} 0 0 1 ${p(inner, end)}`,
      `L ${p(outer, end)}`,
      `A ${outer} ${outer} 0 0 0 ${p(outer, start)}`,
      'Z',
    ].join(' ');
  };

  return (
    <div className={`dial ${available ? '' : 'dial--inactive'}`}>
      <svg viewBox="0 0 128 128" role="img" aria-label="Captured viewing angles">
        {ELEVATION_BANDS.map((band) =>
          Array.from({ length: sectors }, (_, sector) => {
            const count = cells.get(cellKey(sector, band)) ?? 0;
            const [inner, outer] = RADII[band];
            return (
              <path
                key={`${band}-${sector}`}
                d={wedge(sector, inner, outer)}
                className={`dial__cell ${count > 0 ? 'dial__cell--filled' : ''} ${
                  currentSector === sector ? 'dial__cell--current' : ''
                }`}
              />
            );
          }),
        )}
        <circle cx="64" cy="64" r="20" className="dial__hub" />
        <text x="64" y="68" textAnchor="middle" className="dial__label">
          {available ? 'angles' : 'n/a'}
        </text>
      </svg>
    </div>
  );
}
