import { Album, Heart, Home, ListMusic, Mic2, Music2, Settings as SettingsIcon } from 'lucide-solid';
import { NavLink } from './NavLink';

/**
 * Bottom tab bar shown only on small screens (handled by `.mobile-nav` CSS).
 * Mirrors the seven entries in the desktop sidebar so navigation parity is kept.
 * Sync lives on the Settings page on mobile (see pages/Settings.tsx).
 */
export function MobileNav() {
  return (
    <nav class="mobile-nav" aria-label="Primary">
      <NavLink to="/"          icon={<Home         size={18} />}>Home</NavLink>
      <NavLink to="/tracks"    icon={<Music2       size={18} />}>Tracks</NavLink>
      <NavLink to="/albums"    icon={<Album        size={18} />}>Albums</NavLink>
      <NavLink to="/artists"   icon={<Mic2         size={18} />}>Artists</NavLink>
      <NavLink to="/liked"     icon={<Heart        size={18} />}>Liked</NavLink>
      <NavLink to="/playlists" icon={<ListMusic    size={18} />}>Lists</NavLink>
      <NavLink to="/settings"  icon={<SettingsIcon size={18} />}>Settings</NavLink>
    </nav>
  );
}
