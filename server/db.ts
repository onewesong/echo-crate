import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Playlist, SourceRef, Track } from "./types.js";

const dataDir = process.env.DATA_DIR || join(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });

// Reuse the original database filename when upgrading an existing install.
// New EchoCrate installs get a neutral filename with no provider in it.
const echoCrateDb = join(dataDir, "echocrate.sqlite");
const legacyDb = join(dataDir, "bilimusic.sqlite");
export const db = new DatabaseSync(process.env.DB_FILE || (existsSync(legacyDb) && !existsSync(echoCrateDb) ? legacyDb : echoCrateDb));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    cover TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT 'bilibili',
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_url TEXT NOT NULL,
    item_count INTEGER NOT NULL DEFAULT 0,
    last_synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(provider, source_type, source_id)
  );
  CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY,
    source_key TEXT NOT NULL UNIQUE,
    bvid TEXT NOT NULL,
    cid INTEGER NOT NULL,
    page INTEGER NOT NULL DEFAULT 1,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    cover TEXT NOT NULL DEFAULT '',
    duration INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'available',
    favorite INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (playlist_id, track_id)
  );
  CREATE TABLE IF NOT EXISTS history (
    track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    position REAL NOT NULL DEFAULT 0,
    played_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS lyrics (
    track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    format TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_history_played_at ON history(played_at DESC);
  CREATE INDEX IF NOT EXISTS idx_tracks_created_at ON tracks(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_playlist_tracks_order ON playlist_tracks(playlist_id, sort_order);
`);

function hasColumn(table: string, column: string) {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((item) => item.name === column);
}

// Additive migrations keep existing Bilibili libraries usable after the
// project becomes provider-agnostic.
if (!hasColumn("playlists", "provider")) db.exec("ALTER TABLE playlists ADD COLUMN provider TEXT NOT NULL DEFAULT 'bilibili'");
if (!hasColumn("tracks", "provider")) db.exec("ALTER TABLE tracks ADD COLUMN provider TEXT NOT NULL DEFAULT 'bilibili'");
if (!hasColumn("tracks", "source_ref")) db.exec("ALTER TABLE tracks ADD COLUMN source_ref TEXT NOT NULL DEFAULT '{}'");
db.exec(`UPDATE tracks SET source_ref = json_object('provider', 'bilibili', 'resourceId', bvid, 'itemId', CAST(cid AS TEXT), 'metadata', json_object('page', page))
  WHERE (source_ref = '{}' OR source_ref IS NULL) AND bvid IS NOT NULL`);

const playlistSchema = String((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'playlists'").get() as { sql?: string } | undefined)?.sql || "");
if (playlistSchema.includes("UNIQUE(source_type, source_id)")) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE playlists_upgrade (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      cover TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT 'bilibili',
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_url TEXT NOT NULL,
      item_count INTEGER NOT NULL DEFAULT 0,
      last_synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider, source_type, source_id)
    );
    INSERT INTO playlists_upgrade SELECT id, title, cover, provider, source_type, source_id, source_url, item_count, last_synced_at FROM playlists;
    DROP TABLE playlists;
    ALTER TABLE playlists_upgrade RENAME TO playlists;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}
db.exec("CREATE INDEX IF NOT EXISTS idx_tracks_provider ON tracks(provider)");
db.exec("CREATE INDEX IF NOT EXISTS idx_playlists_provider ON playlists(provider)");
db.exec("PRAGMA optimize");

export function getSetting(key: string) {
  return (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

export function setSetting(key: string, value: string) {
  db.prepare(`INSERT INTO settings(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(key, value);
}

export function deleteSetting(key: string) {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

const trackSelect = `SELECT t.*, h.played_at AS last_played_at FROM tracks t
  LEFT JOIN history h ON h.track_id = t.id`;

function mapTrack(row: Record<string, unknown>): Track {
  let source: SourceRef;
  try { source = JSON.parse(String(row.source_ref || "{}")) as SourceRef; }
  catch { source = { provider: "bilibili", resourceId: String(row.bvid), itemId: String(row.cid), metadata: { page: Number(row.page) } }; }
  if (!source.provider) source = { provider: String(row.provider || "bilibili"), resourceId: String(row.bvid), itemId: String(row.cid), metadata: { page: Number(row.page) } };
  return {
    id: Number(row.id),
    title: String(row.title),
    artist: String(row.artist),
    cover: String(row.cover),
    duration: Number(row.duration),
    favorite: Boolean(row.favorite),
    status: row.status === "unavailable" ? "unavailable" : "available",
    source,
    createdAt: String(row.created_at),
    lastPlayedAt: row.last_played_at ? String(row.last_played_at) : null,
  };
}

export function listTracks() {
  return (db.prepare(`${trackSelect} ORDER BY COALESCE(h.played_at, t.created_at) DESC`).all() as Record<string, unknown>[]).map(mapTrack);
}

export function getTrack(id: number) {
  const row = db.prepare(`${trackSelect} WHERE t.id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? mapTrack(row) : undefined;
}

export function listPlaylists(): Playlist[] {
  return (db.prepare("SELECT * FROM playlists ORDER BY last_synced_at DESC").all() as Record<string, unknown>[]).map((row) => ({
    id: Number(row.id), title: String(row.title), cover: String(row.cover),
    provider: String(row.provider || "bilibili"),
    sourceType: row.source_type as Playlist["sourceType"], sourceId: String(row.source_id),
    sourceUrl: String(row.source_url), itemCount: Number(row.item_count), lastSyncedAt: String(row.last_synced_at),
  }));
}

export function playlistTracks(id: number) {
  return (db.prepare(`${trackSelect} JOIN playlist_tracks pt ON pt.track_id = t.id WHERE pt.playlist_id = ? ORDER BY pt.sort_order`).all(id) as Record<string, unknown>[]).map(mapTrack);
}
