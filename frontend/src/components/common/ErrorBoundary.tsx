import { ErrorBoundary as SolidErrorBoundary, type JSX } from 'solid-js';

export function ErrorBoundary(props: { children: JSX.Element }) {
  return (
    <SolidErrorBoundary
      fallback={(err, reset) => (
        <div class="app-error">
          <h2>Something broke</h2>
          <pre>{(err as Error).message || String(err)}</pre>
          <button onClick={reset}>Reload</button>
        </div>
      )}
    >
      {props.children}
    </SolidErrorBoundary>
  );
}
