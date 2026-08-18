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
/**
 * How many visualizers are currently mounted. Together with a non-flat EQ this
 * is the only reason to build the Web Audio graph at all — see
 * `audioGraphNeeded()`.
 */
let visualizerRefs = 0;

const PLAYBACK_SESSION_KEY = 'music-player:playback-session';
const PLAYBACK_QUEUE_KEY = 'music-player:playback-queue';
const PLAYBACK_SHUFFLE_KEY = 'music-player:shuffle-bag';
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

/**
 * Queue indices still unplayed in the current shuffle cycle, popped from the
 * tail. Drawing a fresh `Math.random()` index per track samples *with
 * replacement*: repeats appear after ~sqrt(N) tracks and covering an N-track
 * queue takes ~N*ln(N) plays, so on a large library a big share of it never
 * comes up in a listening session. A pre-shuffled bag plays every track
 * exactly once per cycle, then reshuffles for the next one.
 */
let shuffleBag: number[] = [];
/**
 * Queue length the bag was built against, or -1 when there is no live bag.
 * A length mismatch means the queue changed underneath it and the bag has to
 * be rebuilt.
 */
let shuffleBagFor = -1;
let shuffleBagDirty = true;

function resetShuffleBag(): void {
  shuffleBag = [];
  shuffleBagFor = -1;
  shuffleBagDirty = true;
}

