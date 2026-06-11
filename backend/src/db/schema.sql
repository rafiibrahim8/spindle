-- ================================================================
-- ARTISTS
-- ================================================================
CREATE TABLE IF NOT EXISTS artists (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT    NOT NULL UNIQUE
);

-- ================================================================
-- ALBUMS
-- ================================================================
CREATE TABLE IF NOT EXISTS albums (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    artist_id   INTEGER REFERENCES artists(id) ON DELETE SET NULL,
    year        INTEGER,
    genre       TEXT,
    art_path    TEXT,
    UNIQUE(title, artist_id)
);

-- ================================================================
-- TRACKS
-- ================================================================
CREATE TABLE IF NOT EXISTS tracks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path     TEXT    NOT NULL UNIQUE,
    file_hash     TEXT    NOT NULL,
    file_size     INTEGER NOT NULL,
    file_mtime    INTEGER NOT NULL,

    title         TEXT,
    artist        TEXT,
    album_artist  TEXT,
    album         TEXT,
    year          INTEGER,
    track_number  INTEGER,
    disc_number   INTEGER,
    genre         TEXT,
    duration      REAL,
    bitrate       INTEGER,
    sample_rate   INTEGER,
    codec         TEXT,

    has_synced_lyrics   INTEGER DEFAULT 0,
    has_unsynced_lyrics INTEGER DEFAULT 0,

    liked         INTEGER NOT NULL DEFAULT 0,
    liked_at      INTEGER,

    album_id      INTEGER REFERENCES albums(id) ON DELETE SET NULL,
    artist_id     INTEGER REFERENCES artists(id) ON DELETE SET NULL,

    date_added    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    last_scanned  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

-- ================================================================
-- LYRICS
-- ================================================================
CREATE TABLE IF NOT EXISTS lyrics (
    track_id      INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    synced_lrc    TEXT,
    unsynced_text TEXT
);

-- ================================================================
-- PLAY HISTORY
-- ================================================================
CREATE TABLE IF NOT EXISTS play_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    played_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    completed  INTEGER DEFAULT 0
);

-- ================================================================
-- PLAY STATS (denormalized)
-- ================================================================
CREATE TABLE IF NOT EXISTS play_stats (
    track_id    INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    play_count  INTEGER NOT NULL DEFAULT 0,
    last_played INTEGER
);

-- ================================================================
-- PLAYLISTS
-- ================================================================
CREATE TABLE IF NOT EXISTS playlists (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    read_only   INTEGER NOT NULL DEFAULT 0,
    smart_key   TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id    INTEGER NOT NULL REFERENCES tracks(id)    ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, track_id)
);

-- ================================================================
-- INTERNAL SETTINGS (system-level: music_root, last_sync_at, etc.)
-- ================================================================
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- ================================================================
-- USER SETTINGS (UI: accent, equalizer)
-- ================================================================
CREATE TABLE IF NOT EXISTS user_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

-- ================================================================
-- INDEXES
-- ================================================================
CREATE INDEX IF NOT EXISTS idx_tracks_album_id  ON tracks(album_id);
CREATE INDEX IF NOT EXISTS idx_tracks_artist_id ON tracks(artist_id);
CREATE INDEX IF NOT EXISTS idx_tracks_title     ON tracks(title);
CREATE INDEX IF NOT EXISTS idx_play_history_track ON play_history(track_id);
CREATE INDEX IF NOT EXISTS idx_play_stats_count   ON play_stats(play_count DESC);
CREATE INDEX IF NOT EXISTS idx_tracks_liked       ON tracks(liked) WHERE liked = 1;
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_track ON playlist_tracks(track_id);
CREATE INDEX IF NOT EXISTS idx_tracks_date_added  ON tracks(date_added);
CREATE INDEX IF NOT EXISTS idx_tracks_genre       ON tracks(genre);
