import { createSignal } from 'solid-js';

/**
 * Bumped whenever a sidebar `NavLink` is clicked, even if the URL is unchanged.
 * Pages subscribe to this so "click Artists while already on Artists" resets
 * the local detail-view state without putting selection state into the URL.
 *
 * `path` carries the destination so a page only resets when its own link fires.
 * `nonce` increments on every click so consumers see a fresh signal even when
 * the user clicks the same link twice in a row.
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
