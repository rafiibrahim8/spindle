import { useQuery, useQueryClient } from '@tanstack/solid-query';
import { ListMusic, Plus, Search } from 'lucide-solid';
import { Show, createEffect, createMemo, createSignal } from 'solid-js';
import { api } from '../api/client';
import { TrackList } from '../components/Library/TrackList';
import { EmptyState } from '../components/common/EmptyState';
import { Spinner } from '../components/common/Spinner';
import { getNavClick } from '../store/navStore';
import type { Playlist } from '../types';

export function Playlists() {
  const queryClient = useQueryClient();
  const [search, setSearch] = createSignal('');
  const [trackSearch, setTrackSearch] = createSignal('');
  const [active, setActive] = createSignal<Playlist | null>(null);

  // Reset detail view when sidebar nav-link is re-clicked.
  createEffect(() => {
    const click = getNavClick();
    if (click.nonce && click.path === '/playlists') {
      setActive(null);
      setTrackSearch('');
    }
  });

  const playlists = useQuery(() => ({
    queryKey: ['playlists'],
    queryFn: () => api.getPlaylists()
  }));

  const playlistDetail = useQuery(() => ({
    queryKey: ['playlist', active()?.id],
    queryFn: () => api.getPlaylistTracks(active()!.id),
    enabled: Boolean(active())
  }));

  const filteredPlaylists = createMemo(() => {
    const q = search().trim().toLowerCase();
    const list = playlists.data?.playlists || [];
    if (!q) return list;
    return list.filter((p) => p.name.toLowerCase().includes(q));
  });

  const filteredTracks = createMemo(() => {
    const q = trackSearch().trim().toLowerCase();
    const list = playlistDetail.data?.tracks || [];
    if (!q) return list;
    return list.filter((t) =>
      [t.title, t.artist, t.album].some((v) => (v || '').toLowerCase().includes(q))
    );
  });

  // Smart playlists go in their own group at the top.
  const smartPlaylists = createMemo(() =>
    filteredPlaylists().filter((p) => p.readOnly === 1)
  );
  const userPlaylists = createMemo(() =>
    filteredPlaylists().filter((p) => p.readOnly !== 1)
  );

  const newPlaylist = async () => {
    const name = window.prompt('Playlist name');
    if (!name?.trim()) return;
    try {
      await api.createPlaylist(name.trim());
      await queryClient.invalidateQueries({ queryKey: ['playlists'] });
    } catch (err) {
      window.alert('Could not create playlist: ' + (err as Error).message);
    }
  };

  const goBack = () => {
    setActive(null);
    setTrackSearch('');
  };

  return (
    <div class="page playlists-page">
      <div class="page-header">
        <h1>{active()?.name || 'Playlists'}</h1>
        <Show when={!active()}>
          <div class="search-input">
            <Search size={16} />
            <input
              data-search-input
              placeholder="Filter playlists"
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
            />
          </div>
          <button class="ghost" onClick={newPlaylist} title="New playlist">
            <Plus size={16} /> New
          </button>
        </Show>
        <Show when={active()}>
          <div class="search-input">
            <Search size={16} />
            <input
              data-search-input
              placeholder="Filter this playlist"
              value={trackSearch()}
              onInput={(e) => setTrackSearch(e.currentTarget.value)}
            />
          </div>
          <button class="ghost" onClick={goBack}>← All playlists</button>
        </Show>
      </div>

      <Show when={!playlists.isLoading} fallback={<Spinner />}>
        <Show
          when={active()}
          fallback={
            <Show
              when={filteredPlaylists().length}
              fallback={
                <EmptyState
                  title="No playlists"
                  description="Smart playlists appear here after a sync. Click + New to add your own."
                />
              }
            >
              <Show when={smartPlaylists().length}>
                <h2 class="playlist-group-title">Smart</h2>
                <PlaylistGrid playlists={smartPlaylists()} onSelect={setActive} />
              </Show>
              <Show when={userPlaylists().length}>
                <h2 class="playlist-group-title">Yours</h2>
                <PlaylistGrid playlists={userPlaylists()} onSelect={setActive} />
              </Show>
            </Show>
          }
        >
          <Show when={!playlistDetail.isLoading} fallback={<Spinner />}>
            <Show
              when={filteredTracks().length}
              fallback={<EmptyState title="No tracks in this playlist" />}
            >
              <TrackList
                tracks={filteredTracks()}
                playQueue={playlistDetail.data?.tracks || []}
              />
            </Show>
          </Show>
        </Show>
      </Show>
    </div>
  );
}

function PlaylistGrid(props: { playlists: Playlist[]; onSelect: (p: Playlist) => void }) {
  return (
    <div class="playlist-grid">
      {props.playlists.map((p) => (
        <button class="playlist-card" onClick={() => props.onSelect(p)}>
          <div class="playlist-card-icon">
            <ListMusic size={28} />
          </div>
          <div class="playlist-card-meta">
            <strong class="truncate">{p.name}</strong>
            <span class="muted">
              {p.trackCount ?? 0} {p.trackCount === 1 ? 'track' : 'tracks'}
              {p.readOnly === 1 ? ' · Smart' : ''}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}
