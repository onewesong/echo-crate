import QRCode from "qrcode";
import { decrypt, encrypt } from "./crypto.js";
import { db, deleteSetting, getSetting, getTrack, setSetting } from "./db.js";
import type { BiliVideo, Playlist, SearchTrack, Track } from "./types.js";

export const BILIBILI_PROVIDER_ID = "bilibili";
export const BILIBILI_PROVIDER_NAME = "Bilibili";

const API = "https://api.bilibili.com";
const PASSPORT = "https://passport.bilibili.com";
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36";

type BiliResponse<T> = { code: number; message: string; data: T };

function cookies() {
  const saved = getSetting("bilibili.cookies");
  return saved ? decrypt(saved) : "";
}

async function biliJson<T>(url: string, includeCookies = true): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      referer: "https://www.bilibili.com/",
      origin: "https://www.bilibili.com",
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9",
      ...(includeCookies && cookies() ? { cookie: cookies() } : {}),
    },
  });
  if (!response.ok) throw new Error(`Bilibili 请求失败 (${response.status})`);
  const payload = await response.json() as BiliResponse<T>;
  if (payload.code !== 0) throw new Error(payload.message || `Bilibili 错误 ${payload.code}`);
  return payload.data;
}

export async function createQrLogin() {
  const data = await biliJson<{ url: string; qrcode_key: string }>(
    `${PASSPORT}/x/passport-login/web/qrcode/generate`, false,
  );
  return { key: data.qrcode_key, image: await QRCode.toDataURL(data.url, { width: 320, margin: 1 }) };
}

export async function pollQrLogin(key: string) {
  const response = await fetch(`${PASSPORT}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`, {
    headers: { "user-agent": USER_AGENT, referer: "https://www.bilibili.com/" },
    redirect: "manual",
  });
  const payload = await response.json() as BiliResponse<{ code: number; message: string; url?: string }>;
  if (payload.code !== 0) throw new Error(payload.message || "二维码状态查询失败");
  if (payload.data.code === 0 && payload.data.url) {
    const url = new URL(payload.data.url);
    const cookieNames = ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid"];
    const cookie = cookieNames
      .map((name) => url.searchParams.get(name) ? `${name}=${url.searchParams.get(name)}` : "")
      .filter(Boolean)
      .join("; ");
    if (!cookie) throw new Error("登录成功，但未收到有效会话信息");
    setSetting("bilibili.cookies", encrypt(cookie));
    const profile = await getProfile();
    return { status: "confirmed", profile };
  }
  const states: Record<number, string> = { 86038: "expired", 86090: "waiting", 86101: "scanned" };
  return { status: states[payload.data.code] || "waiting", message: payload.data.message };
}

export async function getProfile() {
  if (!cookies()) return null;
  try {
    const data = await biliJson<{ isLogin: boolean; uname: string; face: string; mid: number }>(`${API}/x/web-interface/nav`);
    return data.isLogin ? { name: data.uname, avatar: data.face, mid: data.mid } : null;
  } catch {
    return null;
  }
}

export function logout() {
  deleteSetting("bilibili.cookies");
}

function extractBvid(input: string) {
  return input.match(/BV[0-9A-Za-z]{10}/)?.[0];
}

function normalizeCover(url: string) {
  if (!url) return "";
  try {
    const parsed = new URL(url.startsWith("//") ? `https:${url}` : url);
    if (parsed.hostname.endsWith(".hdslb.com")) parsed.protocol = "https:";
    return parsed.toString();
  } catch {
    return url;
  }
}

