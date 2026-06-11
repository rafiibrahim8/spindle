import { useNavigate } from '@solidjs/router';
import { createVirtualizer } from '@tanstack/solid-virtual';
import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import { openArtist } from '../../store/navStore';
import { usePlayerStore } from '../../store/playerStore';
import { AlbumArt } from '../NowPlaying/AlbumArt';
import { PlayingIndicator } from '../common/PlayingIndicator';

const ROW_HEIGHT = 56;

export function QueueView() {
  const player = usePlayerStore();
  const navigate = useNavigate();
  const [dragging, setDragging] = createSignal<number | null>(null);
  let scrollEl: HTMLDivElement | undefined;

  const queue = createMemo(() => player.queue);

  const virtualizer = createVirtualizer({
    get count() { return queue().length; },
    getScrollElement: () => scrollEl ?? null,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10
  });

  // Keep the now-playing row in view: center it on first paint, and on every
  // subsequent track change scroll it back into view if the user has scrolled
  // away. `align: 'auto'` tells the virtualizer to no-op when the row is
  // already visible — so manual browsing of the queue isn't yanked back.
  let isFirstScroll = true;
  createEffect(() => {
    const idx = player.queueIndex;
    if (idx < 0 || queue().length === 0) return;
    // Defer to a microtask so the virtualizer has measured the new row state
    // (especially right after the queue first populates) before we scroll.
    queueMicrotask(() => {
      virtualizer.scrollToIndex(idx, {
        align: isFirstScroll ? 'center' : 'auto',
        behavior: isFirstScroll ? 'auto' : 'smooth'
      });
      isFirstScroll = false;
    });
  });

  const labelFor = (index: number): string => {
    if (index === player.queueIndex) return 'Now';
    if (player.played.includes(index)) return 'Played';
    return 'Next';
  };

  const onDrop = (e: DragEvent, target: number) => {
    e.preventDefault();
    const from = dragging();
    if (from == null || from === target) return;
    player.reorderQueue(from, target);
    setDragging(null);
  };

  return (
    <div class="queue-view">
      <Show
        when={queue().length}
        fallback={<p class="muted queue-empty">Queue is empty. Pick a track to play.</p>}
      >
        <div ref={scrollEl} class="queue-scroll">
          <div
            class="queue-virtual-inner"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            <For each={virtualizer.getVirtualItems()}>{(item) => {
              // Reactively track queue()[item.index] so drag-reorders flow into
              // the rendered rows. A captured const would be set once and never
              // update.
              const trackAt = createMemo(() => queue()[item.index]);
              return (
                <Show when={trackAt()}>{(track) => (
                <div
                  class={`queue-row ${item.index === player.queueIndex ? 'is-current' : ''}`}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${item.start}px)`,
                    height: `${item.size}px`
                  }}
                  draggable
                  onDragStart={() => setDragging(item.index)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => onDrop(e, item.index)}
                  onDblClick={() => player.setTrack(track(), queue(), item.index)}
                  title={`${track().title || ''} — ${track().artist || ''}`}
                >
                  <AlbumArt artPath={track().artPath} title={track().album} size="sm" />
                  <div class="queue-meta">
                    <strong class="truncate">{track().title}</strong>
                    <button
                      type="button"
                      class="truncate muted link-text"
                      onClick={(e) => {
                        e.stopPropagation();
                        openArtist(track().artistId, navigate);
                        player.setShowNowPlaying(false);
                      }}
                      disabled={!track().artistId}
                    >
                      {track().artist}
                    </button>
                  </div>
                  <span class="queue-status">
                    <Show when={track().id === player.currentTrack?.id}>
                      <PlayingIndicator active={player.isPlaying} />
                    </Show>
                    {labelFor(item.index)}
                  </span>
                </div>
                )}</Show>
              );
            }}</For>
          </div>
        </div>
      </Show>
    </div>
  );
}
