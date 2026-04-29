export function Spinner(props: { size?: number; label?: string }) {
  const size = props.size ?? 22;
  return (
    <span class="spinner" role="status" aria-label={props.label || 'Loading'}
          style={{ width: `${size}px`, height: `${size}px` }}>
      <span class="spinner-ring" />
    </span>
  );
}
