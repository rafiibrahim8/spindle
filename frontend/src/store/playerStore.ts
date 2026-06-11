import { createStore, produce } from 'solid-js/store';
import { api } from '../api/client';
import type { Track } from '../types';

function createAudioElement(): HTMLAudioElement {
  const el = new Audio();
  el.preload = 'auto';
  el.crossOrigin = 'anonymous';
  attachAudioElementListeners(el);
  return el;
}

/**
 * Two audio elements that trade roles: `audioEl` is always the active one,
 * `nextAudioEl` preloads the upcoming track. When playback advances to the
 * preloaded track, the elements swap instead of re-fetching — the buffered
 * data is used directly, so the transition is (near-)gapless.
 *
 * `audioEl` is an `export let` on purpose: ES-module live bindings mean
 * importers always see the currently-active element after a swap.
 */
export let audioEl = createAudioElement();
let nextAudioEl = createAudioElement();

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
const sourceNodes = new Map<HTMLAudioElement, MediaElementAudioSourceNode>();

const PLAYBACK_SESSION_KEY = 'music-player:playback-session';
const PLAYBACK_QUEUE_KEY = 'music-player:playback-queue';
const POSITION_SAVE_INTERVAL_MS = 10_000;
let lastPositionSaveAt = 0;
let restoringSession = false;
let nextPreloadedFor: number | null = null;
/**
 * The queue is persisted under its own localStorage key and only re-serialized
 * when it actually changes — JSON.stringify of a multi-thousand-track queue on
 * every 10 s position checkpoint was a measurable main-thread stall.
 */
let queueDirty = true;

/**
 * Two stacks for reversible prev/next in shuffle mode. `back` holds queue
 * indices played before the current one (most-recent on top); `forward` holds
 * tracks the user prev'd away from (so a subsequent next replays them in
 * order, instead of picking a fresh random).
 *
 * Both are cleared when a brand-new queue is set; only `forward` is cleared
 * when the user jumps to a track within the current queue (e.g. double-click
 * in the queue panel) — that "jump" invalidates the previously-walked path.
 */
