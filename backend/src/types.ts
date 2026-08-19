export interface TrackRow {
  id: number;
  file_path: string;
  file_hash: string;
  file_size: number;
  file_mtime: number;
  title: string | null;
  artist: string | null;
  album_artist: string | null;
  album: string | null;
  year: number | null;
  track_number: number | null;
  disc_number: number | null;
  genre: string | null;
  duration: number | null;
  bitrate: number | null;
  sample_rate: number | null;
  codec: string | null;
  has_synced_lyrics: number;
  has_unsynced_lyrics: number;
  album_id: number | null;
  artist_id: number | null;
  art_path: string | null;
  date_added: number;
  last_scanned: number;
  play_count?: number;
  last_played?: number | null;
}

export interface AlbumRow {
  id: number;
  title: string;
  artist_id: number | null;
  artist: string | null;
  year: number | null;
  genre: string | null;
  art_path: string | null;
  track_count?: number;
}

export interface ArtistRow {
  id: number;
  name: string;
  album_count?: number;
  track_count?: number;
}

export interface TrackMeta {
  filePath: string;
  fileHash: string;
  fileSize: number;
  fileMtime: number;
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  year: number | null;
  trackNumber: number | null;
  discNumber: number | null;
  genre: string | null;
  duration: number | null;
  bitrate: number | null;
  sampleRate: number | null;
  codec: string | null;
  channels: number | null;
  trackTotal: number | null;
  discTotal: number | null;
  releaseDate: string | null;
  isrc: string | null;
  /** Official audio source webpage — a Spotify or YouTube Music URL here. */
  woas: string | null;
  artPath: string | null;
  syncedLrc: string | null;
  unsyncedText: string | null;
}

export type SyncPhase = 'scanning' | 'extracting' | 'persisting' | 'done' | 'error';

export interface SyncProgress {
  type: 'progress';
  phase: SyncPhase;
  current: number;
  total: number;
  currentFile?: string;
}

export interface SyncDone {
  type: 'done';
  added: number;
  updated: number;
  deleted: number;
  skipped: number;
  failed: number;
}

export interface SyncError {
  type: 'error';
  message: string;
}

export type SyncEvent = SyncProgress | SyncDone | SyncError;

export interface SyncResult {
  added: number;
  updated: number;
  deleted: number;
  skipped: number;
  failed: number;
}
