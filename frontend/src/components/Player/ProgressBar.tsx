import { usePlayerStore } from '../../store/playerStore';
import { Slider } from '../common/Slider';

function formatTime(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

export function ProgressBar() {
  const player = usePlayerStore();

  return (
    <div class="progress-bar">
      <span class="time time-current">{formatTime(player.currentTime)}</span>
      <Slider
        min={0}
        max={Math.max(1, player.duration || 0)}
        step={0.1}
        value={Math.min(player.currentTime, player.duration || 0)}
        ariaLabel="Seek"
        onInput={(value) => player.seek(value)}
      />
      <span class="time time-total">{formatTime(player.duration)}</span>
    </div>
  );
}
