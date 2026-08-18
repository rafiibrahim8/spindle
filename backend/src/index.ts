import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb } from './db/init.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from './middleware/logger.js';
import albumsRouter from './routes/albums.js';
import { createArtRouter } from './routes/art.js';
import artistsRouter from './routes/artists.js';
import playlistsRouter from './routes/playlists.js';
import settingsRouter from './routes/settings.js';
import statsRouter from './routes/stats.js';
import streamRouter from './routes/stream.js';
import syncRouter from './routes/sync.js';
import tracksRouter from './routes/tracks.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = process.env.DATA_ROOT || path.join(__dirname, '../data');
const ART_CACHE_DIR = path.join(DATA_ROOT, 'art');
fs.mkdirSync(ART_CACHE_DIR, { recursive: true });

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5174' }));
app.use(express.json({ limit: '1mb' }));
app.use(logger);

// Downscaled `?w=` renditions first; everything else falls through to the
// full-size original. Art filenames are content hashes, so both are immutable.
app.use('/art', createArtRouter(ART_CACHE_DIR));
app.use('/art', express.static(ART_CACHE_DIR, { maxAge: '30d', immutable: true }));

app.use('/api/tracks', tracksRouter);
app.use('/api/albums', albumsRouter);
app.use('/api/artists', artistsRouter);
app.use('/api/playlists', playlistsRouter);
app.use('/api/sync', syncRouter);
app.use('/api/stream', streamRouter);
app.use('/api/stats', statsRouter);
app.use('/api/settings', settingsRouter);

// Production: serve the built SPA from the same Express process. Set
// SPINDLE_FRONTEND_STATIC_DIR=/path/to/frontend/dist in production. In dev,
// leave it unset — Vite serves the SPA on a separate port and proxies /api.
const STATIC_DIR = process.env.SPINDLE_FRONTEND_STATIC_DIR;
if (STATIC_DIR && fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR, {
    maxAge: '7d',         // hashed Vite assets are safe to cache long
    etag: true,
    index: false          // we send index.html ourselves via the SPA fallback
  }));
  // SPA fallback — any non-asset, non-API path returns index.html so the
  // SolidJS Router can handle it. Must come AFTER /api/* and /art. Unknown
  // API/art paths get a JSON 404 — serving index.html there would mask
  // typos and break clients expecting JSON.
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/art/')) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.sendFile(path.join(STATIC_DIR, 'index.html'));
  });
}

app.use(errorHandler);

initDb();

app.listen(PORT, () => {
  console.log(`🎵 Spindle running on http://localhost:${PORT}`);
});
