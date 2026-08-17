import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HealthResponse, JobOptions, JobRecord } from '@scanforge/shared';
import { QUALITY_MEMORY_GB } from '@scanforge/shared';
import { api } from '../lib/api';
import { bridge, fileFromPath } from '../lib/desktop';
import { analyseImageFile } from '../lib/frameQuality';

export interface ChosenPhoto {
  id: string;
  file: File;
  url: string;
  sharpness: number;
}

interface Props {
  health: HealthResponse | null;
  healthError: string;
  options: JobOptions;
  onOptions(next: JobOptions): void;
  onGenerate(photos: ChosenPhoto[]): void;
  recent: Omit<JobRecord, 'logs'>[];
  onOpen(id: string): void;
}

/** Rough, measured on an M4: enough to set expectations without pretending precision. */
const QUALITY_NOTES: Record<JobOptions['quality'], string> = {
  fast: 'about 10 minutes · ~40k triangles',
  balanced: 'about 15 minutes · ~100k triangles',
  high: 'considerably longer · ~200k triangles',
};

export function DesktopHome({
  health, healthError, options, onOptions, onGenerate, recent, onOpen,
}: Props) {
  const [photos, setPhotos] = useState<ChosenPhoto[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const provider = health?.providers.find((p) => p.id === options.provider);
  const ready = Boolean(provider?.available);
  const singleShot = (provider?.minPhotos ?? 1) <= 1;
  const memoryGb = health?.machine?.memoryGb ?? 0;
  const tooBig = memoryGb > 0 && memoryGb < QUALITY_MEMORY_GB[options.quality];

  const [autoGenerate, setAutoGenerate] = useState(false);

  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setBusy(`Reading ${files.length} photo${files.length === 1 ? '' : 's'}…`);
    const added: ChosenPhoto[] = [];
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      let sharpness = 0;
      try {
        sharpness = (await analyseImageFile(file)).sharpness;
      } catch {
        /* unreadable images are still worth sending; the engine reports on them */
      }
      added.push({
        id: `${file.name}_${file.size}_${Math.random().toString(36).slice(2, 8)}`,
        file,
        url: URL.createObjectURL(file),
        sharpness,
      });
    }
    setPhotos((prev) => [...prev, ...added]);
    setBusy('');
  }, []);

  // Photos dragged onto the dock icon, or opened from the File menu.
  useEffect(() => {
    const api2 = bridge();
    if (!api2) return undefined;
    return api2.onOpenFiles(async (paths, opts) => {
      const files = await Promise.all(paths.map((p) => fileFromPath(p).catch(() => null)));
      await addFiles(files.filter((f): f is File => f !== null));
      if (opts?.generate) setAutoGenerate(true);
    });
  }, [addFiles]);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void addFiles(Array.from(event.dataTransfer.files));
  }, [addFiles]);

  const remove = (id: string) => setPhotos((prev) => {
    const gone = prev.find((p) => p.id === id);
    if (gone) URL.revokeObjectURL(gone.url);
    return prev.filter((p) => p.id !== id);
  });

  // Fires once, only when the shell asked for it and the engine is ready.
  useEffect(() => {
    if (autoGenerate && ready && photos.length >= (provider?.minPhotos ?? 1)) {
      setAutoGenerate(false);
      onGenerate(photos);
    }
  }, [autoGenerate, ready, photos, provider, onGenerate]);

  const best = useMemo(
    () => photos.reduce<ChosenPhoto | null>(
      (acc, p) => (!acc || p.sharpness > acc.sharpness ? p : acc), null),
    [photos],
  );

  return (
    <div className="desktop">
      <header className="desktop__bar">
        <h1>SCANFORGE</h1>
        <span className={`enginePill ${ready ? 'enginePill--ok' : 'enginePill--bad'}`}>
          {ready
            ? provider?.label ?? 'engine ready'
            : healthError || provider?.reason || 'starting the engine…'}
        </span>
      </header>

      <section
        className={`drop ${dragging ? 'drop--over' : ''} ${photos.length ? 'drop--compact' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }}
        />
        <div className="drop__icon" aria-hidden>⬒</div>
        <p className="drop__title">
          {photos.length ? 'Drop more photos, or click to choose' : 'Drop a photo here'}
        </p>
        <p className="drop__hint">
          {singleShot
            ? 'One sharp photo of a single object, filling most of the frame.'
            : `This engine needs at least ${provider?.minPhotos ?? 8} photos taken around the object.`}
        </p>
      </section>

      {busy && <p className="desktop__busy">{busy}</p>}

      {photos.length > 0 && (
        <section className="picked">
          <div className="picked__strip">
            {photos.map((p) => (
              <div key={p.id} className={`picked__item ${best?.id === p.id && photos.length > 1 ? 'picked__item--best' : ''}`}>
                <img src={p.url} alt="" />
                {best?.id === p.id && photos.length > 1 && <span className="picked__flag">sharpest</span>}
                <button className="picked__remove" onClick={(e) => { e.stopPropagation(); remove(p.id); }}>×</button>
              </div>
            ))}
          </div>

          <div className="picked__controls">
            <label className="field field--inline">
              <span>Detail</span>
              <select
                value={options.quality}
                onChange={(e) => onOptions({ ...options, quality: e.target.value as JobOptions['quality'] })}
              >
                {(['fast', 'balanced', 'high'] as const).map((q) => {
                  const needs = QUALITY_MEMORY_GB[q];
                  const short = memoryGb > 0 && memoryGb < needs;
                  return (
                    <option key={q} value={q} disabled={short}>
                      {q === 'fast' ? 'Fast' : q === 'balanced' ? 'Balanced' : 'High'}
                      {short ? ` — needs ${needs} GB` : ''}
                    </option>
                  );
                })}
              </select>
            </label>
            <span className="picked__note">
              {tooBig
                ? `This Mac has ${memoryGb} GB of memory; that setting needs about `
                  + `${QUALITY_MEMORY_GB[options.quality]} GB and would swap for hours.`
                : QUALITY_NOTES[options.quality]}
            </span>
            <button
              className="btn btn--primary"
              disabled={!ready || tooBig || photos.length < (provider?.minPhotos ?? 1)}
              onClick={() => onGenerate(photos)}
            >
              {singleShot && photos.length > 1
                ? 'Generate from the sharpest photo'
                : 'Generate 3D model'}
            </button>
          </div>

          {health && health.providers.filter((p) => p.available).length > 1 && (
            <label className="field field--inline">
              <span>Engine</span>
              <select
                value={options.provider}
                onChange={(e) => onOptions({ ...options, provider: e.target.value })}
              >
                {health.providers.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.available}>
                    {p.label}{p.available ? '' : ' — unavailable'}
                  </option>
                ))}
              </select>
            </label>
          )}
        </section>
      )}

      {recent.length > 0 && (
        <section className="desktop__recent">
          <h2>Your models</h2>
          <ul className="recent">
            {recent.map((job) => (
              <li key={job.id}>
                <button className="recent__item" onClick={() => onOpen(job.id)}>
                  {job.files.some((f) => f.name === 'thumbnail.jpg') ? (
                    <img src={api.fileUrl(job.id, 'thumbnail.jpg')} alt="" />
                  ) : (
                    <span className="recent__placeholder" />
                  )}
                  <span className="recent__meta">
                    <strong>{new Date(job.createdAt).toLocaleString()}</strong>
                    <span className={`badge badge--${job.status}`}>{job.status}</span>
                    {job.result?.triangles
                      ? <span>{job.result.triangles.toLocaleString()} triangles</span>
                      : <span>{job.imageCount} photo{job.imageCount === 1 ? '' : 's'}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="desktop__foot">
        {provider?.details ? (
          <span className="mono">
            {Object.entries(provider.details).map(([k, v]) => `${k}=${String(v)}`).join('  ')}
          </span>
        ) : <span />}
        {provider?.generative && (
          <span>Models are generated from your photo, not measured — the scale is arbitrary.</span>
        )}
      </footer>
    </div>
  );
}
