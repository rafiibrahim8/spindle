import { createStore } from 'solid-js/store';

export interface LibraryFilters {
  search: string;
  artist: string;
  album: string;
  genre: string;
  sort: 'title' | 'artist' | 'album' | 'date_added' | 'duration' | 'play_count';
  order: 'asc' | 'desc';
}

const [libraryStore, setLibraryStore] = createStore<LibraryFilters>({
  search: '',
  artist: '',
  album: '',
  genre: '',
  sort: 'title',
  order: 'asc'
});

export function useLibraryStore() {
  return [libraryStore, setLibraryStore] as const;
}
