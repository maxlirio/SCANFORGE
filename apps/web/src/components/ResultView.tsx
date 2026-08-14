import { useState } from 'react';
import type { JobRecord } from '@scanforge/shared';
import { formatBytes } from '@scanforge/shared';
import { api } from '../lib/api';
import { ModelViewer, type LightingMode } from './ModelViewer';

interface Props {
  job: JobRecord;
  onNewScan(): void;
  /** Overridden by the bundled example model, which is not served by the API. */
  fileUrlFor?: (name: string, download?: boolean) => string;
  banner?: string;
}

export function ResultView({ job, onNewScan, fileUrlFor, banner }: Props) {
  const fileUrl = fileUrlFor ?? ((name: string, download = false) => api.fileUrl(job.id, name, download));
  const [wireframe, setWireframe] = useState(false);
  const [lighting, setLighting] = useState<LightingMode>('studio');
  const [showGrid, setShowGrid] = useState(true);
  const [resetSignal, setResetSignal] = useState(0);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState<{ triangles: number; vertices: number; textured: boolean } | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  const glb = job.files.find((f) => f.name === 'model.glb');
  const result = job.result;

  return (
    <div className="result">
      <div className="result__viewport">
        {glb ? (
          <ModelViewer
            url={fileUrl('model.glb')}
            wireframe={wireframe}
            lighting={lighting}
            showGrid={showGrid}
            resetSignal={resetSignal}
            onLoaded={setLoaded}
            onError={setError}
          />
        ) : (
          <div className="callout callout--error">No model file was produced for this scan.</div>
        )}

        <div className="viewer__toolbar">
          <button className="chip" onClick={() => setResetSignal((v) => v + 1)}>Reset view</button>
          <button className={`chip ${wireframe ? 'chip--on' : ''}`} onClick={() => setWireframe((v) => !v)}>
            Wireframe
          </button>
          <button className={`chip ${showGrid ? 'chip--on' : ''}`} onClick={() => setShowGrid((v) => !v)}>
            Grid
          </button>
          <div className="segmented">
            {(['studio', 'neutral', 'unlit'] as LightingMode[]).map((mode) => (
              <button
                key={mode}
                className={`segmented__btn ${lighting === mode ? 'segmented__btn--on' : ''}`}
                onClick={() => setLighting(mode)}
                title={mode === 'unlit' ? 'Show the photographic texture with no shading' : undefined}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>
        <p className="viewer__hint">Drag to rotate · two fingers or right-drag to pan · pinch or scroll to zoom</p>
      </div>

      <aside className="result__panel">
        <h2>Your model</h2>
        {banner && <div className="callout callout--warn">{banner}</div>}
        {error && <div className="callout callout--error">{error}</div>}

        {result?.generative && (
          <div className="callout callout--warn">
            This model was <strong>generated</strong> by an AI model on a hosted GPU. It is a
            plausible object based on your photos, not a measurement of the real one.
          </div>
        )}

        <dl className="facts">
          {loaded && (
            <>
              <div><dt>Triangles</dt><dd>{loaded.triangles.toLocaleString()}</dd></div>
              <div><dt>Vertices</dt><dd>{loaded.vertices.toLocaleString()}</dd></div>
            </>
          )}
          {result && (
            <>
              <div><dt>Photos used</dt><dd>{result.photosRegistered || result.photosUsed} of {result.photosSubmitted}</dd></div>
              {result.points > 0 && <div><dt>Points solved</dt><dd>{result.points.toLocaleString()}</dd></div>}
              <div><dt>Texture</dt><dd>{result.textured ? 'photo atlas' : 'none'}</dd></div>
              <div><dt>Method</dt><dd>{result.tier}</dd></div>
              <div><dt>Took</dt><dd>{result.durationSeconds}s</dd></div>
            </>
          )}
        </dl>

        <h3>Download</h3>
        <ul className="downloads">
          {job.files
            .filter((f) => f.name !== 'thumbnail.jpg')
            .map((file) => (
              <li key={file.name}>
                <a className={`download ${file.primary ? 'download--primary' : ''}`}
                   href={fileUrl(file.name, true)} download>
                  <span className="download__name">{file.name}</span>
                  <span className="download__meta">{file.label ?? ''} · {formatBytes(file.bytes)}</span>
                </a>
              </li>
            ))}
        </ul>
        <p className="fineprint">
          OBJ downloads need <code>model.obj</code>, <code>model.mtl</code> and <code>texture.jpg</code>
          kept in the same folder. GLB carries everything in one file.
        </p>

        {result?.scaleNote && <p className="fineprint">Scale: {result.scaleNote}.</p>}

        <div className="result__actions">
          <button className="btn btn--primary" onClick={onNewScan}>Scan something else</button>
          <button className="btn btn--ghost" onClick={() => setShowDetails((v) => !v)}>
            {showDetails ? 'Hide' : 'Show'} scan details
          </button>
        </div>

        {showDetails && (
          <pre className="log log--compact">{JSON.stringify(result ?? {}, null, 2)}</pre>
        )}
      </aside>
    </div>
  );
}
