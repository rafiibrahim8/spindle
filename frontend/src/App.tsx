import { Route, Router } from '@solidjs/router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/solid-query';
import { createEffect, onCleanup, onMount, type JSX } from 'solid-js';
import { api } from './api/client';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { NowPlayingPanel } from './components/NowPlaying/NowPlayingPanel';
import { PlayerBar } from './components/Player/PlayerBar';
import { Sidebar } from './components/Sidebar/Sidebar';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { Albums } from './pages/Albums';
import { Artists } from './pages/Artists';
import { Home } from './pages/Home';
import { Liked } from './pages/Liked';
import { Settings } from './pages/Settings';
import { Tracks } from './pages/Tracks';
import {
  restorePlaybackSession,
  setupPlaybackSessionPersistence,
  usePlayerStore
} from './store/playerStore';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false }
  }
});

function AppShell(props: { children?: JSX.Element }) {
  useKeyboardShortcuts();
  const player = usePlayerStore();
  const settings = useQuery(() => ({ queryKey: ['settings'], queryFn: api.getSettings }));

  onMount(() => {
    restorePlaybackSession();
    const cleanup = setupPlaybackSessionPersistence();
    onCleanup(cleanup);
  });

  // Apply server-side preferences (accent + EQ).
  createEffect(() => {
    const accent =
      settings.data?.accent ||
      localStorage.getItem('accent') ||
      '#1ed760';
    document.documentElement.style.setProperty('--accent', accent);
    try { localStorage.setItem('accent', accent); } catch {}
    if (settings.data) {
      player.setEqualizerSettings(settings.data.equalizer, settings.data.equalizerPreset);
    }
  });

  // Album-art self-heal — refetch the current track if its art is missing.
  let lastSelfHealId: number | null = null;
  createEffect(() => {
    const track = player.currentTrack;
    if (!track || track.artPath) return;
    if (lastSelfHealId === track.id) return;
    lastSelfHealId = track.id;
    player.refreshCurrentTrack();
  });

  return (
    <div class={`app-shell ${player.showNowPlaying ? 'panel-open' : ''}`}>
      <Sidebar />
      <main class="main-content">{props.children}</main>
      <PlayerBar />
      <NowPlayingPanel />
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <Router root={AppShell}>
          <Route path="/" component={Home} />
          <Route path="/tracks" component={Tracks} />
          <Route path="/albums" component={Albums} />
          <Route path="/artists" component={Artists} />
          <Route path="/liked" component={Liked} />
          <Route path="/settings" component={Settings} />
        </Router>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
