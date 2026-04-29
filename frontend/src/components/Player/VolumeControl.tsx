import { Volume1, Volume2, VolumeX } from 'lucide-solid';
import { usePlayerStore } from '../../store/playerStore';
import { Slider } from '../common/Slider';

export function VolumeControl() {
  const player = usePlayerStore();
  const Icon = () => {
    if (player.isMuted || player.volume === 0) return <VolumeX size={16} />;
    if (player.volume < 0.5) return <Volume1 size={16} />;
    return <Volume2 size={16} />;
  };
  return (
    <div class="volume-control">
      <button class="ctl" onClick={() => player.toggleMute()} aria-label="Toggle mute">
        <Icon />
      </button>
      <Slider
        min={0}
        max={1}
        step={0.01}
        value={player.isMuted ? 0 : player.volume}
        ariaLabel="Volume"
        tooltip={(v) => `${Math.round(v * 100)}%`}
        onInput={(value) => player.setVolume(value)}
      />
    </div>
  );
}
