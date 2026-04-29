import { createStore, produce } from 'solid-js/store';
import { api } from '../api/client';
import type { Track } from '../types';

export const audioEl = new Audio();
audioEl.preload = 'metadata';
audioEl.crossOrigin = 'anonymous';

const nextAudioEl = new Audio();
nextAudioEl.preload = 'auto';
nextAudioEl.crossOrigin = 'anonymous';

const bands = [60, 250, 1000, 4000, 16000];

export const equalizerPresets: Record<string, number[]> = {
  Flat: [0, 0, 0, 0, 0],
  'Bass Boost': [7, 5, 1, 0, 0],
  'Treble Boost': [0, 0, 1, 5, 7],
  Vocal: [-2, 1, 5, 3, -1],
  Electronic: [5, 2, -1, 3, 5]
};

let audioContext: AudioContext | null = null;
let analyserNode: AnalyserNode | null = null;
let filters: BiquadFilterNode[] = [];
let sourceNode: MediaElementAudioSourceNode | null = null;

const PLAYBACK_SESSION_KEY = 'music-player:playback-session';
const POSITION_SAVE_INTERVAL_MS = 10_000;
let lastPositionSaveAt = 0;
let restoringSession = false;
let nextPreloadedFor: number | null = null;

interface PersistedPlaybackSession {
  currentTrack: Track | null;
  queue: Track[];
  queueIndex: number;
  currentTime: number;
  duration: number;
  shuffle: boolean;
  repeat: 'none' | 'one' | 'all';
  volume: number;
  isMuted: boolean;
  savedAt: number;
}

interface PlayerStateActions {
  setTrack: (track: Track, queue?: Track[], index?: number) => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  seek: (time: number) => void;
  next: () => void;
  prev: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  addToQueue: (track: Track) => void;
  reorderQueue: (from: number, to: number) => void;
  setEqualizerBand: (index: number, value: number) => void;
  applyEqualizerPreset: (preset: string) => void;
  setEqualizerSettings: (values: number[], preset: string) => void;
  setShowNowPlaying: (open: boolean) => void;
  setPanelTab: (tab: PanelTab) => void;
  toggleLyrics: () => void;
  openLyricsPanel: () => void;
  openNowPlayingPanel: () => void;
  openQueuePanel: () => void;
  getAnalyser: () => AnalyserNode | null;
  saveSession: () => void;
  refreshCurrentTrack: () => void;
}

export type PanelTab = 'album' | 'lyrics' | 'queue';

interface PlayerState extends PlayerStateActions {
  currentTrack: Track | null;
  isPlaying: boolean;
  audioError: string | null;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;
  shuffle: boolean;
  repeat: 'none' | 'one' | 'all';
  queue: Track[];
  queueIndex: number;
  completedReported: boolean;
  showNowPlaying: boolean;
  panelTab: PanelTab;
  equalizer: number[];
  equalizerPreset: string;
}

