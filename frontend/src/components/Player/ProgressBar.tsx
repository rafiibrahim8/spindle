import { createSignal } from 'solid-js';
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
  // While scrubbing, preview the dragged position locally and only commit the
  // seek on release — calling seek() on every input tick resets the decoder
  // (range request per tick) and writes localStorage synchronously.
  const [scrubTime, setScrubTime] = createSignal<number | null>(null);
  const displayTime = () => scrubTime() ?? player.currentTime;

  return (
    <div class="progress-bar">
      <span class="time time-current">{formatTime(displayTime())}</span>
      <Slider
        min={0}
        max={Math.max(1, player.duration || 0)}
        step={0.1}
        value={Math.min(displayTime(), player.duration || 0)}
        ariaLabel="Seek"
        onInput={(value) => setScrubTime(value)}
        onChange={(value) => {
          player.seek(value);
          setScrubTime(null);
        }}
      />
      <span class="time time-total">{formatTime(player.duration)}</span>
    </div>
  );
}
