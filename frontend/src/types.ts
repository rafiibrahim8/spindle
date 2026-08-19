export interface Track {
  id: number;
  filePath?: string;
  title: string | null;
  artist: string | null;
  albumArtist?: string | null;
  album: string | null;
  year: number | null;
  trackNumber: number | null;
  discNumber?: number | null;
  genre: string | null;
  duration: number | null;
  bitrate: number | null;
  sampleRate?: number | null;
  codec: string | null;
  hasSyncedLyrics?: number;
  hasUnsyncedLyrics?: number;
  liked?: number;
  likedAt?: number | null;
  albumId: number | null;
  artistId: number | null;
  artPath: string | null;
  art_path?: string | null;
  dateAdded?: number;
  lastScanned?: number;
  playCount?: number;
  lastPlayed?: number | null;
}

export interface Album {
  id: number;
  title: string;
  artistId: number | null;
  artist: string | null;
  year: number | null;
  genre: string | null;
  artPath: string | null;
  trackCount?: number;
}

export interface Artist {
  id: number;
  name: string;
  albumCount?: number;
  trackCount?: number;
}

export interface Playlist {
  id: number;
  name: string;
  createdAt?: number;
  readOnly: number;
  smartKey?: string | null;
  trackCount?: number;
}

export interface Lyrics {
  trackId: number;
  syncedLrc: string | null;
  unsyncedText: string | null;
}

export interface UserSettings {
  accent: string;
  equalizerPreset: string;
  equalizer: number[];
  visualizer: boolean;
}

export interface SyncStatus {
  musicRoot: string | null;
  musicRootExists: boolean;
  trackCount: number;
  activeJobId: string | null;
}

export type SyncSseEvent =
  | { type: 'progress'; phase: 'scanning' | 'extracting' | 'persisting'; current: number; total: number; currentFile?: string }
  | { type: 'done'; added: number; updated: number; deleted: number; skipped: number; failed: number }
  | { type: 'error'; message: string };