function readNumberLs(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const [playerStore, setPlayerStore] = createStore<PlayerState>({
  currentTrack: null,
  isPlaying: false,
  audioError: null,
  currentTime: 0,
  duration: 0,
  volume: readNumberLs('volume', 0.8),
  isMuted: false,
  shuffle: false,
  repeat: 'none',
  queue: [],
  queueIndex: -1,
  completedReported: false,
  showNowPlaying: false,
  panelTab: 'album',
  equalizer: equalizerPresets.Flat.slice(),
  equalizerPreset: 'Flat',

  setTrack(track, queue, index = 0) {
    const finalQueue = queue && queue.length ? queue : [track];
    const finalIndex = Math.max(0, Math.min(index, finalQueue.length - 1));
    ensureAudioGraph();
    void audioContext?.resume();
    setPlayerStore('audioError', null);
    audioEl.src = api.streamUrl(track.id);
    audioEl.volume = playerStore.isMuted ? 0 : playerStore.volume;
    audioEl.play().catch((err: Error) => {
      console.error('[player] play() rejected:', err);
      setPlayerStore({ isPlaying: false, audioError: `Playback failed: ${err.message}` });
    });
    void api.recordPlay(track.id, false).catch(console.error);
    updateMediaSession(track);
    setPlayerStore({
      currentTrack: track,
      isPlaying: true,
      queue: finalQueue,
      queueIndex: finalIndex,
      currentTime: 0,
      duration: track.duration || 0,
      completedReported: false
    });
    nextPreloadedFor = null;
    savePlaybackSession();
    preloadNext();
  },

  play() {
    if (!playerStore.currentTrack) return;
    ensureAudioGraph();
    void audioContext?.resume();
    setPlayerStore('audioError', null);
    audioEl.play().catch((err: Error) => {
      console.error('[player] play() rejected:', err);
      setPlayerStore({ isPlaying: false, audioError: `Playback failed: ${err.message}` });
    });
    setPlayerStore('isPlaying', true);
    savePlaybackSession();
  },

  pause() {
    audioEl.pause();
    setPlayerStore('isPlaying', false);
    savePlaybackSession();
  },

  togglePlay() {
    if (playerStore.isPlaying) playerStore.pause();
    else playerStore.play();
  },

  seek(time) {
    if (!Number.isFinite(time)) return;
    audioEl.currentTime = Math.max(0, time);
    setPlayerStore('currentTime', audioEl.currentTime);
    savePlaybackSession();
  },

  next() {
    const { queue, queueIndex, shuffle, repeat } = playerStore;
    if (!queue.length) return;

    if (repeat === 'one' && playerStore.currentTrack) {
      audioEl.currentTime = 0;
      void audioEl.play().catch(console.error);
      return;
    }

    let nextIndex: number;
    if (shuffle && queue.length > 1) {
      do {
        nextIndex = Math.floor(Math.random() * queue.length);
      } while (nextIndex === queueIndex);
    } else {
      nextIndex = queueIndex + 1;
      if (nextIndex >= queue.length) {
        if (repeat === 'all') nextIndex = 0;
        else {
          audioEl.pause();
          setPlayerStore({ isPlaying: false });
          return;
        }
      }
    }
    const track = queue[nextIndex];
    if (track) playerStore.setTrack(track, queue, nextIndex);
  },

  prev() {
    const { queue, queueIndex } = playerStore;
    if (!queue.length) return;
    if (audioEl.currentTime > 3) {
      audioEl.currentTime = 0;
      return;
    }
    const prevIndex = Math.max(0, queueIndex - 1);
    const track = queue[prevIndex];
    if (track) playerStore.setTrack(track, queue, prevIndex);
  },

  toggleShuffle() {
    setPlayerStore('shuffle', (s) => !s);
    savePlaybackSession();
  },

  cycleRepeat() {
    setPlayerStore('repeat', (r) => (r === 'none' ? 'all' : r === 'all' ? 'one' : 'none'));
    savePlaybackSession();
  },

  setVolume(volume) {
    const clamped = Math.min(1, Math.max(0, volume));
    audioEl.volume = clamped;
    try { localStorage.setItem('volume', String(clamped)); } catch {}
    setPlayerStore({ volume: clamped, isMuted: clamped === 0 });
    savePlaybackSession();
  },

  toggleMute() {
    const next = !playerStore.isMuted;
    audioEl.volume = next ? 0 : playerStore.volume;
    setPlayerStore('isMuted', next);
    savePlaybackSession();
  },

  addToQueue(track) {
    setPlayerStore('queue', (q) => [...q, track]);
    savePlaybackSession();
  },

  reorderQueue(from, to) {
    setPlayerStore(produce((state) => {
      if (from < 0 || from >= state.queue.length) return;
      if (to < 0 || to >= state.queue.length) return;
      const [moved] = state.queue.splice(from, 1);
      state.queue.splice(to, 0, moved);
      // Keep queueIndex tracking the current track.
      if (state.queueIndex === from) state.queueIndex = to;
      else if (from < state.queueIndex && to >= state.queueIndex) state.queueIndex--;
      else if (from > state.queueIndex && to <= state.queueIndex) state.queueIndex++;
    }));
    savePlaybackSession();
  },

  setEqualizerBand(index, value) {
    if (index < 0 || index >= bands.length) return;
    const clamped = Math.min(12, Math.max(-12, value));
    setPlayerStore('equalizer', (eq) => {
      const next = eq.slice();
      next[index] = clamped;
      return next;
    });
    if (filters[index]) filters[index].gain.value = clamped;
  },

  applyEqualizerPreset(preset) {
    const values = equalizerPresets[preset] || equalizerPresets.Flat;
    playerStore.setEqualizerSettings(values, preset);
  },

  setEqualizerSettings(values, preset) {
    ensureAudioGraph();
    const normalized = values.slice(0, 5);
    while (normalized.length < 5) normalized.push(0);
    setPlayerStore({ equalizer: normalized, equalizerPreset: preset });
    normalized.forEach((value, index) => {
      if (filters[index]) filters[index].gain.value = value;
    });
  },

  setShowNowPlaying(open) {
    setPlayerStore('showNowPlaying', open);
  },

  setPanelTab(tab) {
    setPlayerStore({ panelTab: tab, showNowPlaying: true });
  },

  toggleLyrics() {
    if (playerStore.showNowPlaying && playerStore.panelTab === 'lyrics') {
      setPlayerStore('panelTab', 'album');
    } else {
      setPlayerStore({ panelTab: 'lyrics', showNowPlaying: true });
    }
  },

  openLyricsPanel() {
    setPlayerStore({ panelTab: 'lyrics', showNowPlaying: true });
  },

  openNowPlayingPanel() {
    setPlayerStore({ showNowPlaying: true, panelTab: playerStore.panelTab || 'album' });
  },

  openQueuePanel() {
    setPlayerStore({ panelTab: 'queue', showNowPlaying: true });
  },

  getAnalyser() {
    return analyserNode;
  },

  saveSession() {
    savePlaybackSession();
  },

  refreshCurrentTrack() {
    const id = playerStore.currentTrack?.id;
    if (typeof id !== 'number') return;
    refreshCurrentTrackMetadata(id);
  }
});

export function usePlayerStore() {
  return playerStore;
}

// ────────────────────────────────────────────────────────────────────────
// Audio graph — built lazily on first play (browsers require a user gesture).
// ────────────────────────────────────────────────────────────────────────

function ensureAudioGraph(): void {
  if (audioContext) return;
  try {
    const Ctor = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    audioContext = new Ctor();
    sourceNode = audioContext.createMediaElementSource(audioEl);

    filters = bands.map((freq, i) => {
      const filter = audioContext!.createBiquadFilter();
      filter.type = 'peaking';
      filter.frequency.value = freq;
      filter.Q.value = 1.1;
      filter.gain.value = playerStore.equalizer[i] || 0;
      return filter;
    });

    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;
    analyserNode.smoothingTimeConstant = 0.82;

    let head: AudioNode = sourceNode;
    for (const filter of filters) {
      head.connect(filter);
      head = filter;
    }
    head.connect(analyserNode);
    analyserNode.connect(audioContext.destination);
  } catch (err) {
    console.warn('[player] Web Audio init failed:', (err as Error).message);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Media Session (OS-level controls)
// ────────────────────────────────────────────────────────────────────────

function updateMediaSession(track: Track): void {
  if (!('mediaSession' in navigator)) return;
  const artUrl = api.artUrl(track.artPath);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title || '',
    artist: track.artist || '',
    album: track.album || '',
    artwork: artUrl
      ? [{ src: artUrl, sizes: '500x500', type: 'image/webp' }]
      : []
  });
  navigator.mediaSession.setActionHandler('play', () => playerStore.play());
  navigator.mediaSession.setActionHandler('pause', () => playerStore.pause());
  navigator.mediaSession.setActionHandler('nexttrack', () => playerStore.next());
  navigator.mediaSession.setActionHandler('previoustrack', () => playerStore.prev());
  navigator.mediaSession.setActionHandler('seekto', (details) => {
    if (typeof details.seekTime === 'number') {
      playerStore.seek(details.seekTime);
    }
  });
  navigator.mediaSession.setActionHandler('seekbackward', (details) => {
    const offset = details.seekOffset || 10;
    playerStore.seek(Math.max(0, audioEl.currentTime - offset));
  });
  navigator.mediaSession.setActionHandler('seekforward', (details) => {
    const offset = details.seekOffset || 10;
    const limit = audioEl.duration || playerStore.duration || Infinity;
    playerStore.seek(Math.min(limit, audioEl.currentTime + offset));
  });
}

function setMediaPlaybackState(state: 'playing' | 'paused' | 'none'): void {
  if (!('mediaSession' in navigator)) return;
  try { navigator.mediaSession.playbackState = state; } catch {}
}

let lastPositionStateAt = 0;
function updateMediaPositionState(force = false): void {
  if (!('mediaSession' in navigator)) return;
  const session = navigator.mediaSession as MediaSession & {
    setPositionState?: (state?: MediaPositionState) => void;
  };
  if (typeof session.setPositionState !== 'function') return;

  const now = performance.now();
  if (!force && now - lastPositionStateAt < 900) return;  // throttle to ~1 Hz
  lastPositionStateAt = now;

  const duration = audioEl.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    try { session.setPositionState(); } catch {}     // clear when unknown
    return;
  }
  try {
    session.setPositionState({
      duration,
      position: Math.min(audioEl.currentTime, duration),
      playbackRate: audioEl.playbackRate || 1
    });
  } catch {
    // Some browsers throw if values are out of range; ignore.
  }
}

