import { useQueryClient } from '@tanstack/solid-query';
import { api } from '../api/client';
import type { Track } from '../types';

/**
 * Toggle like state for a track. Optimistically patches every cached query
 * that holds tracks, then invalidates so the next refetch is canonical.
 */
export function useLikeToggle() {
  const queryClient = useQueryClient();

  return async (track: Track): Promise<void> => {
    const next = !Boolean(track.liked);

    // Optimistic patch — walk every cache and update by id.
    patchTrackInCache(queryClient, track.id, {
      liked: next ? 1 : 0,
      likedAt: next ? Date.now() : null
    });

    try {
      await api.setTrackLiked(track.id, next);
    } catch (err) {
      // Revert on failure.
      patchTrackInCache(queryClient, track.id, {
        liked: track.liked ?? 0,
        likedAt: track.likedAt ?? null
      });
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
