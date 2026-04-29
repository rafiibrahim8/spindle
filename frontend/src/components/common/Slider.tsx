import { Show, createSignal, type JSX } from 'solid-js';

interface SliderProps {
  min?: number;
  max?: number;
  step?: number;
  value: number;
  onInput?: (value: number) => void;
  onChange?: (value: number) => void;
  ariaLabel?: string;
  class?: string;
  style?: JSX.CSSProperties;
  /** When set, a tooltip near the thumb shows on hover. Receives the current value. */
  tooltip?: (value: number) => string;
}

export function Slider(props: SliderProps) {
  const min = () => props.min ?? 0;
  const max = () => props.max ?? 100;
  const step = () => props.step ?? 1;
  const [hovered, setHovered] = createSignal(false);

  const pct = () => {
    const v = props.value;
    const range = max() - min();
    if (!range) return 0;
    return Math.max(0, Math.min(100, ((v - min()) / range) * 100));
  };

  return (
    <div
      class={`slider ${props.class || ''} ${hovered() ? 'hover' : ''}`}
      style={props.style}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div class="slider-track">
        <div class="slider-fill" style={{ width: `${pct()}%` }} />
        <div class="slider-thumb" style={{ left: `${pct()}%` }} />
      </div>
      <Show when={props.tooltip}>
        <span class="slider-tooltip" style={{ left: `${pct()}%` }}>
          {props.tooltip!(props.value)}
        </span>
      </Show>
      <input
        type="range"
        min={min()}
        max={max()}
        step={step()}
        value={props.value}
        aria-label={props.ariaLabel}
        aria-valuenow={props.value}
        onInput={(e) => props.onInput?.(parseFloat(e.currentTarget.value))}
        onChange={(e) => props.onChange?.(parseFloat(e.currentTarget.value))}
      />
    </div>
  );
}
