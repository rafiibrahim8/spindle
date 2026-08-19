import { useNavigate } from '@solidjs/router';
import { ListMusic, Mic2, Music, X } from 'lucide-solid';
import { Info } from 'lucide-solid';
import { Match, Show, Switch, createSignal } from 'solid-js';
import { openAlbum, openArtist } from '../../store/navStore';
import { usePlayerStore } from '../../store/playerStore';
import { Controls } from '../Player/Controls';
import { ProgressBar } from '../Player/ProgressBar';
import { QueueView } from '../Queue/QueuePanel';
import { AlbumArt } from './AlbumArt';
import { LyricsDisplay } from './LyricsDisplay';
import { TrackInfo } from './TrackInfo';
import { Waveform } from './Waveform';

export function NowPlayingPanel() {
  const player = usePlayerStore();
  const navigate = useNavigate();
  const [infoOpen, setInfoOpen] = createSignal(false);
  const tabClass = (tab: 'album' | 'lyrics' | 'queue') =>
    player.panelTab === tab ? 'active' : '';

  const goArtist = () => {
    openArtist(player.currentTrack?.artistId, navigate);
    player.setShowNowPlaying(false);
  };
  const goAlbum = () => {
    openAlbum(player.currentTrack?.albumId, navigate);
    player.setShowNowPlaying(false);
  };

  return (
    <Show when={player.showNowPlaying}>
      <aside class={`now-playing-panel tab-${player.panelTab}`} aria-label="Now Playing">
        <header>
          <div class="panel-tabs" role="tablist">
            <button
              class={tabClass('album')}
              onClick={() => player.setPanelTab('album')}
              role="tab"
              aria-selected={player.panelTab === 'album'}
            >
              <Music size={14} /> Album
            </button>
            <button
              class={tabClass('lyrics')}
              onClick={() => player.setPanelTab('lyrics')}
              role="tab"
              aria-selected={player.panelTab === 'lyrics'}
            >
              <Mic2 size={14} /> Lyrics
            </button>
            <button
              class={tabClass('queue')}
              onClick={() => player.setPanelTab('queue')}
              role="tab"
              aria-selected={player.panelTab === 'queue'}
            >
              <ListMusic size={14} /> Queue
            </button>
          </div>
          <button
            class="ctl"
            onClick={() => player.setShowNowPlaying(false)}
            aria-label="Close panel"
          >
            <X size={16} />
          </button>
        </header>

        <Switch>
          <Match when={player.panelTab === 'album'}>
            <div class="now-playing-album">
              <AlbumArt
                artPath={player.currentTrack?.artPath ?? null}
                title={player.currentTrack?.album ?? ''}
                size="xl"
              />
              <div class="now-playing-meta">
                <div class="now-playing-title-row">
                  <h2>{player.currentTrack?.title ?? '—'}</h2>
                  <Show when={player.currentTrack}>
                    <button
                      class="ctl track-info-toggle"
                      onClick={() => setInfoOpen(true)}
                      aria-label="Track details"
                      title="Track details"
                    >
                      <Info size={16} />
                    </button>
                  </Show>
                </div>
                <button
                  type="button"
                  class="link-text"
                  onClick={goArtist}
                  disabled={!player.currentTrack?.artistId}
                >
                  {player.currentTrack?.artist ?? '—'}
                </button>
                <button
                  type="button"
                  class="link-text muted"
                  onClick={goAlbum}
                  disabled={!player.currentTrack?.albumId}
                >
                  {player.currentTrack?.album ?? ''}
                </button>
              </div>
              {/* Opt-in. Rendering it retains the Web Audio graph, which
                  reroutes playback off the platform's offloaded decode path
                  for the rest of the session — so it stays off by default. */}
              <Show when={player.visualizerEnabled}>
                <Waveform />
              </Show>
              <ProgressBar />
              <Controls />
            </div>
          </Match>
          <Match when={player.panelTab === 'lyrics'}>
            <LyricsDisplay />
          </Match>
          <Match when={player.panelTab === 'queue'}>
            <QueueView />
          </Match>
        </Switch>
      </aside>
      <Show when={infoOpen() && player.currentTrack}>
        <TrackInfo trackId={player.currentTrack!.id} onClose={() => setInfoOpen(false)} />
      </Show>
    </Show>
  );
}
