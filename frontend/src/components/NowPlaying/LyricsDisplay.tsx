import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { activeLyricIndex, useLyrics } from '../../hooks/useLyrics';
import { audioEl, usePlayerStore } from '../../store/playerStore';

export function LyricsDisplay() {
  const player = usePlayerStore();
  const trackId = () => player.currentTrack?.id;
  const lyrics = useLyrics(trackId);
  const [mode, setMode] = createSignal<'synced' | 'plain'>('synced');

  const refs: HTMLButtonElement[] = [];
  let lyricsScrollRef: HTMLDivElement | undefined;
  let manualScrollLock = false;
  let resumeTimer: number | null = null;

  const activeIndex = createMemo(() => activeLyricIndex(lyrics.syncedLines(), player.currentTime));

  const clearResumeTimer = () => {
    if (resumeTimer != null) {
      window.clearTimeout(resumeTimer);
      resumeTimer = null;
    }
  };

  const getActiveLineGeometry = () => {
    const container = lyricsScrollRef;
    const activeLine = refs[activeIndex()];
    if (!container || !activeLine) return null;
    const containerRect = container.getBoundingClientRect();
    const activeRect = activeLine.getBoundingClientRect();
    const topInsideContainer = activeRect.top - containerRect.top + container.scrollTop;
    return { container, containerRect, activeRect, topInsideContainer };
  };

  const centerActiveLine = (behavior: ScrollBehavior = 'smooth') => {
    const g = getActiveLineGeometry();
    if (!g) return;
    const targetTop = g.topInsideContainer - g.container.clientHeight / 2 + g.activeRect.height / 2;
    g.container.scrollTo({ top: Math.max(0, targetTop), behavior });
  };

  const isActiveLineVisible = () => {
    const g = getActiveLineGeometry();
    if (!g) return false;
    return g.activeRect.bottom > g.containerRect.top
        && g.activeRect.top    < g.containerRect.bottom;
  };

  const scheduleResumeIfActiveLineVisible = () => {
    if (resumeTimer || !isActiveLineVisible()) return;
    resumeTimer = window.setTimeout(() => {
      resumeTimer = null;
      if (!isActiveLineVisible()) return;
      manualScrollLock = false;
      centerActiveLine('smooth');
    }, 2000);
  };

  const handleManualScrollIntent = () => {
    manualScrollLock = true;
    clearResumeTimer();
    scheduleResumeIfActiveLineVisible();
  };

  createEffect(() => {
    activeIndex(); // track the signal
    if (manualScrollLock) {
      scheduleResumeIfActiveLineVisible();
      return;
    }
    queueMicrotask(() => centerActiveLine('smooth'));
  });

  onCleanup(() => clearResumeTimer());

  return (
    <Show when={player.currentTrack}>
      <Show
        when={!lyrics.query.isLoading}
        fallback={<div class="lyrics-box">Loading lyrics...</div>}
      >
        <Show
          when={lyrics.syncedLines().length || lyrics.unsyncedText()}
          fallback={<div class="lyrics-box muted">No lyrics available</div>}
        >
          <div class="lyrics-box">
            <div class="lyrics-toolbar">
              <Show when={lyrics.syncedLines().length && lyrics.unsyncedText()}>
                <button onClick={() => setMode((m) => (m === 'synced' ? 'plain' : 'synced'))}>
                  {mode() === 'synced' ? 'Plain' : 'Synced'}
                </button>
              </Show>
            </div>
            <Show
              when={mode() === 'synced' && lyrics.syncedLines().length}
              fallback={<pre class="plain-lyrics">{lyrics.unsyncedText()}</pre>}
            >
              <div
                class="synced-lyrics"
                ref={lyricsScrollRef}
                tabIndex={0}
                onWheel={handleManualScrollIntent}
                onTouchMove={handleManualScrollIntent}
                onPointerDown={handleManualScrollIntent}
                onKeyDown={(e) => {
                  if (
                    e.key === 'PageUp' ||
                    e.key === 'PageDown' ||
                    e.key === 'ArrowUp' ||
                    e.key === 'ArrowDown' ||
                    e.key === 'Home' ||
                    e.key === 'End'
                  ) handleManualScrollIntent();
                }}
              >
                <For each={lyrics.syncedLines()}>{(line, index) => (
                  <button
                    ref={(el) => (refs[index()] = el)}
                    class={index() === activeIndex() ? 'active' : ''}
                    onClick={() => {
                      audioEl.currentTime = line.time;
                    }}
                  >
                    {line.text.trim() || '♪'}
                  </button>
                )}</For>
              </div>
            </Show>
          </div>
        </Show>
      </Show>
    </Show>
  );
}
