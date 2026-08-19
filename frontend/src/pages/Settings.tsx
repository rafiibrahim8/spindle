import { useMutation, useQuery, useQueryClient } from '@tanstack/solid-query';
import { Check } from 'lucide-solid';
import { For } from 'solid-js';
import { api } from '../api/client';
import { Equalizer } from '../components/NowPlaying/Equalizer';
import { SyncButton } from '../components/Sync/SyncButton';
import { equalizerPresets, usePlayerStore } from '../store/playerStore';
import type { UserSettings } from '../types';

const accents = [
  { name: 'Green',  value: '#1ed760' },
  { name: 'Blue',   value: '#38bdf8' },
  { name: 'Purple', value: '#a78bfa' },
  { name: 'Orange', value: '#fb923c' },
  { name: 'Red',    value: '#f43f5e' }
];

export function Settings() {
  const queryClient = useQueryClient();
  const settings = useQuery(() => ({ queryKey: ['settings'], queryFn: api.getSettings }));
  const player = usePlayerStore();

  const mutation = useMutation(() => ({
    mutationFn: (payload: Partial<UserSettings>) => api.updateSettings(payload),
    onSuccess: (saved) => {
      queryClient.setQueryData(['settings'], saved);
      applyAccent(saved.accent);
      player.setEqualizerSettings(saved.equalizer, saved.equalizerPreset);
      player.setVisualizerEnabled(saved.visualizer);
    }
  }));

  const selectedAccent = () =>
    settings.data?.accent || localStorage.getItem('accent') || accents[0].value;

  const saveAccent = (accent: string) => {
    applyAccent(accent);
    mutation.mutate({
      accent,
      equalizer: player.equalizer,
      equalizerPreset: player.equalizerPreset
    });
  };

  const saveEqualizer = () => {
    mutation.mutate({
      accent: selectedAccent(),
      equalizer: player.equalizer,
      equalizerPreset: player.equalizerPreset
    });
  };

  // The PUT merges over stored settings, so omitted fields keep their value —
  // only the toggle itself needs sending.
  const saveVisualizer = (enabled: boolean) => {
    player.setVisualizerEnabled(enabled);
    mutation.mutate({ visualizer: enabled });
  };

  const savePreset = (preset: string) => {
    const values = equalizerPresets[preset] || equalizerPresets.Flat;
    player.setEqualizerSettings(values, preset);
    mutation.mutate({
      accent: selectedAccent(),
      equalizer: values,
      equalizerPreset: preset
    });
  };

  return (
    <div class="page settings-page">
      <div class="settings-hero">
        <p>Preferences</p>
        <h1>Settings</h1>
        <span>Saved to SQLite and restored when the app starts.</span>
      </div>
      <div class="settings-grid">
        <section class="settings-card">
          <h2>Color Theme</h2>
          <div class="theme-options">
            <For each={accents}>{(a) => (
              <button class="theme-option" onClick={() => saveAccent(a.value)}>
                <span class="theme-swatch" style={{ background: a.value }}>
                  {selectedAccent() === a.value ? <Check size={18} /> : null}
                </span>
                <strong>{a.name}</strong>
              </button>
            )}</For>
          </div>
        </section>

        <section class="settings-card equalizer-card">
          <div class="settings-card-header">
            <h2>Equalizer</h2>
            <button onClick={saveEqualizer} disabled={mutation.isPending}>Save EQ</button>
          </div>
          <div class="preset-row">
            <For each={Object.keys(equalizerPresets)}>{(preset) => (
              <button
                class={player.equalizerPreset === preset ? 'active' : ''}
                onClick={() => savePreset(preset)}
              >
                {preset}
              </button>
            )}</For>
          </div>
          <Equalizer compact />
        </section>

        <section class="settings-card">
          <h2>Visualizer</h2>
          <p class="muted">
            Draws a waveform in the Now Playing panel. Off by default: reading the
            audio for it routes playback through the browser's Web Audio graph,
            which gives up the low-power decode path for the rest of the session
            and can make playback more prone to stutter on phones.
          </p>
          <div class="preset-row">
            <button
              class={!player.visualizerEnabled ? 'active' : ''}
              onClick={() => saveVisualizer(false)}
              disabled={mutation.isPending}
            >
              Off
            </button>
            <button
              class={player.visualizerEnabled ? 'active' : ''}
              onClick={() => saveVisualizer(true)}
              disabled={mutation.isPending}
            >
              On
            </button>
          </div>
        </section>

        <section class="settings-card settings-sync-card">
          <h2>Library</h2>
          <p class="muted">Re-scan your music root to pick up new, modified, or removed files.</p>
          <SyncButton />
        </section>
      </div>
    </div>
  );
}

function applyAccent(accent: string): void {
  document.documentElement.style.setProperty('--accent', accent);
  try { localStorage.setItem('accent', accent); } catch {}
}
