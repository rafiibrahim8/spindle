import { useQuery } from '@tanstack/solid-query';
import { Music2, Play } from 'lucide-solid';
import { For, Show } from 'solid-js';
import { api } from '../api/client';
import { AlbumArt } from '../components/NowPlaying/AlbumArt';
import { SyncButton } from '../components/Sync/SyncButton';
import { EmptyState } from '../components/common/EmptyState';
import { HeartButton } from '../components/common/HeartButton';
import { PlayingIndicator } from '../components/common/PlayingIndicator';
import { Spinner } from '../components/common/Spinner';
import { usePlayerStore } from '../store/playerStore';
import type { Track } from '../types';

export function Home() {
  const player = usePlayerStore();
  const status = useQuery(() => ({
    queryKey: ['sync-status'],
    queryFn: () => api.getSyncStatus(),
    staleTime: 5_000
  }));
  const recentlyPlayed = useQuery(() => ({
    queryKey: ['recently-played'],
    queryFn: () => api.getRecentlyPlayed(12)
  }));
  const mostPlayed = useQuery(() => ({
    queryKey: ['most-played'],
    queryFn: () => api.getMostPlayed(12)
  }));
  const recentlyAdded = useQuery(() => ({
    queryKey: ['recently-added'],
    queryFn: () => api.getRecentlyAdded(12)
  }));
  const albums = useQuery(() => ({
    queryKey: ['quick-pick-albums'],
    queryFn: () => api.getAlbums()
  }));

  const quickPick = () => {
    const list = albums.data?.albums || [];
    return [...list].sort(() => Math.random() - 0.5).slice(0, 6);
  };

  const playTrack = (queue: Track[], index: number) => {
    player.setTrack(queue[index], queue, index);
  };

  const isEmpty = () =>
    !status.isLoading && (status.data?.trackCount ?? 0) === 0;

  return (
    <div class="page home-page">
      <h1>Home</h1>

      <Show when={isEmpty()}>
        <div class="home-empty">
          <div class="home-empty-mark">
            <Music2 size={36} />
          </div>
          <h2>Your library is empty</h2>
          <p class="muted">
            Point Spindle at your music folder and we'll index it. After the
            first sync you can re-run it any time from <strong>Settings</strong>.
          </p>
          <SyncButton />
        </div>
      </Show>

      <Show when={!isEmpty()}>
        <Section title="Recently Played" loading={recentlyPlayed.isLoading} tracks={recentlyPlayed.data?.tracks || []} onPlay={playTrack} />
        <Section title="Most Played"     loading={mostPlayed.isLoading}     tracks={mostPlayed.data?.tracks || []}     onPlay={playTrack} />
        <Section title="Recently Added"  loading={recentlyAdded.isLoading}  tracks={recentlyAdded.data?.tracks || []}  onPlay={playTrack} />

      <h2>Quick Pick</h2>
      <Show when={!albums.isLoading} fallback={<Spinner />}>
        <Show when={quickPick().length} fallback={<EmptyState title="No albums yet" description="Run a sync to fill your library." />}>
          <div class="album-grid">
            <For each={quickPick()}>{(album) => (
              <div class="album-card">
                <AlbumArt artPath={album.artPath} title={album.title} size="lg" />
                <div class="album-card-meta">
                  <strong class="truncate">{album.title}</strong>
                  <span class="truncate muted">{album.artist}</span>
                </div>
              </div>
            )}</For>
          </div>
        </Show>
      </Show>
      </Show>
    </div>
  );
}

function Section(props: {
  title: string;
  loading: boolean;
  tracks: Track[];
  onPlay: (queue: Track[], index: number) => void;
}) {
  const player = usePlayerStore();
  return (
    <section class="rail">
      <h2>{props.title}</h2>
      <Show when={!props.loading} fallback={<Spinner />}>
        <Show when={props.tracks.length} fallback={<p class="muted">Nothing here yet.</p>}>
          <div class="rail-track-grid">
            <For each={props.tracks}>{(track, index) => {
              const playRail = () => props.onPlay(props.tracks, index());
              return (
                <div
                  class="track-card"
                  role="button"
                  tabIndex={0}
                  onClick={playRail}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      playRail();
                    }
                  }}
                >
                  <div class="track-card-art">
                    <AlbumArt artPath={track.artPath} title={track.album} size="lg" />
                    <Show
                      when={player.currentTrack?.id === track.id}
                      fallback={<span class="track-card-overlay"><Play size={20} /></span>}
                    >
                      <span class="track-card-playing">
                        <PlayingIndicator active={player.isPlaying} />
                      </span>
                    </Show>
                    <HeartButton track={track} class="track-card-like" />
                  </div>
                  <strong class="truncate">{track.title}</strong>
                  <span class="truncate muted">{track.artist}</span>
                </div>
              );
            }}</For>
          </div>
        </Show>
      </Show>
    </section>
  );
}
