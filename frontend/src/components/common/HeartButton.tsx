import { Heart } from 'lucide-solid';
import { useLikeToggle } from '../../hooks/useLike';
import type { Track } from '../../types';

interface HeartButtonProps {
  track: Track | null | undefined;
  size?: number;
  /** Always show, regardless of hover state on the parent. Use for the player bar / home cards. */
  alwaysVisible?: boolean;
  class?: string;
}

export function HeartButton(props: HeartButtonProps) {
  const toggle = useLikeToggle();
  const liked = () => Boolean(props.track?.liked);

  const onClick = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    if (props.track) void toggle(props.track);
  };

  return (
    <button
      type="button"
      class={`like-btn ${liked() ? 'is-liked' : ''} ${props.alwaysVisible ? 'always' : ''} ${props.class ?? ''}`}
      onClick={onClick}
      aria-label={liked() ? 'Unlike' : 'Like'}
      aria-pressed={liked()}
      title={liked() ? 'Remove from Liked' : 'Add to Liked'}
      disabled={!props.track}
    >
      <Heart size={props.size ?? 16} fill={liked() ? 'currentColor' : 'none'} />
    </button>
  );
}
