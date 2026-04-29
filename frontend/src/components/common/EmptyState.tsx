import type { JSX } from 'solid-js';

export function EmptyState(props: {
  title: string;
  description?: string;
  action?: JSX.Element;
}) {
  return (
    <div class="empty-state">
      <h3>{props.title}</h3>
      {props.description ? <p>{props.description}</p> : null}
      {props.action}
    </div>
  );
}
