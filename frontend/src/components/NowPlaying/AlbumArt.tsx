type Size = 'sm' | 'md' | 'lg' | 'xl';

interface AlbumArtProps {
  artPath: string | null | undefined;
  title: string | null | undefined;
  size?: Size;
}

/**
 * Cached art is stored at 500x500. Asking the backend for a `?w=` rendition
 * lets a 40 px list thumbnail decode a 64 px image instead of a 500 px one —
 * roughly a 60x cut in bitmap memory per row, and far less main-thread decode
 * work while scrolling. Only these widths are rendered server-side; anything
 * else falls back to the original.
 */
const variant = (artPath: string, width: number) => `${artPath}?w=${width}`;

/**
 * Fixed-size boxes use `x` descriptors — the CSS size is known, so the browser
 * needs no `sizes` hint and picks purely on device pixel ratio. Fluid boxes use
 * `w` descriptors with a `sizes` estimate of their rendered width.
 */
const SPECS: Record<Size, {
  box: number | null;
  src: (p: string) => string;
  srcset: (p: string) => string;
  sizes?: string;
}> = {
  // 40 px rows: track list, queue list, player bar.
  sm: {
    box: 40,
    src: (p) => variant(p, 64),
    srcset: (p) => `${variant(p, 64)} 1x, ${variant(p, 128)} 2x, ${variant(p, 256)} 3x`
  },
  // 80 px.
  md: {
    box: 80,
    src: (p) => variant(p, 128),
    srcset: (p) => `${variant(p, 128)} 1x, ${variant(p, 256)} 2x, ${p} 3x`
  },
  // Grid cards — ~180 px wide at every breakpoint (desktop minmax, 2-up mobile).
  lg: {
    box: null,
    src: (p) => variant(p, 256),
    srcset: (p) => `${variant(p, 128)} 128w, ${variant(p, 256)} 256w, ${p} 500w`,
    sizes: '(max-width: 640px) 45vw, 200px'
  },
  // Now Playing hero — up to 240 px desktop, 74vw mobile. Nothing beats the
  // original here on a high-DPR phone, so it stays in the candidate list.
  xl: {
    box: null,
    src: (p) => p,
    srcset: (p) => `${variant(p, 256)} 256w, ${p} 500w`,
    sizes: '(max-width: 640px) 74vw, 240px'
  }
};

export function AlbumArt(props: AlbumArtProps) {
  const size = () => props.size || 'md';
  const spec = () => SPECS[size()];
  const initial = () => (props.title || '?').trim().charAt(0).toUpperCase();
  return (
    <div class={`album-art album-art-${size()}`}>
      {props.artPath ? (
        <img
          src={spec().src(props.artPath)}
          srcset={spec().srcset(props.artPath)}
          sizes={spec().sizes}
          // Intrinsic size reserves the box before the bytes land. Fluid sizes
          // declare the source's own 1:1 dimensions; CSS overrides the width.
          width={spec().box ?? 500}
          height={spec().box ?? 500}
          alt={props.title || ''}
          loading="lazy"
          // Keep decoding off the main thread — it competes with the audio
          // pipeline on phones.
          decoding="async"
        />
      ) : (
        <span class="album-art-placeholder" aria-hidden="true">{initial()}</span>
      )}
    </div>
  );
}
