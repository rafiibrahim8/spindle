import { onCleanup, onMount } from 'solid-js';
import { audioEl, usePlayerStore } from '../store/playerStore';

export function useKeyboardShortcuts(): void {
  const player = usePlayerStore();

  onMount(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      )) return;

      // Ctrl+F → focus search
      if (event.key.toLowerCase() === 'f' && (event.ctrlKey || event.metaKey)) {
        const search = document.querySelector<HTMLInputElement>('[data-search-input]');
        if (search) {
          event.preventDefault();
          search.focus();
          search.select();
        }
        return;
      }

      switch (event.key) {
        case ' ':
        case 'Spacebar':
          event.preventDefault();
          player.togglePlay();
          return;
        case 'ArrowLeft':
          event.preventDefault();
          audioEl.currentTime = Math.max(0, audioEl.currentTime - 5);
          return;
        case 'ArrowRight':
          event.preventDefault();
          audioEl.currentTime = Math.min(player.duration || audioEl.duration, audioEl.currentTime + 5);
          return;
        case 'ArrowUp':
          event.preventDefault();
          player.setVolume(Math.min(1, player.volume + 0.05));
          return;
        case 'ArrowDown':
          event.preventDefault();
          player.setVolume(Math.max(0, player.volume - 0.05));
          return;
      }

      switch (event.key.toLowerCase()) {
        case 'n': player.next(); break;
        case 'p': player.prev(); break;
        case 's': player.toggleShuffle(); break;
        case 'r': player.cycleRepeat(); break;
        case 'm': player.toggleMute(); break;
        case 'l': player.toggleLyrics(); break;
      }
    };

    window.addEventListener('keydown', handler);
    onCleanup(() => window.removeEventListener('keydown', handler));
  });
}
