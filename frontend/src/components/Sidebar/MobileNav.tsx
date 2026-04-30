import { Album, Heart, Home, Mic2, Music2, Settings as SettingsIcon } from 'lucide-solid';
import { NavLink } from './NavLink';

/**
 * Bottom tab bar shown only on small screens (handled by `.mobile-nav` CSS).
 * Mirrors the six entries in the desktop sidebar so navigation parity is kept.
 * Sync lives on the Settings page on mobile (see pages/Settings.tsx).
 */
export function MobileNav() {
  return (
    <nav class="mobile-nav" aria-label="Primary">
      <NavLink to="/"         icon={<Home         size={20} />}>Home</NavLink>
      <NavLink to="/tracks"   icon={<Music2       size={20} />}>Tracks</NavLink>
      <NavLink to="/albums"   icon={<Album        size={20} />}>Albums</NavLink>
      <NavLink to="/artists"  icon={<Mic2         size={20} />}>Artists</NavLink>
      <NavLink to="/liked"    icon={<Heart        size={20} />}>Liked</NavLink>
      <NavLink to="/settings" icon={<SettingsIcon size={20} />}>Settings</NavLink>
    </nav>
  );
}
