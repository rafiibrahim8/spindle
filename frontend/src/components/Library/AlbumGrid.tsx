import { For } from 'solid-js';
import type { Album } from '../../types';
import { AlbumArt } from '../NowPlaying/AlbumArt';

interface AlbumGridProps {
  albums: Album[];
  onSelect?: (album: Album) => void;
}

export function AlbumGrid(props: AlbumGridProps) {
  return (
    <div class="album-grid">
      <For each={props.albums}>{(album) => (
        <button class="album-card" onClick={() => props.onSelect?.(album)}>
          <AlbumArt artPath={album.artPath} title={album.title} size="lg" />
          <div class="album-card-meta">
            <strong class="truncate">{album.title}</strong>
            <span class="truncate muted">{album.artist}</span>
          </div>
        </button>
      )}</For>
    </div>
  );
}
