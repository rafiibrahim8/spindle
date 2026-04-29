import { useQuery } from '@tanstack/solid-query';
import { Heart, Search } from 'lucide-solid';
import { Show, createMemo, createSignal } from 'solid-js';
import { api } from '../api/client';
import { TrackList } from '../components/Library/TrackList';
import { EmptyState } from '../components/common/EmptyState';
import { Spinner } from '../components/common/Spinner';

export function Liked() {
  const [search, setSearch] = createSignal('');

  const tracks = useQuery(() => ({
    queryKey: ['liked-tracks'],
    queryFn: () =>
      api.getTracks({ liked: '1', sort: 'liked_at', order: 'desc', limit: 5000 })
  }));

  const filtered = createMemo(() => {
    const q = search().trim().toLowerCase();
    const list = tracks.data?.tracks || [];
    if (!q) return list;
    return list.filter((t) =>
      [t.title, t.artist, t.album].some((v) => (v || '').toLowerCase().includes(q))
    );
  });

  return (
    <div class="page liked-page">
      <div class="page-header">
        <h1><Heart size={22} /> Liked</h1>
        <Show when={(tracks.data?.tracks.length ?? 0) > 0}>
          <div class="search-input">
            <Search size={16} />
            <input
              data-search-input
              placeholder="Filter your liked songs"
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
            />
          </div>
        </Show>
      </div>
      <Show when={!tracks.isLoading} fallback={<Spinner />}>
        <Show
          when={filtered().length}
          fallback={
            <EmptyState
              title={(tracks.data?.tracks.length ?? 0) === 0 ? 'No liked songs yet' : 'No matches'}
              description={
                (tracks.data?.tracks.length ?? 0) === 0
                  ? 'Tap the heart on any track to add it here.'
                  : 'Try a different search.'
              }
            />
          }
        >
          <TrackList tracks={filtered()} />
        </Show>
      </Show>
    </div>
  );
}
