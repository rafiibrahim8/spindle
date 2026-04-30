import { useNavigate } from '@solidjs/router';
import { useQuery, useQueryClient } from '@tanstack/solid-query';
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { api } from '../../api/client';
import { useLikeToggle } from '../../hooks/useLike';
import { openAlbum, openArtist } from '../../store/navStore';
import { usePlayerStore } from '../../store/playerStore';
import type { Track } from '../../types';

interface TrackContextMenuProps {
  track: Track;
  x: number;
  y: number;
  onClose: () => void;
}

export function TrackContextMenu(props: TrackContextMenuProps) {
  const player = usePlayerStore();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toggleLike = useLikeToggle();
  const [showPlaylists, setShowPlaylists] = createSignal(false);

  const playlists = useQuery(() => ({
    queryKey: ['playlists'],
    queryFn: api.getPlaylists,
    enabled: showPlaylists()
  }));

  onMount(() => {
    const onDocClick = () => props.onClose();
    document.addEventListener('click', onDocClick, { once: true });
    onCleanup(() => document.removeEventListener('click', onDocClick));
  });

  const userPlaylists = () => playlists.data?.playlists.filter((p) => !p.readOnly) ?? [];

  const playNow = () => {
    player.setTrack(props.track, [props.track], 0);
    props.onClose();
  };
  const addToQueue = () => {
    player.addToQueue(props.track);
    props.onClose();
  };
  const goToArtist = () => {
    openArtist(props.track.artistId, navigate);
    props.onClose();
  };
  const goToAlbum = () => {
    openAlbum(props.track.albumId, navigate);
    props.onClose();
  };
  const reveal = async () => {
    await api.revealTrack(props.track.id).catch(() => {});
    props.onClose();
  };
  const addToPlaylist = async (playlistId: number) => {
    await api.addTrackToPlaylist(playlistId, props.track.id).catch(() => {});
    void queryClient.invalidateQueries({ queryKey: ['playlist', playlistId] });
    props.onClose();
  };

  return (
    <Portal>
    <div
      class="context-menu"
      style={{ top: `${props.y}px`, left: `${props.x}px` }}
      onClick={(e) => e.stopPropagation()}
    >
      <button onClick={playNow}>Play Now</button>
      <button onClick={addToQueue}>Add to Queue</button>
      <button onClick={() => { void toggleLike(props.track); props.onClose(); }}>
        {props.track.liked ? 'Unlike' : 'Like'}
      </button>
      <button
        class={`with-submenu ${showPlaylists() ? 'open' : ''}`}
        onMouseEnter={() => setShowPlaylists(true)}
      >
        Add to Playlist ▸
        <Show when={showPlaylists()}>
          <div class="context-submenu">
            <Show
              when={userPlaylists().length}
              fallback={<span class="muted">No playlists</span>}
            >
              <For each={userPlaylists()}>{(p) => (
                <button onClick={() => addToPlaylist(p.id)}>{p.name}</button>
              )}</For>
            </Show>
          </div>
        </Show>
      </button>
      <button onClick={goToArtist} disabled={!props.track.artistId}>Go to Artist</button>
      <button onClick={goToAlbum} disabled={!props.track.albumId}>Go to Album</button>
      <button onClick={reveal}>Show in Finder / Explorer</button>
    </div>
    </Portal>
  );
}
