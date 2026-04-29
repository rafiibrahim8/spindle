interface PlayingIndicatorProps {
  active?: boolean;
  label?: string;
}

export function PlayingIndicator(props: PlayingIndicatorProps) {
  const active = () => props.active ?? true;
  return (
    <span
      class={`playing-indicator ${active() ? 'active' : ''}`}
      aria-label={props.label || 'Now playing'}
      role="img"
    >
      <span /><span /><span /><span />
    </span>
  );
}
