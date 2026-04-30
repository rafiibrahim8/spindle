import { useQueryClient } from '@tanstack/solid-query';
import { api } from '../api/client';
import { usePlayerStore } from '../store/playerStore';
import type { Track } from '../types';

/**
 * Toggle like state for a track. Optimistically patches every cached query
 * that holds tracks, then invalidates so the next refetch is canonical.
 * Also patches the playerStore's currentTrack so the player bar / Now Playing
 * panel update in real time (the store's track is a separate copy from the
 * cached query data).
 */
export function useLikeToggle() {
  const queryClient = useQueryClient();
  const player = usePlayerStore();

  return async (track: Track): Promise<void> => {
    const next = !Boolean(track.liked);
    const patch: Partial<Track> = {
      liked: next ? 1 : 0,
      likedAt: next ? Date.now() : null
    };

    // Optimistic patch — every cached query AND the live player store.
    patchTrackInCache(queryClient, track.id, patch);
    player.patchCurrentTrack(track.id, patch);

    try {
      await api.setTrackLiked(track.id, next);
    } catch (err) {
      // Revert on failure.
      const revert: Partial<Track> = {
        liked: track.liked ?? 0,
        likedAt: track.likedAt ?? null
      };
      patchTrackInCache(queryClient, track.id, revert);
      player.patchCurrentTrack(track.id, revert);
      console.error('[like] failed:', err);
      return;
    }

    // The /liked listing is order-sensitive (sort by liked_at desc) so we need
    // a real refetch there. Other lists already have the correct row in cache.
    queryClient.invalidateQueries({
      predicate: (q) => {
        const head = q.queryKey[0];
        return head === 'liked-tracks';
      }
    });
  };
}

function patchTrackInCache(
  qc: ReturnType<typeof useQueryClient>,
  id: number,
  patch: Partial<Track>
): void {
  qc.setQueriesData<any>({ predicate: () => true }, (old: any) => {
    if (!old) return old;
    if (Array.isArray(old.tracks)) {
      return {
        ...old,
        tracks: old.tracks.map((t: Track) => (t.id === id ? { ...t, ...patch } : t))
      };
    }
    if (typeof old === 'object' && 'id' in old && old.id === id && 'title' in old) {
      return { ...old, ...patch };
    }
    return old;
  });
}
