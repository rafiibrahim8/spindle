import { useQuery } from '@tanstack/solid-query';
import { Search } from 'lucide-solid';
import { Show, createEffect, createMemo, createSignal } from 'solid-js';
import { api } from '../api/client';
import { ArtistList } from '../components/Library/ArtistList';
import { TrackList } from '../components/Library/TrackList';
import { EmptyState } from '../components/common/EmptyState';
import { Spinner } from '../components/common/Spinner';
import { clearPendingArtistId, getNavClick, getPendingArtistId } from '../store/navStore';
import type { Artist } from '../types';

export function Artists() {
  const [search, setSearch] = createSignal('');
  const [trackSearch, setTrackSearch] = createSignal('');
  const [active, setActive] = createSignal<Artist | null>(null);

  // Reset detail view when the user re-clicks Artists in the sidebar.
  createEffect(() => {
    const click = getNavClick();
    if (click.nonce && click.path === '/artists') {
      setActive(null);
      setTrackSearch('');
    }
  });

  const artists = useQuery(() => ({ queryKey: ['artists'], queryFn: api.getArtists }));

  // Consume cross-page "open artist X" intents (e.g. context menu, clickable
  // artist names elsewhere in the app).
  createEffect(() => {
    const id = getPendingArtistId();
    if (id == null) return;
    const list = artists.data?.artists;
    if (!list) return;             // wait for the list to load, effect re-runs when it does
    const artist = list.find((a) => a.id === id);
    if (artist) {
      setActive(artist);
      clearPendingArtistId();
    } else {
      // Unknown id — clear so we don't loop.
      clearPendingArtistId();
    }
  });

  const tracks = useQuery(() => ({
    queryKey: ['artist-tracks', active()?.id],
    queryFn: () =>
      api.getTracks({
        artist_id: active()!.id,
        sort: 'album',
        order: 'asc',
        limit: 5000
      }),
    enabled: Boolean(active())
  }));

  const filteredArtists = createMemo(() => {
    const q = search().trim().toLowerCase();
    const list = artists.data?.artists || [];
    if (!q) return list;
    return list.filter((a) => a.name.toLowerCase().includes(q));
  });

  const filteredTracks = createMemo(() => {
    const q = trackSearch().trim().toLowerCase();
    const list = tracks.data?.tracks || [];
    if (!q) return list;
    return list.filter((t) =>
      [t.title, t.album].some((v) => (v || '').toLowerCase().includes(q))
    );
  });

  const goBack = () => {
    setActive(null);
    setTrackSearch('');
  };

  return (
    <div class="page artists-page">
      <div class="page-header">
        <h1>{active()?.name || 'Artists'}</h1>
        <Show when={!active()}>
          <div class="search-input">
            <Search size={16} />
            <input
              data-search-input
              placeholder="Filter artists"
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
            />
          </div>
        </Show>
        <Show when={active()}>
          <div class="search-input">
            <Search size={16} />
            <input
              data-search-input
              placeholder="Filter this artist's tracks"
              value={trackSearch()}
              onInput={(e) => setTrackSearch(e.currentTarget.value)}
            />
          </div>
          <button class="ghost" onClick={goBack}>← All artists</button>
        </Show>
      </div>
      <Show when={!artists.isLoading} fallback={<Spinner />}>
        <Show
          when={active()}
          fallback={
            <Show
              when={filteredArtists().length}
              fallback={<EmptyState title="No artists" description="Run a sync or adjust your search." />}
            >
              <ArtistList artists={filteredArtists()} onSelect={setActive} />
            </Show>
          }
        >
          <Show when={!tracks.isLoading} fallback={<Spinner />}>
            <Show
              when={filteredTracks().length}
              fallback={<EmptyState title="No tracks for this artist" />}
            >
              <TrackList
                tracks={filteredTracks()}
                playQueue={tracks.data?.tracks || []}
              />
            </Show>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