/** Fresh unbiased permutation of [0, length). */
function shuffledIndices(length: number): number[] {
  const arr = Array.from({ length }, (_, i) => i);
  for (let i = length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Start a new cycle. `avoidFirst` is the currently playing index: it stays in
 * the bag (so the new cycle still covers it) but is moved off the tail, which
 * is what keeps a cycle boundary from replaying the same track back-to-back.
 */
function refillShuffleBag(length: number, avoidFirst: number): void {
  const bag = shuffledIndices(length);
  if (length > 1 && bag[length - 1] === avoidFirst) {
    const swap = Math.floor(Math.random() * (length - 1));
    [bag[length - 1], bag[swap]] = [bag[swap], bag[length - 1]];
  }
  shuffleBag = bag;
  shuffleBagFor = length;
  shuffleBagDirty = true;
}

/**
 * Build the bag on demand. Unlike the cycle-boundary refill, the track playing
 * right now counts as this cycle's first play, so it comes straight back out.
 */
function ensureShuffleBag(length: number, current: number): void {
  if (shuffleBagFor === length) return;
  refillShuffleBag(length, current);
  consumeShuffleIndex(current);
}

/** Drop an index from the bag once it has been played (or jumped to). */
function consumeShuffleIndex(index: number): void {
  if (shuffleBagFor < 0) return;
  const at = shuffleBag.lastIndexOf(index);
  if (at >= 0) {
    shuffleBag.splice(at, 1);
    shuffleBagDirty = true;
  }
}

/** Tail entry that is still a legal successor, or -1. Does not mutate. */
function peekShuffleIndex(length: number, current: number): number {
  for (let i = shuffleBag.length - 1; i >= 0; i--) {
    const candidate = shuffleBag[i];
    if (candidate !== current && candidate >= 0 && candidate < length) return candidate;
  }
  return -1;
}

/**
 * Next index of the cycle. Returns -1 only when the cycle is exhausted and
 * `canRecycle` is false (shuffle with repeat off = play the queue through
 * once, then stop).
 */
function drawShuffleIndex(length: number, current: number, canRecycle: boolean): number {
  ensureShuffleBag(length, current);
  let picked = -1;
  while (shuffleBag.length) {
    const candidate = shuffleBag.pop()!;
    shuffleBagDirty = true;
    if (candidate !== current && candidate >= 0 && candidate < length) {
      picked = candidate;
      break;
    }
  }
  if (picked >= 0) return picked;
  if (!canRecycle) return -1;
  refillShuffleBag(length, current);
  return shuffleBag.length ? shuffleBag.pop()! : -1;
}

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
      resetShuffleBag();
      setPlayerStore('played', []);
      queueDirty = true;
    } else if (!shufflePathInProgress) {
      shuffleForward = [];
    }
    // However this track was reached — drawn from the bag, replayed off the
    // forward stack, or jumped to from the queue panel — it is spent for this
    // cycle and must not come round again before the reshuffle.
    consumeShuffleIndex(finalIndex);
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
    // Usually a no-op this early — nothing is buffered ahead yet. It fires
    // immediately only when the new track arrived already fully buffered
    // (a preloaded handoff), which is exactly when it's free.
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
      // If the user previously prev'd, the forward stack holds the path they
      // came from — replay that in order before drawing from the bag.
      if (shuffleForward.length > 0) {
        nextIndex = shuffleForward.pop()!;
      } else {
        nextIndex = drawShuffleIndex(queue.length, queueIndex, repeat === 'all');
        if (nextIndex < 0) {
          // Every track in the queue has played this cycle and repeat is off.
          audioEl.pause();
          setPlayerStore({ isPlaying: false });
          return;
        }
      }
      // Only now that the move is certain: record where we came from so prev()
      // can rewind. A repeat-all shuffle session runs indefinitely — keep the
      // rewind history bounded.
      if (queueIndex >= 0) {
        shuffleBack.push(queueIndex);
        if (shuffleBack.length > 500) shuffleBack.splice(0, shuffleBack.length - 500);
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
    // Either direction starts a clean cycle: turning shuffle on shouldn't
    // inherit a stale bag, and turning it off makes the old one meaningless.
    resetShuffleBag();
    shuffleForward = [];
    // Both directions change which track comes next, so the element holding
    // the old successor is now buffering the wrong audio. Re-arm it — under
    // shuffle the bag makes the pick knowable, so the track playing when the
    // toggle is flipped keeps its gapless transition instead of being the one
    // song that has to re-fetch from byte 0.
    preloadNext();
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
    // Splice the new index somewhere into what's left of the cycle rather than
    // rebuilding the bag — a rebuild would forget everything already played
    // and let this session repeat tracks.
    if (shuffleBagFor >= 0) {
      const newIndex = playerStore.queue.length - 1;
      shuffleBag.splice(Math.floor(Math.random() * (shuffleBag.length + 1)), 0, newIndex);
      shuffleBagFor = playerStore.queue.length;
      shuffleBagDirty = true;
    }
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
      if (shuffleBagFor >= 0) {
        shuffleBag = shuffleBag.map(remap);
        shuffleBagDirty = true;
      }
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
    // Store first — ensureAudioGraph() reads it to decide whether the graph is
    // needed, and moving a band off zero is exactly what makes it needed.
    ensureAudioGraph();
    if (filters[index]) filters[index].gain.value = clamped;
  },

  applyEqualizerPreset(preset) {
    const values = equalizerPresets[preset] || equalizerPresets.Flat;
    playerStore.setEqualizerSettings(values, preset);
  },

  setEqualizerSettings(values, preset) {
    const normalized = values.slice(0, 5);
    while (normalized.length < 5) normalized.push(0);
    setPlayerStore({ equalizer: normalized, equalizerPreset: preset });
    ensureAudioGraph();
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

/**
 * Whether anything actually consumes the Web Audio graph right now: a band
 * pulled off zero, or a mounted visualizer reading the analyser.
 */
function audioGraphNeeded(): boolean {
  return visualizerRefs > 0 || playerStore.equalizer.some((v) => v !== 0);
}

/**
 * Build the graph only when something needs it.
 *
 * Routing an element through `createMediaElementSource` takes it off the
 * platform's offloaded decode path and makes playback depend on the Web Audio
 * render callback, which the main thread feeds. Any main-thread hitch — a
 * large image decode, a synchronous localStorage write — can then starve it
 * into an audible dropout. Phones have the least headroom to absorb that, and
 * with a flat EQ and no visualizer on screen the graph does nothing but add
 * the exposure. So the default path is a plain <audio> element straight to the
 * hardware, and the graph gets built the moment it earns its place.
 *
 * The routing is one-way: an element can never leave the graph once it has a
 * source node (Web Audio gives no way to detach one, and disconnecting would
 * mute the element). Flattening the EQ again therefore keeps the graph for the
 * rest of the session; the native path comes back on the next page load, since
 * EQ settings are not persisted.
 */
function ensureAudioGraph(): void {
  if (!audioGraphNeeded()) return;
  buildAudioGraph();
}

function buildAudioGraph(): void {
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

/**
 * Mount/unmount hooks for visualizers. Retaining builds the graph — callers
 * must be inside a user gesture (a click that opens the panel), because a
 * freshly created AudioContext starts suspended and an element wired into a
 * suspended context is silent until it resumes.
 */
export function retainVisualizer(): void {
  visualizerRefs++;
  ensureAudioGraph();
  if (audioContext && audioContext.state !== 'running') void audioContext.resume();
}

export function releaseVisualizer(): void {
  visualizerRefs = Math.max(0, visualizerRefs - 1);
  // Nothing to tear down: the source nodes stay for the element's lifetime.
  // The count only decides whether a *future* build is warranted.
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

    // Gapless preload. preloadNext() decides for itself whether the connection
    // can afford it, so this just gives it a chance to start as soon as the
    // current track's buffer runs far enough ahead — rather than at a fixed
    // point that might be too late on a slow link, or wastefully early.
    preloadNext();
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

/**
 * Seconds of the current track that must already be buffered ahead of the
 * playhead before it is worth spending bandwidth on the next one.
 */
const PRELOAD_BUFFER_AHEAD_S = 25;

/** How much contiguous audio is buffered ahead of the playhead, in seconds. */
function bufferedAhead(el: HTMLAudioElement): number {
  const at = el.currentTime;
  const ranges = el.buffered;
  for (let i = 0; i < ranges.length; i++) {
    // A small tolerance: the playhead sits fractionally behind the range start
    // right after a seek.
    if (at >= ranges.start(i) - 0.5 && at <= ranges.end(i)) return ranges.end(i) - at;
  }
  return 0;
}

/**
 * Whether fetching the next track right now is affordable.
 *
 * `nextAudioEl.preload = 'auto'` downloads a whole file. Firing that the
 * instant the current track starts meant two full-size downloads competing for
 * the same connection for the entire track — fine on a LAN, a direct cause of
 * mid-track underruns on cellular.
 *
 * So: never on a metered or 2G connection, and otherwise only once the current
 * track is far enough ahead of the playhead that the second download has
 * spare capacity to use. Near the end of a track that condition is satisfied
 * by the whole file being buffered, which is what keeps the gapless handoff
 * working. If a connection can only just sustain one stream, it never opens —
 * which is the correct answer, not a missing feature.
 */
function preloadAffordable(): boolean {
  const conn = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
  if (conn?.saveData) return false;
  if (conn?.effectiveType === '2g' || conn?.effectiveType === 'slow-2g') return false;

  const ahead = bufferedAhead(audioEl);
  const duration = audioEl.duration;
  // Buffered to the end — there is nothing left for the two to contend over.
  if (Number.isFinite(duration) && duration > 0 && audioEl.currentTime + ahead >= duration - 0.5) {
    return true;
  }
  return ahead >= PRELOAD_BUFFER_AHEAD_S;
}

function preloadNext(): void {
  const { queue, queueIndex, shuffle, repeat } = playerStore;
  if (queueIndex < 0 || !queue.length) return;
  if (!preloadAffordable()) return;

  let nextIndex: number;
  if (shuffle && queue.length > 1) {
    // A bag makes the shuffled successor knowable ahead of time, so shuffle
    // gets the same gapless preload as linear playback. The forward stack
    // still wins — next() replays its top before touching the bag.
    if (shuffleForward.length) {
      nextIndex = shuffleForward[shuffleForward.length - 1];
    } else {
      ensureShuffleBag(queue.length, queueIndex);
      nextIndex = peekShuffleIndex(queue.length, queueIndex);
      // Cycle's last track: the successor depends on a reshuffle that hasn't
      // happened yet (or playback stops), so there's nothing to preload.
      if (nextIndex < 0) return;
    }
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

/**
 * The only track fields anything reads back out of a restored session: what a
 * queue row, the player bar and the Now Playing panel display, plus the lyric
 * availability flags. The rest of a Track row — file_hash, file_path, codec,
 * bitrate, scan timestamps — was being persisted for nothing.
 */
const PERSISTED_FIELDS = [
  'id', 'title', 'artist', 'album', 'albumId', 'artistId',
  'artPath', 'duration', 'liked', 'hasSyncedLyrics', 'hasUnsyncedLyrics'
] as const;

/** Current on-disk format of the queue blob. */
const QUEUE_FORMAT = 2;

/** Strip a track to the persisted fields. */
function persistTrack(track: Track | null): Partial<Track> | null {
  if (!track) return null;
  const out: Record<string, unknown> = {};
  for (const field of PERSISTED_FIELDS) {
    const value = field === 'artPath' ? track.artPath ?? track.art_path ?? null : track[field];
    if (value !== undefined) out[field] = value;
  }
  return out as Partial<Track>;
}

/** Normalise a track read back from storage or the API. */
function hydrateTrack(track: Track | null): Track | null {
  if (!track) return null;
  return {
    ...track,
    artPath: track.artPath ?? track.art_path ?? null,
    art_path: track.art_path ?? track.artPath ?? null
  };
}

/**
 * Serialise the queue column-wise: one shared header of field names, then a
 * bare value tuple per track. Repeating eleven JSON keys on every row cost
 * more than the values themselves — measured over a real library, dropping to
 * tuples takes a queue from 774 to 172 bytes per track, so the 5000-track
 * ceiling of the tracks page goes from ~3.7 MB (against a ~5 MB localStorage
 * quota) to ~0.8 MB.
 *
 * The header is stored rather than assumed, so adding or reordering
 * PERSISTED_FIELDS later still reads old blobs correctly.
 */
function encodeQueue(queue: Track[]): string {
  return JSON.stringify({
    v: QUEUE_FORMAT,
    fields: PERSISTED_FIELDS,
    rows: queue.map((track) => {
      const slim = persistTrack(track) as Record<string, unknown>;
      return PERSISTED_FIELDS.map((field) => slim[field] ?? null);
    })
  });
}

function decodeQueue(raw: string | null): Track[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.v === QUEUE_FORMAT && Array.isArray(parsed.fields) && Array.isArray(parsed.rows)) {
      const fields = parsed.fields as string[];
      return (parsed.rows as unknown[][])
        .map((row) => {
          const track: Record<string, unknown> = {};
          fields.forEach((field, i) => { track[field] = row[i] ?? null; });
          return hydrateTrack(track as unknown as Track) as Track;
        })
        .filter((track) => typeof track.id === 'number');
    }
    // Format 1: a plain array of whole track objects.
    if (Array.isArray(parsed)) {
      return parsed.map((t) => hydrateTrack(t as Track) as Track).filter((t) => t && typeof t.id === 'number');
    }
  } catch {
    // Corrupt blob — a lost queue is recoverable, a crash on boot isn't.
  }
  return [];
}

/**
 * Writing the queue is the one expensive part of a save: serialising and
 * handing localStorage a megabyte is synchronous main-thread work, and
 * setTrack calls savePlaybackSession at the exact moment playback starts. Defer
 * it to idle time so it can't land inside that window; `flushQueueWrite`
 * forces it out synchronously when the page is going away.
 */
let queueWriteHandle = 0;

function writeQueueNow(): void {
  if (!queueDirty) return;
  try {
    localStorage.setItem(PLAYBACK_QUEUE_KEY, encodeQueue(playerStore.queue));
    queueDirty = false;
  } catch {
    // Quota or other errors — ignore, and leave the blob dirty to retry.
  }
}

function scheduleQueueWrite(): void {
  if (queueWriteHandle) return;
  const run = () => {
    queueWriteHandle = 0;
    writeQueueNow();
  };
  const idle = (window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;
  queueWriteHandle = idle ? idle(run, { timeout: 2000 }) : window.setTimeout(run, 0);
}

function flushQueueWrite(): void {
  if (queueWriteHandle) {
    const cancelIdle = (window as Window & {
      cancelIdleCallback?: (handle: number) => void;
    }).cancelIdleCallback;
    if (cancelIdle) cancelIdle(queueWriteHandle);
    clearTimeout(queueWriteHandle);
    queueWriteHandle = 0;
  }
  writeQueueNow();
}

export function savePlaybackSession(options?: { flush?: boolean }): void {
  if (restoringSession) return;
  // The queue lives under its own key and is re-serialized only when it
  // changed — the frequent saves (position checkpoints, volume, play/pause)
  // then only write the small state blob below. Even then the write waits for
  // idle time, unless the page is unloading and there is no later.
  if (queueDirty) {
    if (options?.flush) flushQueueWrite();
    else scheduleQueueWrite();
  }
  try {
    // Same treatment for the shuffle bag: it changes once per track, not on
    // every 10 s position checkpoint. Persisting it is what stops a page
    // reload from restarting the cycle and re-serving tracks already heard.
    if (shuffleBagDirty) {
      if (shuffleBagFor < 0) localStorage.removeItem(PLAYBACK_SHUFFLE_KEY);
      else localStorage.setItem(PLAYBACK_SHUFFLE_KEY, JSON.stringify({ for: shuffleBagFor, bag: shuffleBag }));
      shuffleBagDirty = false;
    }
    const blob: Omit<PersistedPlaybackSession, 'queue'> = {
      currentTrack: persistTrack(playerStore.currentTrack) as Track | null,
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
    parsed.queue = Array.isArray(parsed.queue)
      ? parsed.queue.map((t: Track) => hydrateTrack(t) as Track)
      : decodeQueue(localStorage.getItem(PLAYBACK_QUEUE_KEY));
    return parsed as PersistedPlaybackSession;
  } catch {
    return null;
  }
}

/**
 * Reload the shuffle cycle saved alongside the session. Anything malformed, or
 * built for a queue of a different length, is discarded — the bag rebuilds
 * lazily on the next draw.
 */
function restoreShuffleBag(queueLength: number): void {
  resetShuffleBag();
  try {
    const raw = localStorage.getItem(PLAYBACK_SHUFFLE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.for !== queueLength || !Array.isArray(parsed.bag)) return;
    const bag = parsed.bag.filter(
      (i: unknown) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < queueLength
    );
    if (bag.length !== parsed.bag.length) return;
    shuffleBag = bag;
    shuffleBagFor = queueLength;
    shuffleBagDirty = false;    // already matches storage
  } catch {
    resetShuffleBag();
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
  const track = hydrateTrack(blob.currentTrack)!;
  const target = Math.max(0, Number.isFinite(blob.currentTime) ? blob.currentTime : 0);
  const knownDuration = blob.duration || track.duration || 0;

  // Apply the whole session synchronously — persistence must keep working
  // even if the saved track never loads (404 after a re-sync, server down).
  // Only the seek waits for metadata.
  restoringSession = true;
  setPlayerStore({
    currentTrack: track,
    queue: blob.queue,
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
  restoreShuffleBag(playerStore.queue.length);
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
    const hydrated = hydrateTrack(fresh)!;
    setPlayerStore('currentTrack', hydrated);
    patchQueueTrack(trackId, hydrated);
  }).catch(() => {});
}

export function setupPlaybackSessionPersistence(): () => void {
  // The page is going away — no idle callback will ever run, so force the
  // queue out synchronously.
  const onPageHide = () => savePlaybackSession({ flush: true });
  const onBeforeUnload = () => savePlaybackSession({ flush: true });
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      savePlaybackSession({ flush: true });
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