async function fetchVideo(bvid: string): Promise<BiliVideo> {
  const video = await biliJson<BiliVideo>(`${API}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
  return { ...video, pic: normalizeCover(video.pic) };
}

type ImportResult = { playlist: Playlist; imported: number };
type LoadedSource = {
  title: string;
  cover: string;
  sourceType: "favorite" | "collection" | "video";
  sourceId: string;
  sourceUrl: string;
  videos: BiliVideo[];
};

function upsertPlaylist(input: Omit<Playlist, "id" | "lastSyncedAt">) {
  db.prepare(`INSERT INTO playlists(title, cover, provider, source_type, source_id, source_url, item_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, source_type, source_id) DO UPDATE SET
      title=excluded.title, cover=excluded.cover, source_url=excluded.source_url,
      provider=excluded.provider, item_count=excluded.item_count, last_synced_at=CURRENT_TIMESTAMP`).run(
        input.title, input.cover, input.provider, input.sourceType, input.sourceId, input.sourceUrl, input.itemCount,
      );
  return db.prepare("SELECT * FROM playlists WHERE provider = ? AND source_type = ? AND source_id = ?").get(input.provider, input.sourceType, input.sourceId) as Record<string, unknown>;
}

function saveVideos(playlistId: number, videos: BiliVideo[]) {
  db.prepare("DELETE FROM playlist_tracks WHERE playlist_id = ?").run(playlistId);
  let order = 0;
  for (const video of videos) {
    for (const page of video.pages) {
      const sourceKey = `${video.bvid}:${page.cid}`;
      const title = video.pages.length > 1 ? `${page.part} · ${video.title}` : video.title;
      const sourceRef = JSON.stringify({ provider: BILIBILI_PROVIDER_ID, resourceId: video.bvid, itemId: String(page.cid), metadata: { page: page.page } });
      db.prepare(`INSERT INTO tracks(source_key, provider, source_ref, bvid, cid, page, title, artist, cover, duration)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_key) DO UPDATE SET
          title=excluded.title, artist=excluded.artist, cover=excluded.cover,
          provider=excluded.provider, source_ref=excluded.source_ref, duration=excluded.duration,
          status='available', updated_at=CURRENT_TIMESTAMP`).run(
            sourceKey, BILIBILI_PROVIDER_ID, sourceRef, video.bvid, page.cid, page.page, title, video.owner.name, video.pic, page.duration || video.duration,
          );
      const track = db.prepare("SELECT id FROM tracks WHERE source_key = ?").get(sourceKey) as { id: number };
      db.prepare("INSERT INTO playlist_tracks(playlist_id, track_id, sort_order) VALUES (?, ?, ?)").run(playlistId, track.id, order++);
    }
  }
  db.prepare("UPDATE playlists SET item_count = ?, last_synced_at = CURRENT_TIMESTAMP WHERE id = ?").run(order, playlistId);
  return order;
}

function mapPlaylist(row: Record<string, unknown>): Playlist {
  return {
    id: Number(row.id), title: String(row.title), cover: String(row.cover),
    provider: String(row.provider || BILIBILI_PROVIDER_ID),
    sourceType: row.source_type as Playlist["sourceType"], sourceId: String(row.source_id),
    sourceUrl: String(row.source_url), itemCount: Number(row.item_count), lastSyncedAt: String(row.last_synced_at),
  };
}

async function loadSource(input: string): Promise<LoadedSource> {
  const value = input.trim();
  const initialUrl = new URL(value);
  if (initialUrl.hostname === "b23.tv") {
    const resolved = await fetch(value, { redirect: "follow", headers: { "user-agent": USER_AGENT } });
    if (!resolved.url.includes("bilibili.com")) throw new Error("短链接没有指向 Bilibili 内容");
    return loadSource(resolved.url);
  }
  const bvid = extractBvid(value);
  if (bvid) {
    const video = await fetchVideo(bvid);
    return { title: video.title, cover: video.pic, sourceType: "video", sourceId: bvid, sourceUrl: value, videos: [video] };
  }

  const url = initialUrl;
  const favoriteId = url.searchParams.get("fid") || url.searchParams.get("media_id") || value.match(/favlist\/(\d+)/)?.[1];
  if (favoriteId) {
    const videos: BiliVideo[] = [];
    let page = 1;
    let title = `Bilibili 收藏夹 ${favoriteId}`;
    let cover = "";
    while (page <= 50) {
      const data = await biliJson<{
        info: { title: string; cover: string; media_count: number };
        medias: Array<{ bvid: string }> | null;
        has_more: boolean;
      }>(`${API}/x/v3/fav/resource/list?media_id=${favoriteId}&pn=${page}&ps=20&platform=web`);
      title = data.info.title;
      cover = normalizeCover(data.info.cover);
      for (const media of data.medias || []) {
        try { videos.push(await fetchVideo(media.bvid)); } catch { /* deleted/private item */ }
      }
      if (!data.has_more) break;
      page += 1;
    }
    return { title, cover, sourceType: "favorite", sourceId: favoriteId, sourceUrl: value, videos };
  }

  const seasonId = url.searchParams.get("sid") || url.searchParams.get("season_id") || url.pathname.match(/\/lists\/(\d+)/)?.[1];
  const mid = url.pathname.match(/space\.bilibili\.com\/(\d+)/)?.[1] || url.searchParams.get("mid");
  if (seasonId && mid) {
    const videos: BiliVideo[] = [];
    let page = 1;
    let title = `Bilibili 合集 ${seasonId}`;
    while (page <= 50) {
      const data = await biliJson<{
        meta: { name: string; cover: string };
        archives: Array<{ bvid: string }>;
        page: { total: number; size: number };
      }>(`${API}/x/polymer/web-space/seasons_archives_list?mid=${mid}&season_id=${seasonId}&page_num=${page}&page_size=30`);
      title = data.meta.name;
      for (const archive of data.archives || []) videos.push(await fetchVideo(archive.bvid));
      if (videos.length >= data.page.total) {
        return { title, cover: normalizeCover(data.meta.cover), sourceType: "collection", sourceId: seasonId, sourceUrl: value, videos };
      }
      page += 1;
    }
  }
  throw new Error("暂不识别这个链接，请使用 BV 视频、收藏夹或空间合集链接");
}

function previewTracks(videos: BiliVideo[]) {
  return videos.flatMap((video) => video.pages.map((page) => ({
    provider: BILIBILI_PROVIDER_ID,
    title: video.pages.length > 1 ? `${page.part} · ${video.title}` : video.title,
    artist: video.owner.name,
    cover: video.pic,
    duration: page.duration || video.duration,
    source: { provider: BILIBILI_PROVIDER_ID, resourceId: video.bvid, itemId: String(page.cid), metadata: { page: page.page } },
  })));
}

export async function searchBilibili(query: string): Promise<SearchTrack[]> {
  const keyword = query.trim();
  if (keyword.length < 2) return [];
  const response = await fetch(`${API}/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}&page=1&page_size=20`, {
    headers: {
      "user-agent": USER_AGENT,
      referer: "https://search.bilibili.com/",
      origin: "https://search.bilibili.com",
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9",
      ...(cookies() ? { cookie: cookies() } : {}),
    },
  });
  if (!response.ok) throw new Error(`Bilibili 搜索请求失败 (${response.status})`);
  const payload = await response.json() as BiliResponse<{ result?: Array<{ bvid?: string }> }>;
  if (payload.code !== 0) throw new Error(payload.message || `Bilibili 搜索错误 ${payload.code}`);
  const data = payload.data;
  const videos = await Promise.all((data.result || []).slice(0, 20).map(async (item) => {
    if (!item.bvid) return null;
    try { return await fetchVideo(item.bvid); } catch { return null; }
  }));
  return previewTracks(videos.filter((video): video is BiliVideo => Boolean(video)));
}

/** Persist an explicitly saved remote Bilibili result and mark it as favorite. */
export function saveBilibiliSearchTrack(track: SearchTrack): Track {
  const bvid = track.source.resourceId;
  const cid = Number(track.source.itemId);
  const page = Number(track.source.metadata?.page || 1);
  if (!bvid || !Number.isInteger(cid)) throw new Error("搜索曲目的来源信息无效");
  const sourceKey = `${bvid}:${cid}`;
  db.prepare(`INSERT INTO tracks(source_key, provider, source_ref, bvid, cid, page, title, artist, cover, duration, favorite)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(source_key) DO UPDATE SET
      provider=excluded.provider, source_ref=excluded.source_ref, title=excluded.title,
      artist=excluded.artist, cover=excluded.cover, duration=excluded.duration, favorite=1,
      status='available', updated_at=CURRENT_TIMESTAMP`).run(
        sourceKey, BILIBILI_PROVIDER_ID, JSON.stringify(track.source), bvid, cid, page,
        track.title, track.artist, track.cover, track.duration,
      );
  const row = db.prepare("SELECT id FROM tracks WHERE source_key = ?").get(sourceKey) as { id: number };
  return getTrack(row.id)!;
}

/** Read metadata and split video parts without changing the local library. */
export async function previewSource(input: string) {
  const loaded = await loadSource(input);
  const tracks = previewTracks(loaded.videos);
  return {
    playlist: {
      title: loaded.title, cover: loaded.cover, provider: BILIBILI_PROVIDER_ID,
      sourceType: loaded.sourceType, sourceId: loaded.sourceId, sourceUrl: loaded.sourceUrl,
      itemCount: tracks.length,
    },
    tracks,
  };
}

export async function importSource(input: string): Promise<ImportResult> {
  const loaded = await loadSource(input);
  const row = upsertPlaylist({
    title: loaded.title, cover: loaded.cover, provider: BILIBILI_PROVIDER_ID,
    sourceType: loaded.sourceType, sourceId: loaded.sourceId, sourceUrl: loaded.sourceUrl,
    itemCount: loaded.videos.length,
  });
  const imported = saveVideos(Number(row.id), loaded.videos);
  return { playlist: mapPlaylist({ ...row, item_count: imported }), imported };
}

export async function syncPlaylist(id: number) {
  const row = db.prepare("SELECT source_url FROM playlists WHERE id = ?").get(id) as { source_url: string } | undefined;
  if (!row) throw new Error("歌单不存在");
  return importSource(row.source_url);
}

export async function resolveAudio(bvid: string, cid: number) {
  const data = await biliJson<{
    dash?: { audio?: Array<{ baseUrl?: string; base_url?: string; backupUrl?: string[]; bandwidth: number; mimeType?: string; mime_type?: string }> };
    durl?: Array<{ url: string }>;
  }>(`${API}/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&fnval=16&fourk=1`);
  const audio = [...(data.dash?.audio || [])].sort((a, b) => b.bandwidth - a.bandwidth)[0];
  if (audio) return { url: audio.baseUrl || audio.base_url || audio.backupUrl?.[0], mime: audio.mimeType || audio.mime_type || "audio/mp4" };
  if (data.durl?.[0]) return { url: data.durl[0].url, mime: "audio/mp4" };
  throw new Error("没有找到可播放音频");
}

export async function resolveLyrics(bvid: string, cid: number) {
  const data = await biliJson<{
    subtitle?: { subtitles?: Array<{ subtitle_url: string; lan_doc: string }> };
  }>(`${API}/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${cid}`);
  const subtitle = data.subtitle?.subtitles?.[0];
  if (!subtitle) return { format: "plain", language: "", lines: [] };
  const url = subtitle.subtitle_url.startsWith("//") ? `https:${subtitle.subtitle_url}` : subtitle.subtitle_url;
  const body = await fetch(url).then((res) => res.json()) as { body: Array<{ from: number; to: number; content: string }> };
  return { format: "bilibili", language: subtitle.lan_doc, lines: body.body || [] };
}

export function upstreamHeaders(range?: string) {
  return {
    "user-agent": USER_AGENT,
    referer: "https://www.bilibili.com/",
    ...(cookies() ? { cookie: cookies() } : {}),
    ...(range ? { range } : {}),
  };
}
