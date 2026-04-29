import { useQuery } from '@tanstack/solid-query';
import { Search } from 'lucide-solid';
import { Show, createMemo } from 'solid-js';
import { api } from '../api/client';
import { EmptyState } from '../components/common/EmptyState';
import { Spinner } from '../components/common/Spinner';
import { TrackList } from '../components/Library/TrackList';
import { useLibraryStore } from '../store/libraryStore';

export function Tracks() {
  const [filters, setFilters] = useLibraryStore();

  const tracks = useQuery(() => ({
    queryKey: ['tracks', { ...filters }],
    queryFn: () =>
      api.getTracks({
        search: filters.search,
        artist: filters.artist,
        album: filters.album,
        genre: filters.genre,
        sort: filters.sort,
        order: filters.order,
        limit: 5000
      })
  }));

  const list = createMemo(() => tracks.data?.tracks || []);

  return (
    <div class="page tracks-page">
      <div class="page-header">
        <div class="search-input">
          <Search size={16} />
          <input
            data-search-input
            placeholder="Search tracks, artists, albums…"
            value={filters.search}
            onInput={(e) => setFilters('search', e.currentTarget.value)}
          />
        </div>
        <div class="page-controls">
          <select
            value={filters.sort}
            onChange={(e) => setFilters('sort', e.currentTarget.value as typeof filters.sort)}
          >
            <option value="title">Title</option>
            <option value="artist">Artist</option>
            <option value="album">Album</option>
            <option value="date_added">Date added</option>
            <option value="duration">Duration</option>
            <option value="play_count">Play count</option>
          </select>
          <select
            value={filters.order}
            onChange={(e) => setFilters('order', e.currentTarget.value as 'asc' | 'desc')}
          >
            <option value="asc">Asc</option>
            <option value="desc">Desc</option>
          </select>
        </div>
      </div>
      <Show
        when={!tracks.isLoading}
        fallback={<Spinner />}
      >
        <Show
          when={list().length}
          fallback={<EmptyState title="No tracks" description="Try syncing your library or adjusting filters." />}
        >
          <TrackList tracks={list()} />
        </Show>
      </Show>
    </div>
  );
}
