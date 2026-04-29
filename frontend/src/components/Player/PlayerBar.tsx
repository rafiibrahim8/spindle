import { ListMusic, Mic2 } from 'lucide-solid';
import { Show } from 'solid-js';
import { usePlayerStore } from '../../store/playerStore';
import { AlbumArt } from '../NowPlaying/AlbumArt';
import { HeartButton } from '../common/HeartButton';
import { Controls } from './Controls';
import { ProgressBar } from './ProgressBar';
import { VolumeControl } from './VolumeControl';

export function PlayerBar() {
  const player = usePlayerStore();
  const hasLyrics = () =>
    Boolean(player.currentTrack?.hasSyncedLyrics || player.currentTrack?.hasUnsyncedLyrics);

  return (
    <footer class="player-bar">
      <div class="player-track">
        <button
          class="player-art"
          onClick={() => player.openNowPlayingPanel()}
          aria-label="Open Now Playing"
        >
          <AlbumArt
            artPath={player.currentTrack?.artPath ?? null}
            title={player.currentTrack?.album ?? ''}
            size="sm"
          />
        </button>
        <div class="player-meta">
          <Show
            when={player.currentTrack}
            fallback={<span class="player-empty">Nothing playing</span>}
          >
            <strong class="truncate">{player.currentTrack?.title}</strong>
            <span class="truncate muted">{player.currentTrack?.artist}</span>
          </Show>
        </div>
        <Show when={player.currentTrack}>
          <HeartButton track={player.currentTrack} alwaysVisible class="player-like" />
        </Show>
      </div>

      <div class="player-center">
        <Show when={player.audioError}>
          <div class="player-error" role="alert">{player.audioError}</div>
        </Show>
        <Controls />
        <ProgressBar />
      </div>

      <div class="player-right">
        <button
          class={`ctl ${player.showNowPlaying && player.panelTab === 'lyrics' ? 'on' : ''}`}
          onClick={() => player.toggleLyrics()}
          aria-label="Toggle lyrics"
          disabled={!hasLyrics()}
          title={hasLyrics() ? 'Toggle lyrics' : 'No lyrics available'}
        >
          <Mic2 size={16} />
        </button>
        <button
          class={`ctl ${player.showNowPlaying && player.panelTab === 'queue' ? 'on' : ''}`}
          onClick={() => {
            if (player.showNowPlaying && player.panelTab === 'queue') {
              player.setShowNowPlaying(false);
            } else {
              player.openQueuePanel();
            }
          }}
          aria-label="Toggle queue"
        >
          <ListMusic size={16} />
        </button>
        <VolumeControl />
      </div>
    </footer>
  );
}
