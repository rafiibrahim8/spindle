interface AlbumArtProps {
  artPath: string | null | undefined;
  title: string | null | undefined;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

export function AlbumArt(props: AlbumArtProps) {
  const size = () => props.size || 'md';
  const initial = () => (props.title || '?').trim().charAt(0).toUpperCase();
  return (
    <div class={`album-art album-art-${size()}`}>
      {props.artPath ? (
        <img src={props.artPath} alt={props.title || ''} loading="lazy" />
      ) : (
        <span class="album-art-placeholder" aria-hidden="true">{initial()}</span>
      )}
    </div>
  );
}
