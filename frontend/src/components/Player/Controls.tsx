import { Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward } from 'lucide-solid';
import { usePlayerStore } from '../../store/playerStore';

export function Controls() {
  const player = usePlayerStore();

  return (
    <div class="player-controls">
      <button
        class={`ctl ${player.shuffle ? 'on' : ''}`}
        onClick={() => player.toggleShuffle()}
        aria-label="Toggle shuffle"
        title="Shuffle"
      >
        <Shuffle size={16} />
      </button>
      <button class="ctl" onClick={() => player.prev()} aria-label="Previous">
        <SkipBack size={18} />
      </button>
      <button
        class="ctl ctl-play"
        onClick={() => player.togglePlay()}
        aria-label={player.isPlaying ? 'Pause' : 'Play'}
        disabled={!player.currentTrack}
      >
        {player.isPlaying ? <Pause size={18} /> : <Play size={18} />}
      </button>
      <button class="ctl" onClick={() => player.next()} aria-label="Next">
        <SkipForward size={18} />
      </button>
      <button
        class={`ctl ${player.repeat !== 'none' ? 'on' : ''}`}
        onClick={() => player.cycleRepeat()}
        aria-label={`Repeat: ${player.repeat}`}
        title={`Repeat ${player.repeat}`}
      >
        {player.repeat === 'one' ? <Repeat1 size={16} /> : <Repeat size={16} />}
      </button>
    </div>
  );
}
