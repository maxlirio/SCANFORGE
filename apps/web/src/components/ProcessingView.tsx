import { useEffect, useMemo, useRef, useState } from 'react';
import type { JobRecord } from '@scanforge/shared';
import { groupStages } from '@scanforge/shared';

interface Props {
  job: JobRecord;
  uploadProgress: { sent: number; total: number } | null;
  onCancel(): void;
  onRetry(): void;
  onView(): void;
}

function elapsed(job: JobRecord, now: number): string {
  const start = job.startedAt ?? job.createdAt;
  const end = job.finishedAt ?? now;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  const m = Math.floor(seconds / 60);
  return m > 0 ? `${m}m ${seconds % 60}s` : `${seconds}s`;
}

/**
 * Progress display. A stage shows a real bar only when the pipeline gave a real
 * fraction; otherwise it shows a working indicator. Nothing here interpolates or
 * animates toward a made-up number.
 */
export function ProcessingView({ job, uploadProgress, onCancel, onRetry, onView }: Props) {
  const [now, setNow] = useState(Date.now());
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (showLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job.logs.length, showLog]);

  const groups = useMemo(() => groupStages(job.stages), [job.stages]);
  const warnings = job.logs.filter((l) => l.level === 'warn');
  const uploading = uploadProgress && uploadProgress.sent < uploadProgress.total;

  return (
    <div className="processing">
      <header className="processing__header">
        <h2>
          {uploading ? 'Uploading photos' :
            job.status === 'queued' ? 'Waiting to start' :
            job.status === 'running' ? 'Reconstructing' :
            job.status === 'succeeded' ? 'Reconstruction complete' :
            job.status === 'failed' ? 'Reconstruction failed' :
            job.status === 'cancelled' ? 'Cancelled' : 'Preparing'}
        </h2>
        <span className="processing__timer">{elapsed(job, now)}</span>
      </header>

      {uploading && (
        <div className="stage stage--active">
          <div className="stage__row">
            <span className="stage__name">Uploading</span>
            <span className="stage__meta">{uploadProgress.sent} / {uploadProgress.total}</span>
          </div>
          <div className="bar"><div className="bar__fill" style={{ width: `${(uploadProgress.sent / uploadProgress.total) * 100}%` }} /></div>
        </div>
      )}

      {job.status === 'queued' && (
        <p className="processing__note">
          {job.queuePosition && job.queuePosition > 0
            ? `${job.queuePosition} scan${job.queuePosition === 1 ? '' : 's'} ahead of this one.`
            : 'Starting shortly — reconstruction runs one scan at a time.'}
        </p>
      )}

      <ol className="stages">
        <li className="stage stage--done">
          <div className="stage__row">
            <span className="stage__name">Capturing</span>
            <span className="stage__meta">{job.imageCount} photos</span>
          </div>
        </li>

        {groups.map((group) => (
          <li key={group.group} className={`stage stage--${group.status}`}>
            <div className="stage__row">
              <span className="stage__name">{group.label}</span>
              <span className="stage__meta">
                {group.status === 'done' ? 'done' : group.status === 'active' ? 'working' : 'waiting'}
              </span>
            </div>
            {group.stages
              .filter((s) => s.status !== 'pending')
              .map((stage) => (
                <div key={stage.id} className="substage">
                  <div className="substage__row">
                    <span>{stage.message}</span>
                    {stage.seconds !== undefined && <span className="substage__time">{stage.seconds}s</span>}
                  </div>
                  {stage.status === 'active' && (
                    stage.progress === null ? (
                      <div className="bar bar--indeterminate" title="No progress information available">
                        <div className="bar__pulse" />
                      </div>
                    ) : (
                      <div className="bar">
                        <div className="bar__fill" style={{ width: `${stage.progress * 100}%` }} />
                      </div>
                    )
                  )}
                </div>
              ))}
          </li>
        ))}
      </ol>

      {warnings.length > 0 && (
        <div className="callout callout--warn">
          <strong>Notes from the pipeline</strong>
          <ul>{warnings.slice(-5).map((w, i) => <li key={i}>{w.message}</li>)}</ul>
        </div>
      )}

      {job.error && (
        <div className="callout callout--error">
          <strong>What went wrong</strong>
          <p>{job.error.message}</p>
        </div>
      )}

      <div className="processing__actions">
        {(job.status === 'running' || job.status === 'queued') && (
          <button className="btn btn--ghost" onClick={onCancel}>Cancel</button>
        )}
        {(job.status === 'failed' || job.status === 'cancelled') && (
          <button className="btn btn--primary" onClick={onRetry}>Start a new scan</button>
        )}
        {job.status === 'succeeded' && (
          <button className="btn btn--primary" onClick={onView}>View the model</button>
        )}
        <button className="btn btn--ghost" onClick={() => setShowLog((v) => !v)}>
          {showLog ? 'Hide' : 'Show'} technical log
        </button>
      </div>

      {showLog && (
        <pre className="log" ref={logRef}>
          {job.logs.map((line) => `[${line.level}] ${line.message}`).join('\n') || 'No output yet.'}
        </pre>
      )}

      <p className="processing__hint">
        Reconstruction runs on the server, so you can lock your phone —
        <button className="linkbtn" onClick={() => navigator.clipboard?.writeText(location.href)}>
          copy this page’s link
        </button>
        to come back to it. Scan id <code>{job.id}</code>.
      </p>
    </div>
  );
}
