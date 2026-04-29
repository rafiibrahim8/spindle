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
import artistsRouter from './routes/artists.js';
import playlistsRouter from './routes/playlists.js';
import settingsRouter from './routes/settings.js';
import statsRouter from './routes/stats.js';
import streamRouter from './routes/stream.js';
import syncRouter from './routes/sync.js';
import tracksRouter from './routes/tracks.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ART_CACHE_DIR =
  process.env.ART_CACHE_DIR || path.join(__dirname, '../data/art');
fs.mkdirSync(ART_CACHE_DIR, { recursive: true });

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5174' }));
app.use(express.json({ limit: '1mb' }));
app.use(logger);

app.use('/art', express.static(ART_CACHE_DIR));

app.use('/api/tracks', tracksRouter);
app.use('/api/albums', albumsRouter);
app.use('/api/artists', artistsRouter);
app.use('/api/playlists', playlistsRouter);
app.use('/api/sync', syncRouter);
app.use('/api/stream', streamRouter);
app.use('/api/stats', statsRouter);
app.use('/api/settings', settingsRouter);

app.use(errorHandler);

initDb();

app.listen(PORT, () => {
  console.log(`🎵 Music Player API running on http://localhost:${PORT}`);
});
