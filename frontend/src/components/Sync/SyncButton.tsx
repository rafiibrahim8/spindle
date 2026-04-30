import { useQueryClient } from '@tanstack/solid-query';
import { RefreshCw } from 'lucide-solid';
import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { api } from '../../api/client';
import type { SyncSseEvent } from '../../types';

interface SyncSummary {
  added: number;
  updated: number;
  deleted: number;
  skipped: number;
  failed: number;
}

export function SyncButton() {
  const queryClient = useQueryClient();
  const [open, setOpen] = createSignal(false);
  const [phase, setPhase] = createSignal<string>('Idle');
  const [currentFile, setCurrentFile] = createSignal('');
  const [percent, setPercent] = createSignal(0);
  const [summary, setSummary] = createSignal<SyncSummary | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [running, setRunning] = createSignal(false);

  let activeSource: EventSource | null = null;

  const attachSse = (jobId: string) => {
    activeSource?.close();
    setRunning(true);
    setSummary(null);
    setError(null);
    setPhase('Starting');
    setCurrentFile('');
    setPercent(0);

    const source = new EventSource(`/api/sync/progress/${jobId}`);
    activeSource = source;
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as SyncSseEvent;
        if (data.type === 'progress') {
          setPhase(data.phase);
          setCurrentFile(data.currentFile || '');
          setPercent(data.total ? Math.round((data.current / data.total) * 100) : 0);
        } else if (data.type === 'done') {
          setPhase('done');
          setPercent(100);
          setSummary({
            added: data.added,
            updated: data.updated,
            deleted: data.deleted,
            skipped: data.skipped,
            failed: data.failed
          });
          setRunning(false);
          source.close();
          if (activeSource === source) activeSource = null;
          void queryClient.invalidateQueries();
          window.setTimeout(() => setOpen(false), 3_000);
        } else if (data.type === 'error') {
          setError(data.message);
          setRunning(false);
          source.close();
          if (activeSource === source) activeSource = null;
        }
      } catch (err) {
        console.warn('SSE parse error', err);
      }
    };
    source.onerror = () => {
      if (!running()) return;
      setError('Connection lost');
      setRunning(false);
      source.close();
      if (activeSource === source) activeSource = null;
    };
  };

  const handleClick = () => {
    // If a sync is already in flight, just reopen the panel — don't start a new one.
    if (running()) {
      setOpen(true);
      return;
    }
    void startSync();
  };

  const startSync = async () => {
    const status = await api
      .getSyncStatus()
      .catch(() => ({
        musicRoot: null,
        musicRootExists: false,
        trackCount: 0,
        activeJobId: null
      }));
    const dockerDefault = import.meta.env.VITE_DEFAULT_MUSIC_ROOT as string | undefined;
    const insideDocker = Boolean(import.meta.env.VITE_IS_INSIDE_DOCKER);
    const defaultRoot = status.musicRoot || dockerDefault || '';

    // Inside Docker the in-container path (/music) is fixed by the bind mount
    // and never changes between machines — only the host source does. Skip
    // the prompt unconditionally and sync against the build-baked default,
    // even if the DB still remembers a stale path from another machine.
    //
    // Otherwise: skip the prompt only when we already have a path AND the
    // backend confirms it actually exists on disk. If the DB was migrated
    // to a new box (or the music dir was unmounted), prompt with the old
    // value pre-filled so the user can correct it. Otherwise sync would
    // walk an empty tree and mark every track for deletion.
    let root: string;
    if (insideDocker && dockerDefault) {
      root = dockerDefault;
    } else if (defaultRoot && status.musicRootExists) {
      root = defaultRoot;
    } else {
      const entered = window.prompt('Music library root path:', defaultRoot);
      if (!entered) return;
      root = entered;
    }

    setOpen(true);

    let jobId: string;
    try {
      const job = await api.startSync(root);
      jobId = job.jobId;
    } catch (err) {
      setError((err as Error).message);
      setRunning(false);
      return;
    }
    attachSse(jobId);
  };

  // Resume an in-flight sync after a frontend reload.
  onMount(async () => {
    try {
      const status = await api.getSyncStatus();
      if (status.activeJobId) {
        setOpen(true);
        attachSse(status.activeJobId);
      }
    } catch {
      // Backend down or unreachable; nothing to resume.
    }
  });

  onCleanup(() => {
    activeSource?.close();
    activeSource = null;
  });

  return (
    <>
      <button class="sync-button" onClick={handleClick}>
        <RefreshCw size={16} class={running() ? 'spin' : ''} />
        <span>{running() ? 'Syncing…' : 'Sync'}</span>
      </button>

      <Show when={open()}>
        <Portal>
        <div class="sync-overlay" role="dialog" aria-modal="true">
          <div class="sync-card">
            <h3>{summary() ? 'Sync complete' : 'Syncing library'}</h3>
            <p class="sync-phase">{phase()}</p>
            <div class="sync-progress">
              <div class="sync-progress-fill" style={{ width: `${percent()}%` }} />
            </div>
            <p class="sync-meter">{percent()}%</p>
            <Show when={currentFile() && !summary()}>
              <p class="sync-current-file" title={currentFile()}>{currentFile()}</p>
            </Show>
            <Show when={summary()}>
              {(s) => (
                <ul class="sync-summary">
                  <li>Added <strong>{s().added}</strong></li>
                  <li>Updated <strong>{s().updated}</strong></li>
                  <li>Deleted <strong>{s().deleted}</strong></li>
                  <li>Skipped <strong>{s().skipped}</strong></li>
                  <li>Failed <strong>{s().failed}</strong></li>
                </ul>
              )}
            </Show>
            <Show when={error()}>
              <p class="sync-error">{error()}</p>
            </Show>
            <button class="sync-dismiss" onClick={() => setOpen(false)}>Close</button>
          </div>
        </div>
        </Portal>
      </Show>
    </>
  );
}
