import { useQuery } from '@tanstack/solid-query';
import { Search } from 'lucide-solid';
import { Show, createEffect, createMemo, createSignal } from 'solid-js';
import { api } from '../api/client';
import { AlbumGrid } from '../components/Library/AlbumGrid';
import { TrackList } from '../components/Library/TrackList';
import { EmptyState } from '../components/common/EmptyState';
import { Spinner } from '../components/common/Spinner';
import { getNavClick } from '../store/navStore';
import type { Album } from '../types';

export function Albums() {
  const [search, setSearch] = createSignal('');
  const [active, setActive] = createSignal<Album | null>(null);

  createEffect(() => {
    const click = getNavClick();
    if (click.nonce && click.path === '/albums') {
      setActive(null);
    }
  });

  const albums = useQuery(() => ({ queryKey: ['albums'], queryFn: () => api.getAlbums() }));
  const tracks = useQuery(() => ({
    queryKey: ['album-tracks', active()?.id],
    queryFn: () => api.getAlbumTracks(active()!.id),
    enabled: Boolean(active())
  }));

  const filtered = createMemo(() => {
    const q = search().trim().toLowerCase();
    const list = albums.data?.albums || [];
    if (!q) return list;
    return list.filter((a) =>
      [a.title, a.artist, a.genre].some((v) => (v || '').toLowerCase().includes(q))
    );
  });

  return (
    <div class="page albums-page">
      <div class="page-header">
        <h1>{active() ? active()!.title : 'Albums'}</h1>
        <Show when={!active()}>
          <div class="search-input">
            <Search size={16} />
            <input
              data-search-input
              placeholder="Filter albums by title, artist, genre"
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
            />
          </div>
        </Show>
        <Show when={active()}>
          <button class="ghost" onClick={() => setActive(null)}>← All albums</button>
        </Show>
      </div>
      <Show when={!albums.isLoading} fallback={<Spinner />}>
        <Show
          when={active()}
          fallback={
            <Show
              when={filtered().length}
              fallback={<EmptyState title="No albums" description="Try a different search or sync your library." />}
            >
              <AlbumGrid albums={filtered()} onSelect={setActive} />
            </Show>
          }
        >
          <Show when={!tracks.isLoading} fallback={<Spinner />}>
            <Show
              when={tracks.data?.tracks.length}
              fallback={<EmptyState title="No tracks in this album" />}
            >
              <TrackList tracks={tracks.data!.tracks} />
            </Show>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
