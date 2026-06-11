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
  const [menuSize, setMenuSize] = createSignal({ width: 220, height: 260 });
  let menuEl: HTMLDivElement | undefined;

  const playlists = useQuery(() => ({
    queryKey: ['playlists'],
    queryFn: api.getPlaylists,
    enabled: showPlaylists()
  }));

  onMount(() => {
    if (menuEl) {
      const rect = menuEl.getBoundingClientRect();
      setMenuSize({ width: rect.width, height: rect.height });
    }
    // Solid delegates the menu's own onClick through a document-level
    // listener, so stopPropagation inside the menu can't beat these native
    // document listeners — ignore events originating inside the menu instead.
    const isInsideMenu = (e: Event) =>
      menuEl != null && e.target instanceof Node && menuEl.contains(e.target);
    const onDocClick = (e: MouseEvent) => {
      if (!isInsideMenu(e)) props.onClose();
    };
    const onDocContextMenu = (e: MouseEvent) => {
      if (!isInsideMenu(e)) props.onClose();
    };
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    document.addEventListener('click', onDocClick);
    document.addEventListener('contextmenu', onDocContextMenu);
    document.addEventListener('keydown', onDocKeyDown);
    onCleanup(() => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('contextmenu', onDocContextMenu);
      document.removeEventListener('keydown', onDocKeyDown);
    });
  });

  // Clamp the menu so it never renders past the viewport edges.
  const pos = () => ({
    x: Math.max(8, Math.min(props.x, window.innerWidth - menuSize().width - 8)),
    y: Math.max(8, Math.min(props.y, window.innerHeight - menuSize().height - 8))
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
  const addToPlaylist = async (playlistId: number) => {
    try {
      await api.addTrackToPlaylist(playlistId, props.track.id);
      void queryClient.invalidateQueries({ queryKey: ['playlist', playlistId] });
      void queryClient.invalidateQueries({ queryKey: ['playlists'] });
    } catch {
      // Ignore — the menu closes either way.
    }
    props.onClose();
  };

  return (
    <Portal>
    <div
      ref={menuEl}
      class="context-menu"
      style={{ top: `${pos().y}px`, left: `${pos().x}px` }}
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
    </div>
    </Portal>
  );
}