// ────────────────────────────────────────────────────────────────────────
// Audio element listeners
// ────────────────────────────────────────────────────────────────────────

audioEl.addEventListener('loadedmetadata', () => {
  setPlayerStore('duration', audioEl.duration || playerStore.duration);
  updateMediaPositionState(true);
});

audioEl.addEventListener('timeupdate', () => {
  setPlayerStore('currentTime', audioEl.currentTime);

  // 80%-completion mark — single-shot per track.
  const duration = audioEl.duration || playerStore.duration;
  if (
    playerStore.currentTrack &&
    !playerStore.completedReported &&
    duration &&
    audioEl.currentTime / duration >= 0.8
  ) {
    setPlayerStore('completedReported', true);
    void api.recordPlay(playerStore.currentTrack.id, true).catch(console.error);
  }

  // Throttled position checkpoint.
  const now = Date.now();
  if (now - lastPositionSaveAt >= POSITION_SAVE_INTERVAL_MS) {
    lastPositionSaveAt = now;
    savePlaybackSession();
  }

  // Throttled OS position state push (~1 Hz).
  updateMediaPositionState();

  // Gapless preload when ≤5 s remain.
  if (duration && duration - audioEl.currentTime <= 5) {
    preloadNext();
  }
});

audioEl.addEventListener('play', () => {
  setPlayerStore('isPlaying', true);
  setMediaPlaybackState('playing');
  updateMediaPositionState(true);
});