let shuffleBack: number[] = [];
let shuffleForward: number[] = [];
/** True while next() / prev() is calling setTrack — tells setTrack to leave the forward stack alone. */
let shufflePathInProgress = false;

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
  patchCurrentTrack: (id: number, patch: Partial<Track>) => void;
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
  playCounted: boolean;
  /** Queue indices that have crossed the play-threshold this session; drives the "Played" label in the queue panel. */
  played: number[];
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
  playCounted: false,
  played: [],
  showNowPlaying: false,
  panelTab: 'album',
  equalizer: equalizerPresets.Flat.slice(),
  equalizerPreset: 'Flat',

  setTrack(track, queue, index = 0) {
    cancelPendingRestoreSeek();
    const finalQueue = queue && queue.length ? queue : [track];
    const finalIndex = Math.max(0, Math.min(index, finalQueue.length - 1));
    // A different queue array means a fresh session — drop both stacks.
    // Same reference but reached without using next/prev (e.g. queue-panel
    // double-click) is a "jump" — it invalidates the prev'd-away forward path
    // but should preserve the back stack so the user can still rewind.
    // next/prev manage stacks themselves before calling setTrack; the
    // `_shufflePathInProgress` flag below tells us not to wipe forward in
    // those cases.
    if (finalQueue !== playerStore.queue) {
      shuffleBack = [];
      shuffleForward = [];
      setPlayerStore('played', []);
      queueDirty = true;
    } else if (!shufflePathInProgress) {
      shuffleForward = [];
    }
    ensureAudioGraph();
    void audioContext?.resume();
    setPlayerStore('audioError', null);
    if (nextPreloadedFor === track.id && nextAudioEl.src) {
      // The preload element already holds this track's buffered data — swap
      // roles instead of re-fetching from byte 0 (near-gapless transition).
      const previous = audioEl;
      previous.pause();
      audioEl = nextAudioEl;
      nextAudioEl = previous;
      nextAudioEl.removeAttribute('src');
      nextAudioEl.load();    // drop the old track's buffer
      if (audioEl.currentTime > 0) {
        try { audioEl.currentTime = 0; } catch {}
      }
    } else {
      audioEl.src = api.streamUrl(track.id);
    }
    audioEl.volume = playerStore.isMuted ? 0 : playerStore.volume;
    startPlayback();
    // Don't count the play yet — wait until the user has actually heard ≥30 s
    // or 25 % of the track (timeupdate handler below).
    updateMediaSession(track);
    setPlayerStore({
      currentTrack: track,
      isPlaying: true,
      queue: finalQueue,
      queueIndex: finalIndex,
      currentTime: 0,
      duration: track.duration || 0,
      completedReported: false,
      playCounted: false
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
    startPlayback();
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
    cancelPendingRestoreSeek();    // a manual scrub outranks the restored position
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
      // Push current onto the back stack. If the user previously prev'd, the
      // forward stack holds the path they came from — replay that in order
      // before picking a fresh random.
      if (queueIndex >= 0) {
        shuffleBack.push(queueIndex);
        // A repeat-all shuffle session runs indefinitely — keep the rewind
        // history bounded.
        if (shuffleBack.length > 500) shuffleBack.splice(0, shuffleBack.length - 500);
      }
      if (shuffleForward.length > 0) {
        nextIndex = shuffleForward.pop()!;
      } else {
        do {
          nextIndex = Math.floor(Math.random() * queue.length);
        } while (nextIndex === queueIndex);
      }
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
    if (track) {
      shufflePathInProgress = true;
      try { playerStore.setTrack(track, queue, nextIndex); }
      finally { shufflePathInProgress = false; }
    }
  },

  prev() {
    const { queue, queueIndex, shuffle } = playerStore;
    if (!queue.length) return;
    if (audioEl.currentTime > 3) {
      audioEl.currentTime = 0;
      return;
    }
    // Shuffle mode: pop the back stack, push the current onto forward so a
    // subsequent next() replays the path the user came from. When the back
    // stack is empty we fall through to the linear branch — typically a
    // no-op visually since we're at the start of the session.
    if (shuffle && shuffleBack.length > 0) {
      const targetIndex = shuffleBack.pop()!;
      if (queueIndex >= 0) shuffleForward.push(queueIndex);
      const track = queue[targetIndex];
      if (track) {
        shufflePathInProgress = true;
        try { playerStore.setTrack(track, queue, targetIndex); }
        finally { shufflePathInProgress = false; }
        return;
      }
    }
    const prevIndex = Math.max(0, queueIndex - 1);
    const track = queue[prevIndex];
    if (track) {
      // Guard the forward stack here too: in shuffle with an exhausted back
      // stack this linear fallback must not wipe a replayable forward path.
      shufflePathInProgress = true;
      try { playerStore.setTrack(track, queue, prevIndex); }
      finally { shufflePathInProgress = false; }
    }
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
    queueDirty = true;
    savePlaybackSession();
  },

  reorderQueue(from, to) {
    setPlayerStore(produce((state) => {
      if (from < 0 || from >= state.queue.length) return;
      if (to < 0 || to >= state.queue.length) return;
      const [moved] = state.queue.splice(from, 1);
      state.queue.splice(to, 0, moved);
      // Every index-based structure must follow the move: queueIndex, the
      // played set, and the shuffle history stacks all point into the queue.
      const remap = (i: number): number => {
        if (i === from) return to;
        if (from < i && to >= i) return i - 1;
        if (from > i && to <= i) return i + 1;
        return i;
      };
      state.queueIndex = remap(state.queueIndex);
      state.played = state.played.map(remap);
      shuffleBack = shuffleBack.map(remap);
      shuffleForward = shuffleForward.map(remap);
    }));
    queueDirty = true;
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
  },

  patchCurrentTrack(id, patch) {
    if (playerStore.currentTrack?.id !== id) return;
    setPlayerStore('currentTrack', (t) => (t ? { ...t, ...patch } : t));
    patchQueueTrack(id, patch);
  }
});

