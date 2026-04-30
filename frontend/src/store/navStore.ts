import { createSignal } from 'solid-js';

/**
 * Cross-page navigation channel for nav-resets and "open this artist/album"
 * intents. Avoids URL search params (the user prefers clean paths) but still
 * lets any component say "go to artist 42" from anywhere in the tree.
 */

const [navClick, setNavClick] = createSignal<{ path: string; nonce: number }>({
  path: '',
  nonce: 0
});

export function getNavClick() {
  return navClick();
}

export function fireNavClick(path: string): void {
  setNavClick((prev) => ({ path, nonce: prev.nonce + 1 }));
}

// Pending artist/album to open. Set by callers, consumed by the page on mount
// or via a createEffect; cleared after consumption.
const [pendingArtistId, setPendingArtistId] = createSignal<number | null>(null);
const [pendingAlbumId, setPendingAlbumId] = createSignal<number | null>(null);

export function getPendingArtistId() {
  return pendingArtistId();
}
export function clearPendingArtistId(): void {
  setPendingArtistId(null);
}
export function getPendingAlbumId() {
  return pendingAlbumId();
}
export function clearPendingAlbumId(): void {
  setPendingAlbumId(null);
}

/**
 * Mark an artist as the next thing the Artists page should open, then route
 * there. Consumers should pass `useNavigate()` from `@solidjs/router`.
 */
export function openArtist(id: number | null | undefined, navigate: (path: string) => void): void {
  if (id == null) return;
  setPendingArtistId(id);
  navigate('/artists');
}

export function openAlbum(id: number | null | undefined, navigate: (path: string) => void): void {
  if (id == null) return;
  setPendingAlbumId(id);
  navigate('/albums');
}