audioEl.addEventListener('pause', () => {
  if (!audioEl.ended) {
    setPlayerStore('isPlaying', false);
    setMediaPlaybackState('paused');
    updateMediaPositionState(true);
  }
});

audioEl.addEventListener('seeked', () => {
  updateMediaPositionState(true);
});

audioEl.addEventListener('ratechange', () => {
  updateMediaPositionState(true);
});

audioEl.addEventListener('ended', () => {
  setPlayerStore('isPlaying', false);
  if (playerStore.repeat === 'one' && playerStore.currentTrack) {
    audioEl.currentTime = 0;
    void audioEl.play().catch(console.error);
    return;
  }
  playerStore.next();
});

audioEl.addEventListener('error', () => {
  const err = audioEl.error;
  console.error('[player] audio error', err);
  let message = 'Playback failed';
  if (err) {
    switch (err.code) {
      case MediaError.MEDIA_ERR_ABORTED: message = 'Playback aborted'; break;
      case MediaError.MEDIA_ERR_NETWORK: message = 'Network error — could not load track'; break;
      case MediaError.MEDIA_ERR_DECODE: message = 'Decode error — codec not supported by your browser'; break;
      case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
        message = 'Source not supported (404, CORS, or unsupported codec)'; break;
    }
    if (err.message) message += `: ${err.message}`;
  }
  setPlayerStore({ isPlaying: false, audioError: message });
});

