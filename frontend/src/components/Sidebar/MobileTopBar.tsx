/**
 * Compact branded header shown only on mobile (the desktop sidebar holds the
 * wordmark there). Sits flush at the top of the main content area; CSS hides
 * it above 720 px.
 */
function SpindleMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9.5" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function MobileTopBar() {
  return (
    <header class="mobile-top-bar" aria-label="Spindle">
      <div class="mobile-top-bar-mark"><SpindleMark /></div>
      <span class="mobile-top-bar-name">Spindle</span>
    </header>
  );
}