export function usePlayerStore() {
  return playerStore;
}

function startPlayback(): void {
  const el = audioEl;
  el.preload = 'auto';    // restore loads metadata-only; real playback buffers ahead
  el.play().catch((err: Error) => {
    // A newer load/pause interrupting play() rejects with AbortError — that's
    // the normal rapid-skip flow, not a failure. And if the element was
    // swapped out meanwhile, the rejection belongs to a dead track.
    if (err.name === 'AbortError' || el !== audioEl) return;
    console.error('[player] play() rejected:', err);
    setPlayerStore({ isPlaying: false, audioError: `Playback failed: ${err.message}` });
  });
}

// ────────────────────────────────────────────────────────────────────────
// Audio graph — built lazily on first play (browsers require a user gesture).
// ────────────────────────────────────────────────────────────────────────

function ensureAudioGraph(): void {
  if (!audioContext) {
    try {
      const Ctor = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
      // `latencyHint: 'playback'` asks the browser for a larger audio buffer
      // (~50–100 ms vs. the 3–10 ms default). For music there's no perceptible
      // delay but the audio thread can survive CPU contention and background-tab
      // throttling without underrunning into stutter.
      audioContext = new Ctor({ latencyHint: 'playback' });

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

      let head: AudioNode = filters[0];
      for (let i = 1; i < filters.length; i++) {
        head.connect(filters[i]);
        head = filters[i];
      }
      head.connect(analyserNode);
      analyserNode.connect(audioContext.destination);
    } catch (err) {
      console.warn('[player] Web Audio init failed:', (err as Error).message);
      return;
    }
  }
  // Both elements feed the same filter chain; the inactive one is paused and
  // therefore silent. An element can only ever have one MediaElementSource,
  // so each gets exactly one for its lifetime.
  connectElementSource(audioEl);
  connectElementSource(nextAudioEl);
}

