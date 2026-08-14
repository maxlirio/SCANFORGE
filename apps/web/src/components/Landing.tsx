import { useState } from 'react';
import type { HealthResponse, JobOptions, JobRecord } from '@scanforge/shared';
import { api } from '../lib/api';
import { DEMO_MODEL_URL, IS_STATIC_BUILD, backendProblem, getApiBase, setApiBase } from '../lib/backend';

interface Props {
  health: HealthResponse | null;
  healthError: string;
  options: JobOptions;
  onOptions(next: JobOptions): void;
  onStart(): void;
  recent: Omit<JobRecord, 'logs'>[];
  onOpen(id: string): void;
  onViewExample?(): void;
}

export function Landing({ health, healthError, options, onOptions, onStart, recent, onOpen, onViewExample }: Props) {
  const provider = health?.providers.find((p) => p.id === options.provider);
  const ready = Boolean(provider?.available);
  const [apiInput, setApiInput] = useState(getApiBase());
  // A single-image model needs one good photo; photogrammetry needs a circuit.
  // Until a server says otherwise, describe the single-photo flow, which is what
  // the default build runs.
  const singleShot = (provider?.minPhotos ?? 1) <= 1;
  const problem = backendProblem(getApiBase());
  const needsBackend = Boolean(healthError) || IS_STATIC_BUILD || Boolean(problem);

  return (
    <div className="landing">
      <header className="landing__hero">
        <h1>SCANFORGE</h1>
        <p className="landing__tagline">
          {singleShot
            ? 'Photograph an object and get back a textured, game-ready 3D model you can spin, inspect and download.'
            : 'Photograph a real object from every side and get back a textured 3D model you can spin, inspect and download.'}
        </p>
        <button className="btn btn--primary btn--large" onClick={onStart} disabled={!ready}>
          Start scan
        </button>
        {!ready && (
          <p className="landing__blocked">
            {problem || healthError || provider?.reason || 'Checking what this server can do…'}
          </p>
        )}
        {!ready && DEMO_MODEL_URL && onViewExample && (
          <p className="landing__blocked">
            <button className="btn" onClick={onViewExample}>See an example result</button>
          </p>
        )}
      </header>

      <section className="landing__how">
        <h2>How it works</h2>
        {singleShot ? (
          <ol>
            <li><strong>Photograph it once.</strong> Fill the frame with the object in even light. One sharp photo is enough.</li>
            <li><strong>Generate.</strong> An AI model builds a clean, textured mesh from that view — including the sides it never saw.</li>
            <li><strong>Download.</strong> A game-ready GLB, plus PLY.</li>
          </ol>
        ) : (
          <ol>
            <li><strong>Capture.</strong> Walk all the way around the object taking 25–60 photos, keeping it in frame.</li>
            <li><strong>Reconstruct.</strong> The server solves where every photo was taken from, builds a surface, and paints your photographs onto it.</li>
            <li><strong>Download.</strong> GLB, OBJ or PLY, with the texture.</li>
          </ol>
        )}
        <p className="field__help">
          {singleShot
            ? 'This generates geometry rather than measuring it: the result is a plausible '
              + 'version of your object, which is usually what you want for a game asset. '
              + 'Connect a photogrammetry server instead if you need real measurements.'
            : 'This measures your actual object from your actual photos. Nothing is invented — '
              + 'but surfaces with no visible texture cannot be tracked.'}
        </p>
      </section>

      <section className="landing__tips">
        <h2>What works</h2>
        <div className="tips">
          <div className="tips__good">
            <h3>Works</h3>
            {singleShot ? (
              <ul>
                <li>A single object filling most of the frame</li>
                <li>Plain, untextured things — a white cube is fine here</li>
                <li>Even light, and a background the object stands out from</li>
              </ul>
            ) : (
              <ul>
                <li>Matte, textured surfaces — fabric, stone, wood, printed packaging</li>
                <li>Even, bright, diffuse light with soft shadows</li>
                <li>An object that stays still while you move around it</li>
              </ul>
            )}
          </div>
          <div className="tips__bad">
            <h3>Fights back</h3>
            {singleShot ? (
              <ul>
                <li>Several objects at once — it models one thing</li>
                <li>Heavy clutter the object blends into</li>
                <li>Anything needing true dimensions: the scale is invented</li>
              </ul>
            ) : (
              <ul>
                <li>Shiny, glassy, transparent or mirror-like surfaces</li>
                <li>Plain untextured colour — a white mug has nothing to track</li>
                <li>Moving the object between shots, or a plain empty background</li>
              </ul>
            )}
          </div>
        </div>
      </section>

      {needsBackend && (
        <section className="landing__settings">
          <h2>Reconstruction server</h2>
          <p className="field__help">
            Scanning needs a SCANFORGE server — it runs COLMAP, which cannot run in a
            browser. Start one with <code>npm start</code>, expose it over HTTPS, and
            paste its address here. Everything else on this page works without it.
          </p>
          <label className="field">
            <span>Server address</span>
            <input
              className="field__input"
              type="url"
              placeholder="https://my-scanforge.example.com"
              value={apiInput}
              onChange={(e) => setApiInput(e.target.value)}
            />
          </label>
          <button
            className="btn"
            onClick={() => { setApiBase(apiInput); location.reload(); }}
          >
            Connect
          </button>
        </section>
      )}

      <section className="landing__settings">
        <h2>Settings</h2>
        <label className="field">
          <span>Reconstruction backend</span>
          <select
            value={options.provider}
            onChange={(e) => onOptions({ ...options, provider: e.target.value })}
          >
            {health?.providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.available}>
                {p.label}{p.available ? '' : ' — unavailable'}
              </option>
            ))}
          </select>
        </label>
        {provider && <p className="field__help">{provider.description}</p>}
        {provider?.details && (
          <p className="field__help mono">
            {Object.entries(provider.details)
              .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
              .join('  ')}
          </p>
        )}

        <label className="field">
          <span>Quality</span>
          <select
            value={options.quality}
            onChange={(e) => onOptions({ ...options, quality: e.target.value as JobOptions['quality'] })}
          >
            <option value="fast">Fast — smaller images, quickest result</option>
            <option value="balanced">Balanced — recommended</option>
            <option value="high">High — full resolution, much slower on CPU</option>
          </select>
        </label>

        <label className="field">
          <span>Subject</span>
          <select
            value={options.mode}
            onChange={(e) => onOptions({ ...options, mode: e.target.value as JobOptions['mode'] })}
          >
            <option value="object">A single object — crop away the surroundings</option>
            <option value="scene">A whole scene — keep everything</option>
          </select>
        </label>
      </section>

      {recent.length > 0 && (
        <section className="landing__recent">
          <h2>Recent scans</h2>
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
                    <span>{job.imageCount} photos</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="landing__footer">
        <p>
          Reconstruction by <a href="https://colmap.github.io/" target="_blank" rel="noreferrer">COLMAP</a> (BSD-3),
          viewer by <a href="https://threejs.org/" target="_blank" rel="noreferrer">three.js</a> (MIT).
          {health && ` Server ${health.version}.`}
        </p>
      </footer>
    </div>
  );
}
