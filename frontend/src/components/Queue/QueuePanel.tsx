import { useNavigate } from '@solidjs/router';
import { createVirtualizer } from '@tanstack/solid-virtual';
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
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

  // Center the active row on first paint so the user lands at "Now" instead of position 0.
  onMount(() => {
    if (player.queueIndex >= 0) {
      virtualizer.scrollToIndex(player.queueIndex, { align: 'center' });
    }
  });

  const labelFor = (index: number): string => {
    if (index < player.queueIndex) return 'Played';
    if (index === player.queueIndex) return 'Now';
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
              const track = queue()[item.index];
              if (!track) return null;
              return (
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
                  onDblClick={() => player.setTrack(track, queue(), item.index)}
                  title={`${track.title || ''} — ${track.artist || ''}`}
                >
                  <AlbumArt artPath={track.artPath} title={track.album} size="sm" />
                  <div class="queue-meta">
                    <strong class="truncate">{track.title}</strong>
                    <button
                      type="button"
                      class="truncate muted link-text"
                      onClick={(e) => {
                        e.stopPropagation();
                        openArtist(track.artistId, navigate);
                        player.setShowNowPlaying(false);
                      }}
                      disabled={!track.artistId}
                    >
                      {track.artist}
                    </button>
                  </div>
                  <span class="queue-status">
                    <Show when={track.id === player.currentTrack?.id}>
                      <PlayingIndicator active={player.isPlaying} />
                    </Show>
                    {labelFor(item.index)}
                  </span>
                </div>
              );
            }}</For>
          </div>
        </div>
      </Show>
    </div>
  );
}
