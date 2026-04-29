import { Mic2 } from 'lucide-solid';
import { For } from 'solid-js';
import type { Artist } from '../../types';

interface ArtistListProps {
  artists: Artist[];
  onSelect?: (artist: Artist) => void;
}

export function ArtistList(props: ArtistListProps) {
  return (
    <div class="artist-list">
      <For each={props.artists}>{(artist) => (
        <button class="artist-card" onClick={() => props.onSelect?.(artist)}>
          <span class="artist-avatar"><Mic2 size={20} /></span>
          <div class="artist-meta">
            <strong>{artist.name}</strong>
            <span class="muted">
              {artist.albumCount ?? 0} albums · {artist.trackCount ?? 0} tracks
            </span>
          </div>
        </button>
      )}</For>
    </div>
  );
}
