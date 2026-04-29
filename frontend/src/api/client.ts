import type { Album, Artist, Lyrics, Playlist, SyncStatus, Track, UserSettings } from '../types';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) || '/api';
const STREAM_BASE = (import.meta.env.VITE_STREAM_BASE as string | undefined) || '';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  const json = await res.json();
  return normalizeApiShape(json) as T;
}

function normalizeApiShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeApiShape);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const camel = toCamel(key);
    result[camel] = normalizeApiShape(raw);
    // Keep snake_case fallback for legacy art_path consumers in persisted blobs.
    if (key === 'art_path') result[key] = raw;
  }
  return result;
}

function toCamel(key: string): string {
  return key.replace(/_([a-z0-9])/gi, (_, c: string) => c.toUpperCase());
}

export const api = {
  // Tracks
  getTracks(params: Record<string, string | number | undefined> = {}): Promise<{ tracks: Track[]; total: number }> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '' && v !== null) qs.set(k, String(v));
    }
    const suffix = qs.toString() ? `?${qs}` : '';
    return request(`/tracks${suffix}`);
  },
  getTrack(id: number): Promise<Track> {
    return request(`/tracks/${id}`);
  },
  getLyrics(id: number): Promise<Lyrics> {
    return request(`/tracks/${id}/lyrics`);
  },
  revealTrack(id: number): Promise<{ ok: boolean }> {
    return request(`/tracks/${id}/reveal`, { method: 'POST' });
  },
  setTrackLiked(id: number, liked: boolean): Promise<{ id: number; liked: boolean }> {
    return request(`/tracks/${id}/like`, { method: 'PUT', body: JSON.stringify({ liked }) });
  },

  // Albums
  getAlbums(params: { artistId?: number } = {}): Promise<{ albums: Album[] }> {
    const qs = params.artistId ? `?artist_id=${params.artistId}` : '';
    return request(`/albums${qs}`);
  },
  getAlbum(id: number): Promise<Album> {
    return request(`/albums/${id}`);
  },
  getAlbumTracks(id: number): Promise<{ tracks: Track[] }> {
    return request(`/albums/${id}/tracks`);
  },

  // Artists
  getArtists(): Promise<{ artists: Artist[] }> {
    return request('/artists');
  },
  getArtist(id: number): Promise<Artist> {
    return request(`/artists/${id}`);
  },
  getArtistAlbums(id: number): Promise<{ albums: Album[] }> {
    return request(`/artists/${id}/albums`);
  },

  // Playlists
  getPlaylists(): Promise<{ playlists: Playlist[] }> {
    return request('/playlists');
  },
  createPlaylist(name: string): Promise<{ id: number; name: string }> {
    return request('/playlists', { method: 'POST', body: JSON.stringify({ name }) });
  },
  addTrackToPlaylist(id: number, trackId: number): Promise<{ ok: boolean }> {
    return request(`/playlists/${id}/tracks`, {
      method: 'POST',
      body: JSON.stringify({ trackId })
    });
  },

  // Stats
  getMostPlayed(limit = 25): Promise<{ tracks: Track[] }> {
    return request(`/stats/most-played?limit=${limit}`);
  },
  getRecentlyPlayed(limit = 25): Promise<{ tracks: Track[] }> {
    return request(`/stats/recently-played?limit=${limit}`);
  },
  getRecentlyAdded(limit = 25): Promise<{ tracks: Track[] }> {
    return request(`/stats/recently-added?limit=${limit}`);
  },
  recordPlay(trackId: number, completed: boolean): Promise<{ ok: boolean }> {
    return request('/stats/play', {
      method: 'POST',
      body: JSON.stringify({ trackId, completed })
    });
  },

  // Sync
  startSync(musicRoot: string): Promise<{ jobId: string }> {
    return request('/sync/start', { method: 'POST', body: JSON.stringify({ musicRoot }) });
  },
  getSyncStatus(): Promise<SyncStatus> {
    return request('/sync/status');
  },

  // Settings
  getSettings(): Promise<UserSettings> {
    return request('/settings');
  },
  updateSettings(payload: Partial<UserSettings>): Promise<UserSettings> {
    return request('/settings', { method: 'PUT', body: JSON.stringify(payload) });
  },

  // Streaming / art
  streamUrl(id: number): string {
    return `${STREAM_BASE || BASE}/stream/${id}`;
  },
  artUrl(artPath: string | null | undefined): string | null {
    if (!artPath) return null;
    if (artPath.startsWith('http')) return artPath;
    return artPath; // /art/<hash>.webp is served directly
  }
};
