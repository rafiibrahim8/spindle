import { createVirtualizer } from '@tanstack/solid-virtual';
import { For, Show, createMemo } from 'solid-js';
import type { Track } from '../../types';
import { TrackRow } from './TrackRow';

interface TrackListProps {
  tracks: Track[];
  onPlay?: (track: Track, queue: Track[], index: number) => void;
}

const ROW_HEIGHT = 64;

export function TrackList(props: TrackListProps) {
  let parent: HTMLDivElement | undefined;

  const tracks = createMemo(() => props.tracks);

  const virtualizer = createVirtualizer({
    get count() { return tracks().length; },
    getScrollElement: () => parent ?? null,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8
  });

  const totalSize = () => virtualizer.getTotalSize();

  return (
    <div class="track-list-wrapper">
      <div class="track-list-header">
        <span class="col-icon" />
        <span class="col-art" />
        <span class="col-title">Title</span>
        <span class="col-album">Album</span>
        <span class="col-duration">Time</span>
      </div>
      <div ref={parent} class="track-list-virtual">
        <div style={{ height: `${totalSize()}px`, position: 'relative', width: '100%' }}>
          <For each={virtualizer.getVirtualItems()}>{(item) => {
            // Reactively track tracks()[item.index] so optimistic cache patches
            // (e.g. like toggle) actually flow into the rendered TrackRow. A
            // captured const would be set once and never update.
            const trackAt = createMemo(() => tracks()[item.index]);
            return (
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${item.start}px)`,
                  height: `${item.size}px`
                }}
              >
                <Show when={trackAt()}>
                  {(track) => (
                    <TrackRow
                      track={track()}
                      queue={tracks()}
                      index={item.index}
                      onPlay={
                        props.onPlay
                          ? (t) => props.onPlay!(t, tracks(), item.index)
                          : undefined
                      }
                    />
                  )}
                </Show>
              </div>
            );
          }}</For>
        </div>
      </div>
    </div>
  );
}
