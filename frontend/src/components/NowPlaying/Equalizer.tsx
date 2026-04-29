import { For } from 'solid-js';
import { usePlayerStore } from '../../store/playerStore';
import { Slider } from '../common/Slider';

const FREQ_LABELS = ['60Hz', '250Hz', '1kHz', '4kHz', '16kHz'];

export function Equalizer(props: { compact?: boolean }) {
  const player = usePlayerStore();
  return (
    <div class={`equalizer ${props.compact ? 'compact' : ''}`}>
      <For each={player.equalizer}>{(value, index) => (
        <div class="equalizer-band">
          <span class="equalizer-band-value">{value > 0 ? '+' : ''}{value} dB</span>
          <Slider
            class="vertical"
            min={-12}
            max={12}
            step={0.5}
            value={value}
            ariaLabel={`Equalizer ${FREQ_LABELS[index()]}`}
            onInput={(v) => player.setEqualizerBand(index(), v)}
          />
          <span class="equalizer-band-label">{FREQ_LABELS[index()]}</span>
        </div>
      )}</For>
    </div>
  );
}