function connectElementSource(el: HTMLAudioElement): void {
  if (!audioContext || sourceNodes.has(el)) return;
  try {
    const source = audioContext.createMediaElementSource(el);
    source.connect(filters[0] ?? audioContext.destination);
    sourceNodes.set(el, source);
  } catch (err) {
    console.warn('[player] media source connect failed:', (err as Error).message);
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
// Audio element listeners — attached to BOTH elements at creation. Every
// handler bails unless its element is currently the active `audioEl`:
// the preload element and a just-swapped-out element still emit events
// (pause on swap, loadedmetadata on preload) that must not touch state.
// ────────────────────────────────────────────────────────────────────────

function attachAudioElementListeners(el: HTMLAudioElement): void {
  const isActive = () => el === audioEl;

  el.addEventListener('loadedmetadata', () => {
    if (!isActive()) return;
    setPlayerStore('duration', audioEl.duration || playerStore.duration);
    updateMediaPositionState(true);
  });

  el.addEventListener('timeupdate', () => {
    if (!isActive()) return;
    setPlayerStore('currentTime', audioEl.currentTime);

    const duration = audioEl.duration || playerStore.duration;

    // Play-count threshold — once per track session, after ≥ 30 s or 25 % of
    // duration (whichever comes first). Skipping a track before this point
    // does not register as a play. Short tracks (e.g. 60 s) still pass via
    // the percentage gate.
    if (
      playerStore.currentTrack &&
      !playerStore.playCounted &&
      (audioEl.currentTime >= 30 || (duration && audioEl.currentTime / duration >= 0.25))
    ) {
      setPlayerStore('playCounted', true);
      // Mark this queue index as played so the queue panel labels it correctly.
      const idx = playerStore.queueIndex;
      if (idx >= 0 && !playerStore.played.includes(idx)) {
        setPlayerStore('played', (arr) => [...arr, idx]);
      }
      void api.recordPlay(playerStore.currentTrack.id).catch(console.error);
    }

    // 80 %-completion mark — single-shot per track. Doesn't bump play_count
    // (that already happened at the threshold above); just sets completed=1
    // on the most recent play_history row.
    if (
      playerStore.currentTrack &&
      !playerStore.completedReported &&
      duration &&
      audioEl.currentTime / duration >= 0.8
    ) {
      setPlayerStore('completedReported', true);
      void api.markPlayCompleted(playerStore.currentTrack.id).catch(console.error);
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

  el.addEventListener('play', () => {
    if (!isActive()) return;
    setPlayerStore('isPlaying', true);
    setMediaPlaybackState('playing');
    updateMediaPositionState(true);
  });

  el.addEventListener('pause', () => {
    if (!isActive() || el.ended) return;
    setPlayerStore('isPlaying', false);
    setMediaPlaybackState('paused');
    updateMediaPositionState(true);
  });

  el.addEventListener('seeked', () => {
    if (!isActive()) return;
    updateMediaPositionState(true);
  });

  el.addEventListener('ratechange', () => {
    if (!isActive()) return;
    updateMediaPositionState(true);
  });

  el.addEventListener('ended', () => {
    if (!isActive()) return;
    setPlayerStore('isPlaying', false);
    if (playerStore.repeat === 'one' && playerStore.currentTrack) {
      audioEl.currentTime = 0;
      void audioEl.play().catch(console.error);
      return;
    }
    playerStore.next();
  });

  el.addEventListener('error', () => {
    if (!isActive()) {
      // A failed preload must not poison the next advance — clear the marker
      // so setTrack falls back to a fresh fetch instead of swapping in a
      // dead element.
      if (el === nextAudioEl && nextPreloadedFor !== null) {
        nextPreloadedFor = null;
        el.removeAttribute('src');
        el.load();
      }
      return;
    }
    const err = el.error;
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
}

// ────────────────────────────────────────────────────────────────────────
// Gapless preload
// ────────────────────────────────────────────────────────────────────────

function preloadNext(): void {
  const { queue, queueIndex, shuffle, repeat } = playerStore;
  if (queueIndex < 0 || !queue.length) return;

  let nextIndex: number;
  if (shuffle && queue.length > 1) {
    // The shuffled successor is random — preloading queueIndex+1 would
    // download a full wrong track per song. The one predictable case is a
    // forward stack from prev(): next() will replay its top.
    if (!shuffleForward.length) return;
    nextIndex = shuffleForward[shuffleForward.length - 1];
  } else {
    nextIndex = queueIndex + 1;
    if (nextIndex >= queue.length) {
      if (repeat !== 'all') return;
      nextIndex = 0;    // wrap-around is the known successor under repeat-all
    }
  }

  const next = queue[nextIndex];
  if (!next || nextPreloadedFor === next.id) return;
  nextAudioEl.preload = 'auto';
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
    // The queue lives under its own key and is re-serialized only when it
    // changed — the frequent saves (position checkpoints, volume, play/pause)
    // then only write the small state blob below.
    if (queueDirty) {
      localStorage.setItem(
        PLAYBACK_QUEUE_KEY,
        JSON.stringify(playerStore.queue.map((t) => compactTrack(t)))
      );
      queueDirty = false;
    }
    const blob: Omit<PersistedPlaybackSession, 'queue'> = {
      currentTrack: compactTrack(playerStore.currentTrack),
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
      typeof parsed.currentTime !== 'number'
    ) return null;
    // Sessions written before the queue was split out carry it inline;
    // otherwise read the separate queue key.
    if (!Array.isArray(parsed.queue)) {
      const rawQueue = localStorage.getItem(PLAYBACK_QUEUE_KEY);
      parsed.queue = rawQueue ? JSON.parse(rawQueue) : [];
      if (!Array.isArray(parsed.queue)) parsed.queue = [];
    }
    return parsed as PersistedPlaybackSession;
  } catch {
    return null;
  }
}

/**
 * Cancels the seek a session restore deferred to `loadedmetadata`. setTrack
 * calls this so a user who picks a new track before the restored one finishes
 * loading can't have the stale restore clobber the fresh playback.
 */
let cancelPendingRestoreSeek: () => void = () => {};

export function restorePlaybackSession(): void {
  const blob = readPlaybackSession();
  if (!blob || !blob.currentTrack) return;
  const track = compactTrack(blob.currentTrack)!;
  const target = Math.max(0, Number.isFinite(blob.currentTime) ? blob.currentTime : 0);
  const knownDuration = blob.duration || track.duration || 0;

  // Apply the whole session synchronously — persistence must keep working
  // even if the saved track never loads (404 after a re-sync, server down).
  // Only the seek waits for metadata.
  restoringSession = true;
  setPlayerStore({
    currentTrack: track,
    queue: blob.queue.map((t) => compactTrack(t) as Track),
    queueIndex: blob.queueIndex,
    currentTime: target,
    duration: knownDuration,
    shuffle: blob.shuffle,
    repeat: blob.repeat,
    volume: blob.volume,
    isMuted: blob.isMuted,
    isPlaying: false,        // never auto-play after a refresh
    // Resuming mid-track must not record another play on every refresh —
    // derive the single-shot flags from the restored position.
    playCounted: target >= 30 || (knownDuration > 0 && target / knownDuration >= 0.25),
    completedReported: knownDuration > 0 && target / knownDuration >= 0.8
  });
  restoringSession = false;
  updateMediaSession(track);

  // Metadata-only until the user presses play — a page load shouldn't
  // download whole tracks (startPlayback flips preload back to 'auto').
  const el = audioEl;
  el.preload = 'metadata';

  const onLoaded = () => {
    cleanup();
    const clamped = Math.min(target, el.duration || target);
    if (Number.isFinite(clamped)) {
      try { el.currentTime = clamped; } catch {}
    }
    setPlayerStore({ currentTime: clamped, duration: el.duration || knownDuration });
    updateMediaPositionState(true);
  };
  const onError = () => cleanup();
  const cleanup = () => {
    el.removeEventListener('loadedmetadata', onLoaded);
    el.removeEventListener('error', onError);
    cancelPendingRestoreSeek = () => {};
  };
  cancelPendingRestoreSeek = cleanup;
  el.addEventListener('loadedmetadata', onLoaded);
  el.addEventListener('error', onError);

  el.src = api.streamUrl(track.id);
  el.volume = blob.isMuted ? 0 : blob.volume;

  refreshCurrentTrackMetadata(track.id);
}

/** Apply a patch to the queue's copy of a track (it's separate from currentTrack). */
function patchQueueTrack(id: number, patch: Partial<Track>): void {
  const qi = playerStore.queue.findIndex((t) => t.id === id);
  if (qi < 0) return;
  setPlayerStore('queue', qi, (t) => ({ ...t, ...patch }));
  queueDirty = true;
}

function refreshCurrentTrackMetadata(trackId: number): void {
  api.getTrack(trackId).then((fresh) => {
    if (playerStore.currentTrack?.id !== fresh.id) return;
    const compact = compactTrack(fresh)!;
    setPlayerStore('currentTrack', compact);
    patchQueueTrack(trackId, compact);
  }).catch(() => {});
}

export function setupPlaybackSessionPersistence(): () => void {
  const onPageHide = () => savePlaybackSession();
  const onBeforeUnload = () => savePlaybackSession();
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      savePlaybackSession();
    } else if (document.visibilityState === 'visible') {
      // Some browsers auto-suspend the AudioContext when the tab is hidden;
      // resume it on return so playback doesn't sit muted/stuttering.
      if (audioContext && audioContext.state === 'suspended') {
        void audioContext.resume();
      }
    }
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