// ────────────────────────────────────────────────────────────────────────
// Gapless preload
// ────────────────────────────────────────────────────────────────────────

function preloadNext(): void {
  const { queue, queueIndex } = playerStore;
  if (queueIndex < 0 || queueIndex >= queue.length - 1) return;
  const next = queue[queueIndex + 1];
  if (!next || nextPreloadedFor === next.id) return;
  nextAudioEl.src = api.streamUrl(next.id);
  nextPreloadedFor = next.id;
}

// ────────────────────────────────────────────────────────────────────────
// localStorage session persistence
// ────────────────────────────────────────────────────────────────────────

function compactTrack(track: Track | null): Track | null {
  if (!track) return null;
  return {
    ...track,
    artPath: track.artPath ?? track.art_path ?? null,
    art_path: track.art_path ?? track.artPath ?? null
  };
}

export function savePlaybackSession(): void {
  if (restoringSession) return;
  try {
    const blob: PersistedPlaybackSession = {
      currentTrack: compactTrack(playerStore.currentTrack),
      queue: playerStore.queue.map((t) => compactTrack(t) as Track),
      queueIndex: playerStore.queueIndex,
      currentTime: audioEl.currentTime,
      duration: playerStore.duration,
      shuffle: playerStore.shuffle,
      repeat: playerStore.repeat,
      volume: playerStore.volume,
      isMuted: playerStore.isMuted,
      savedAt: Date.now()
    };
    localStorage.setItem(PLAYBACK_SESSION_KEY, JSON.stringify(blob));
  } catch {
    // Quota or other errors — ignore.
  }
}

function readPlaybackSession(): PersistedPlaybackSession | null {
  try {
    const raw = localStorage.getItem(PLAYBACK_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      !parsed ||
      typeof parsed.currentTime !== 'number' ||
      !Array.isArray(parsed.queue)
    ) return null;
    return parsed as PersistedPlaybackSession;
  } catch {
    return null;
  }
}

export function restorePlaybackSession(): void {
  const blob = readPlaybackSession();
  if (!blob || !blob.currentTrack) return;
  restoringSession = true;
  const track = compactTrack(blob.currentTrack)!;

  audioEl.src = api.streamUrl(track.id);
  audioEl.volume = blob.isMuted ? 0 : blob.volume;

  const onLoaded = () => {
    audioEl.removeEventListener('loadedmetadata', onLoaded);
    const target = Math.max(0, Math.min(blob.currentTime, audioEl.duration || blob.duration || 0));
    if (Number.isFinite(target)) {
      try { audioEl.currentTime = target; } catch {}
    }
    setPlayerStore({
      currentTrack: track,
      queue: blob.queue.map((t) => compactTrack(t) as Track),
      queueIndex: blob.queueIndex,
      currentTime: target,
      duration: audioEl.duration || blob.duration || 0,
      shuffle: blob.shuffle,
      repeat: blob.repeat,
      volume: blob.volume,
      isMuted: blob.isMuted,
      isPlaying: false,        // never auto-play after a refresh
      completedReported: false
    });
    updateMediaSession(track);
    preloadNext();
    restoringSession = false;
    refreshCurrentTrackMetadata(track.id);
  };

  if (audioEl.readyState >= 1 && audioEl.duration) {
    onLoaded();
  } else {
    audioEl.addEventListener('loadedmetadata', onLoaded);
  }
}

function refreshCurrentTrackMetadata(trackId: number): void {
  api.getTrack(trackId).then((fresh) => {
    if (playerStore.currentTrack?.id !== fresh.id) return;
    setPlayerStore('currentTrack', compactTrack(fresh)!);
  }).catch(() => {});
}

export function setupPlaybackSessionPersistence(): () => void {
  const onPageHide = () => savePlaybackSession();
  const onBeforeUnload = () => savePlaybackSession();
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') savePlaybackSession();
  };
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('beforeunload', onBeforeUnload);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('beforeunload', onBeforeUnload);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
