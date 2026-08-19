import { useQuery } from '@tanstack/solid-query';
import { ExternalLink, X } from 'lucide-solid';
import { For, Show, createMemo, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import { api } from '../../api/client';
import type { Track } from '../../types';

interface TrackInfoProps {
  trackId: number;
  onClose: () => void;
}

/**
 * Providers we surface as a real link. Anything else is shown as plain text
 * only — an unrecognised host is not something to invite a click on.
 */
const PROVIDERS: Array<{ label: string; hosts: string[] }> = [
  { label: 'Listen on Spotify',       hosts: ['open.spotify.com', 'spotify.com'] },
  { label: 'Listen on YouTube Music', hosts: ['music.youtube.com', 'youtube.com', 'www.youtube.com'] }
];

/**
 * WOAS comes out of a file's tags, which is untrusted input heading for an
 * `href`. Only http(s) is allowed through — a `javascript:` URL in a tag would
 * otherwise be a live script-injection vector.
 */
function linkFor(woas: string | null | undefined): { label: string; href: string } | null {
  if (!woas) return null;
  let url: URL;
  try {
    url = new URL(woas);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  const provider = PROVIDERS.find((p) => p.hosts.includes(host));
  return provider ? { label: provider.label, href: url.href } : null;
}

function formatDuration(seconds: number | null | undefined): string | null {
  if (!seconds || !Number.isFinite(seconds)) return null;
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatBytes(bytes: number | null | undefined): string | null {
  if (!bytes || !Number.isFinite(bytes)) return null;
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function formatChannels(n: number | null | undefined): string | null {
  if (!n) return null;
  if (n === 1) return 'Mono';
  if (n === 2) return 'Stereo';
  return `${n} channels`;
}

function formatDate(track: Track): string | null {
  // Prefer the full date when the file carried one; fall back to the integer
  // year that has always been stored.
  if (track.releaseDate) {
    const d = new Date(track.releaseDate);
    if (!Number.isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(track.releaseDate)) {
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    }
    return track.releaseDate;
  }
  return track.year ? String(track.year) : null;
}

/** "3 of 12", or just "3" when the total is unknown. */
function ordinalOf(n: number | null | undefined, total: number | null | undefined): string | null {
  if (!n) return null;
  return total && total > 0 ? `${n} of ${total}` : String(n);
}

export function TrackInfo(props: TrackInfoProps) {
  // Fetched rather than read from the player store: the persisted queue keeps
  // only the handful of fields the UI renders, so a track restored from a
  // previous session has no codec/bitrate/woas on it. Fetching also picks up
  // current play counts.
  const track = useQuery(() => ({
    queryKey: ['track', props.trackId],
    queryFn: () => api.getTrack(props.trackId)
  }));

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') props.onClose();
  };
  onMount(() => document.addEventListener('keydown', onKey));
  onCleanup(() => document.removeEventListener('keydown', onKey));

  const link = createMemo(() => linkFor(track.data?.woas));

  const groups = createMemo(() => {
    const t = track.data;
    if (!t) return [];
    const albumArtist = t.albumArtist && t.albumArtist !== t.artist ? t.albumArtist : null;
    return [
      {
        title: 'Track',
        rows: [
          ['Title', t.title],
          ['Artist', t.artist],
          ['Album artist', albumArtist],
          ['Album', t.album],
          ['Track', ordinalOf(t.trackNumber, t.trackTotal)],
          // A lone "Disc 1" tells you nothing; only show it for real sets.
          ['Disc', t.discTotal && t.discTotal > 1 ? ordinalOf(t.discNumber, t.discTotal) : null],
          ['Released', formatDate(t)],
          ['Genre', t.genre]
        ]
      },
      {
        title: 'Audio',
        rows: [
          ['Codec', t.codec ? t.codec.toUpperCase() : null],
          ['Bitrate', t.bitrate ? `${t.bitrate} kbps` : null],
          ['Sample rate', t.sampleRate ? `${(t.sampleRate / 1000).toFixed(1)} kHz` : null],
          ['Channels', formatChannels(t.channels)],
          ['Duration', formatDuration(t.duration)]
        ]
      },
      {
        title: 'File',
        rows: [['Size', formatBytes(t.fileSize)]]
      },
      {
        title: 'Source',
        rows: [
          ['WOAS', t.woas],
          ['ISRC', t.isrc]
        ]
      },
      {
        title: 'Stats',
        rows: [
          ['Plays', t.playCount ? String(t.playCount) : null],
          ['Last played', t.lastPlayed ? new Date(t.lastPlayed).toLocaleString() : null]
        ]
      }
    ]
      // Empty rows are hidden rather than shown as placeholders — genre in
      // particular is absent from most libraries and would be pure noise.
      .map((g) => ({ ...g, rows: g.rows.filter(([, v]) => v != null && v !== '') as Array<[string, string]> }))
      .filter((g) => g.rows.length);
  });

  return (
    <Portal>
      <div class="track-info-backdrop" onClick={props.onClose} />
      <div class="track-info-sheet" role="dialog" aria-modal="true" aria-label="Track details">
        <header>
          <h3>Track details</h3>
          <button class="ctl" onClick={props.onClose} aria-label="Close details">
            <X size={16} />
          </button>
        </header>

        <Show when={track.data} fallback={<p class="muted track-info-empty">Loading…</p>}>
          <div class="track-info-body">
            <Show when={link()}>
              {(l) => (
                <a
                  class="track-info-link"
                  href={l().href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink size={14} /> {l().label}
                </a>
              )}
            </Show>

            <For each={groups()}>{(group) => (
              <section class="track-info-group">
                <h4>{group.title}</h4>
                <dl>
                  <For each={group.rows}>{([label, value]) => (
                    <div class="track-info-row">
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  )}</For>
                </dl>
              </section>
            )}</For>
          </div>
        </Show>
      </div>
    </Portal>
  );
}
