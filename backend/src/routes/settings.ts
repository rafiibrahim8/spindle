import { getDb } from '../db/init.ts';
import { json } from '../http/respond.ts';
import { readJson } from '../http/wrap.ts';

interface UserSettings {
  accent: string;
  equalizerPreset: string;
  equalizer: number[];
  /**
   * Whether the Now Playing panel draws its waveform. Off by default, and the
   * default matters: the analyser it reads only exists if audio is routed
   * through the Web Audio graph, which permanently takes both audio elements
   * off the platform's offloaded decode path for the rest of the session. A
   * decorative bar chart is not worth that trade unless it is asked for.
   */
  visualizer: boolean;
}

const defaults: UserSettings = {
  accent: '#1ed760',
  equalizerPreset: 'Flat',
  equalizer: [0, 0, 0, 0, 0],
  visualizer: false
};

export function getSettings(): Response {
  return json(readSettings());
}

export async function updateSettings(req: Request): Promise<Response> {
  const payload = (await readJson(req)) as Partial<UserSettings> | undefined;
  const next: UserSettings = { ...readSettings() };

  if (typeof payload?.accent === 'string' && /^#[0-9a-f]{6}$/i.test(payload.accent)) {
    next.accent = payload.accent;
  }
  if (typeof payload?.equalizerPreset === 'string' && payload.equalizerPreset.trim()) {
    next.equalizerPreset = payload.equalizerPreset.trim();
  }
  if (Array.isArray(payload?.equalizer) && payload.equalizer.length === 5) {
    next.equalizer = payload.equalizer.map((value) => clamp(Number(value), -12, 12));
  }
  if (typeof payload?.visualizer === 'boolean') {
    next.visualizer = payload.visualizer;
  }

  const db = getDb();
  db.transaction(() => {
    const stmt = db.query(`
      INSERT INTO user_settings(key, value, updated_at)
      VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
    const now = Date.now();
    stmt.run('accent', next.accent, now);
    stmt.run('equalizerPreset', next.equalizerPreset, now);
    stmt.run('equalizer', JSON.stringify(next.equalizer), now);
    stmt.run('visualizer', next.visualizer ? '1' : '0', now);
  })();

  return json(next);
}

function readSettings(): UserSettings {
  const rows = getDb().query('SELECT key, value FROM user_settings')
    .all() as Array<{ key: string; value: string | null }>;
  const map = new Map(rows.map((r) => [r.key, r.value]));

  return {
    accent: validateAccent(map.get('accent')),
    equalizerPreset: map.get('equalizerPreset') || defaults.equalizerPreset,
    equalizer: parseEqualizer(map.get('equalizer')),
    // Absent key means never configured, which must read as off.
    visualizer: map.get('visualizer') === '1'
  };
}

function validateAccent(value: string | null | undefined): string {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value : defaults.accent;
}

function parseEqualizer(value: string | null | undefined): number[] {
  if (!value) return defaults.equalizer;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 5) return defaults.equalizer;
    return parsed.map((item) => clamp(Number(item), -12, 12));
  } catch {
    return defaults.equalizer;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : 0;
}
