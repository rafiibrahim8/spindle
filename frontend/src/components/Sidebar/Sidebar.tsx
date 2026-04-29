import { Album, Heart, Home, Mic2, Music2, Settings as SettingsIcon } from 'lucide-solid';
import { SyncButton } from '../Sync/SyncButton';
import { NavLink } from './NavLink';

function SpindleMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
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

export function Sidebar() {
  return (
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true"><SpindleMark /></div>
        <span>Spindle</span>
      </div>
      <nav>
        <NavLink to="/"         icon={<Home         size={18} />}>Home</NavLink>
        <NavLink to="/tracks"   icon={<Music2       size={18} />}>Tracks</NavLink>
        <NavLink to="/albums"   icon={<Album        size={18} />}>Albums</NavLink>
        <NavLink to="/artists"  icon={<Mic2         size={18} />}>Artists</NavLink>
        <NavLink to="/liked"    icon={<Heart        size={18} />}>Liked</NavLink>
        <NavLink to="/settings" icon={<SettingsIcon size={18} />}>Settings</NavLink>
      </nav>
      <SyncButton />
    </aside>
  );
}
