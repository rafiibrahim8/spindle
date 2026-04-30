import { useNavigate } from '@solidjs/router';
import { Play } from 'lucide-solid';
import { createSignal, Show } from 'solid-js';
import { openAlbum, openArtist } from '../../store/navStore';
import { usePlayerStore } from '../../store/playerStore';
import type { Track } from '../../types';
import { AlbumArt } from '../NowPlaying/AlbumArt';
import { TrackContextMenu } from '../ContextMenu/TrackContextMenu';
import { HeartButton } from '../common/HeartButton';
import { PlayingIndicator } from '../common/PlayingIndicator';

export interface TrackRowProps {
  track: Track;
  queue?: Track[];
  index?: number;
  onPlay?: (track: Track) => void;
}

export function TrackRow(props: TrackRowProps) {
  const player = usePlayerStore();
  const navigate = useNavigate();
  const [menu, setMenu] = createSignal<{ x: number; y: number } | null>(null);

  const isCurrent = () => player.currentTrack?.id === props.track.id;

  const stop = (e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); };
  const onArtistClick = (e: MouseEvent) => {
    stop(e);
    openArtist(props.track.artistId, navigate);
  };
  const onAlbumClick = (e: MouseEvent) => {
    stop(e);
    openAlbum(props.track.albumId, navigate);
  };

  const play = () => {
    if (props.onPlay) props.onPlay(props.track);
    else player.setTrack(props.track, props.queue || [props.track], props.index ?? 0);
  };

  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY });
  };

  return (
    <div class={`track-row ${isCurrent() ? 'is-current' : ''}`} onContextMenu={onContextMenu}>
      <button
        class={`row-play ${isCurrent() ? 'is-current' : ''}`}
        onClick={play}
        aria-label={isCurrent() ? `Now playing ${props.track.title}` : `Play ${props.track.title}`}
      >
        {isCurrent() ? <PlayingIndicator active={player.isPlaying} /> : <Play size={16} />}
      </button>
      <AlbumArt artPath={props.track.artPath} title={props.track.album} size="sm" />
      <div class="row-meta">
        <strong class="truncate">{props.track.title}</strong>
        <button
          type="button"
          class="truncate muted link-text"
          onClick={onArtistClick}
          disabled={!props.track.artistId}
          title="Go to artist"
        >
          {props.track.artist}
        </button>
      </div>
      <button
        type="button"
        class="row-album truncate link-text"
        onClick={onAlbumClick}
        disabled={!props.track.albumId}
        title="Go to album"
      >
        {props.track.album}
      </button>
      <HeartButton track={props.track} class="row-like" />
      <span class="row-duration">{formatDuration(props.track.duration)}</span>
      <Show when={menu()}>
        {(pos) => (
          <TrackContextMenu
            track={props.track}
            x={pos().x}
            y={pos().y}
            onClose={() => setMenu(null)}
          />
        )}
      </Show>
    </div>
  );
}

function formatDuration(d: number | null | undefined): string {
  const s = Math.max(0, Math.floor(d || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}
