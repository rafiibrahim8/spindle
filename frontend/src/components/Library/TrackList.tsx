import { createVirtualizer } from '@tanstack/solid-virtual';
import { For, Show, createMemo } from 'solid-js';
import type { Track } from '../../types';
import { TrackRow } from './TrackRow';

interface TrackListProps {
  /** What to display (typically the search-filtered subset). */
  tracks: Track[];
  /**
   * What to queue when the user starts a track. Defaults to `tracks`. Pass the
   * full unfiltered list here so a search-narrowed view still lets the user
   * play through every track in the underlying page (artist, album, playlist,
   * library, etc.) instead of just the matches.
   */
  playQueue?: Track[];
  onPlay?: (track: Track, queue: Track[], index: number) => void;
}

const ROW_HEIGHT = 64;

export function TrackList(props: TrackListProps) {
  let parent: HTMLDivElement | undefined;

  const tracks = createMemo(() => props.tracks);
  const queue = createMemo(() => props.playQueue ?? props.tracks);

  // Map track id → its position in the play queue. Built once per queue change
  // so the per-row lookup at click time is O(1) instead of O(n).
  const queueIndexById = createMemo(() => {
    const m = new Map<number, number>();
    queue().forEach((t, i) => m.set(t.id, i));
    return m;
  });

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
                  {(track) => {
                    const queueIdx = () => queueIndexById().get(track().id) ?? 0;
                    return (
                      <TrackRow
                        track={track()}
                        queue={queue()}
                        index={queueIdx()}
                        onPlay={
                          props.onPlay
                            ? (t) => props.onPlay!(t, queue(), queueIdx())
                            : undefined
                        }
                      />
                    );
                  }}
                </Show>
              </div>
            );
          }}</For>
        </div>
      </div>
    </div>
  );
}
