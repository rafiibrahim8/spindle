import express from 'express';
import { getDb } from '../db/init.js';

const router = express.Router();

interface UserSettings {
  accent: string;
  equalizerPreset: string;
  equalizer: number[];
}

const defaults: UserSettings = {
  accent: '#1ed760',
  equalizerPreset: 'Flat',
  equalizer: [0, 0, 0, 0, 0]
};

router.get('/', (_req, res) => {
  res.json(readSettings());
});

router.put('/', (req, res) => {
  const payload = req.body as Partial<UserSettings>;
  const next: UserSettings = { ...readSettings() };

  if (typeof payload.accent === 'string' && /^#[0-9a-f]{6}$/i.test(payload.accent)) {
    next.accent = payload.accent;
  }
  if (typeof payload.equalizerPreset === 'string' && payload.equalizerPreset.trim()) {
    next.equalizerPreset = payload.equalizerPreset.trim();
  }
  if (Array.isArray(payload.equalizer) && payload.equalizer.length === 5) {
    next.equalizer = payload.equalizer.map((value) => clamp(Number(value), -12, 12));
  }

  const db = getDb();
  const write = db.transaction(() => {
    const stmt = db.prepare(`
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
  });
  write();

  res.json(next);
});

function readSettings(): UserSettings {
  const db = getDb();
  const rows = db
    .prepare('SELECT key, value FROM user_settings')
    .all() as Array<{ key: string; value: string | null }>;
  const map = new Map(rows.map((r) => [r.key, r.value]));

  return {
    accent: validateAccent(map.get('accent')),
    equalizerPreset: map.get('equalizerPreset') || defaults.equalizerPreset,
    equalizer: parseEqualizer(map.get('equalizer'))
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

export default router;
