import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { db, getTrack, listPlaylists, listTracks, playlistTracks } from "./db.js";
import { getProvider, listProviders, providerForInput } from "./providers.js";
import { getSearchTrack, storeSearchTrack } from "./search-results.js";

const app = Fastify({ logger: true, trustProxy: true });

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  const failure = error as { statusCode?: number; message?: string };
  reply.code(failure.statusCode || 500).send({ error: failure.message || "服务器开小差了" });
});

app.get("/api/health", async () => ({ ok: true, time: new Date().toISOString() }));
app.get("/api/providers", async () => ({ providers: await listProviders() }));
app.get<{ Params: { provider: string } }>("/api/providers/:provider/profile", async (request) => ({ profile: await getProvider(request.params.provider).profile() }));
app.post<{ Params: { provider: string } }>("/api/providers/:provider/login/qr", async (request) => {
  const login = getProvider(request.params.provider).login;
  if (!login) throw Object.assign(new Error("该来源不支持登录"), { statusCode: 422 });
  return login.createQr();
});
app.get<{ Params: { provider: string }; Querystring: { key?: string } }>("/api/providers/:provider/login/status", async (request, reply) => {
  if (!request.query.key) return reply.code(400).send({ error: "缺少二维码会话" });
  const login = getProvider(request.params.provider).login;
  if (!login) return reply.code(422).send({ error: "该来源不支持登录" });
  return login.pollQr(request.query.key);
});
app.post<{ Params: { provider: string } }>("/api/providers/:provider/logout", async (request, reply) => {
  const login = getProvider(request.params.provider).login;
  if (!login) return reply.code(422).send({ error: "该来源不支持登录" });
  login.logout();
  return { ok: true };
});

app.get("/api/library", async () => ({ tracks: listTracks(), playlists: listPlaylists() }));
app.get<{ Querystring: { q?: string; providers?: string } }>("/api/search", async (request, reply) => {
  const query = request.query.q?.trim() || "";
  if (query.length < 2) return reply.code(400).send({ error: "搜索关键词至少需要 2 个字符" });
  const profiles = await listProviders();
  const requested = request.query.providers?.split(",").map((item) => item.trim()).filter(Boolean)
    || profiles.filter((item) => item.capabilities.includes("search")).map((item) => item.id);
  const searches = await Promise.allSettled(requested.map(async (id) => {
    const provider = getProvider(id);
    if (!provider.search) throw Object.assign(new Error("该来源暂不支持搜索"), { statusCode: 422 });
    return { id, tracks: await provider.search(query) };
  }));
  const tracks = [] as ReturnType<typeof storeSearchTrack>[];
  const errors: Array<{ provider: string; error: string }> = [];
  for (let index = 0; index < searches.length; index += 1) {
    const result = searches[index];
    const provider = requested[index];
    if (result.status === "fulfilled") tracks.push(...result.value.tracks.map(storeSearchTrack));
    else errors.push({ provider, error: result.reason instanceof Error ? result.reason.message : "搜索失败" });
  }
  return { query, tracks, errors };
});
app.get<{ Params: { id: string } }>("/api/playlists/:id/tracks", async (request) => ({ tracks: playlistTracks(Number(request.params.id)) }));
app.post<{ Body: { url?: string; provider?: string } }>("/api/imports", async (request, reply) => {
  if (!request.body?.url) return reply.code(400).send({ error: "请提供音乐来源链接" });
  return providerForInput(request.body.url, request.body.provider).importSource(request.body.url);
});
app.post<{ Params: { id: string } }>("/api/playlists/:id/sync", async (request, reply) => {
  const row = db.prepare("SELECT provider FROM playlists WHERE id = ?").get(Number(request.params.id)) as { provider?: string } | undefined;
  if (!row) return reply.code(404).send({ error: "歌单不存在" });
  return getProvider(row.provider || "bilibili").syncPlaylist(Number(request.params.id));
});

app.post<{ Params: { id: string } }>("/api/tracks/:id/favorite", async (request, reply) => {
  const id = Number(request.params.id);
  const track = getTrack(id);
  if (!track) return reply.code(404).send({ error: "曲目不存在" });
  db.prepare("UPDATE tracks SET favorite = ? WHERE id = ?").run(track.favorite ? 0 : 1, id);
  return { favorite: !track.favorite };
});

app.post<{ Body: { trackId?: number; position?: number } }>("/api/history", async (request, reply) => {
  if (!request.body?.trackId) return reply.code(400).send({ error: "缺少曲目" });
  db.prepare(`INSERT INTO history(track_id, position, played_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(track_id) DO UPDATE SET position=excluded.position, played_at=CURRENT_TIMESTAMP`).run(
      request.body.trackId, Math.max(0, request.body.position || 0),
    );
  return { ok: true };
});

app.get<{ Params: { id: string } }>("/api/tracks/:id/audio", async (request, reply) => {
  const track = getTrack(Number(request.params.id));
  if (!track) return reply.code(404).send({ error: "曲目不存在" });
  const provider = getProvider(track.source.provider);
  const source = await provider.resolveAudio(track.source);
  if (!source.url) return reply.code(502).send({ error: "音频地址不可用" });
  const upstream = await fetch(source.url, { headers: provider.upstreamHeaders?.(request.headers.range) });
  if (!upstream.ok || !upstream.body) return reply.code(upstream.status || 502).send({ error: "音频来源暂时不可用" });
  reply.code(upstream.status);
  for (const name of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) reply.header(name, value);
  }
  reply.header("content-type", upstream.headers.get("content-type") || source.mime);
  reply.header("cache-control", "private, no-store");
  return reply.send(Readable.fromWeb(upstream.body as never));
});

app.get<{ Params: { token: string } }>("/api/search/results/:token/audio", async (request, reply) => {
  const track = getSearchTrack(request.params.token);
  const provider = getProvider(track.provider);
  const source = await provider.resolveAudio(track.source);
  if (!source.url) return reply.code(502).send({ error: "音频地址不可用" });
  const upstream = await fetch(source.url, { headers: provider.upstreamHeaders?.(request.headers.range) });
  if (!upstream.ok || !upstream.body) return reply.code(upstream.status || 502).send({ error: "音频来源暂时不可用" });
  reply.code(upstream.status);
  for (const name of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) reply.header(name, value);
  }
  reply.header("content-type", upstream.headers.get("content-type") || source.mime);
  reply.header("cache-control", "private, no-store");
  return reply.send(Readable.fromWeb(upstream.body as never));
});

app.get<{ Params: { id: string } }>("/api/tracks/:id/lyrics", async (request, reply) => {
  const id = Number(request.params.id);
  const saved = db.prepare("SELECT format, content FROM lyrics WHERE track_id = ?").get(id) as { format: string; content: string } | undefined;
  if (saved) return { format: saved.format, content: saved.content };
  const track = getTrack(id);
  if (!track) return reply.code(404).send({ error: "曲目不存在" });
  return getProvider(track.source.provider).resolveLyrics(track.source);
});

app.get<{ Params: { token: string } }>("/api/search/results/:token/lyrics", async (request) => {
  const track = getSearchTrack(request.params.token);
  return getProvider(track.provider).resolveLyrics(track.source);
});

app.post<{ Params: { token: string } }>("/api/search/results/:token/save", async (request, reply) => {
  const track = getSearchTrack(request.params.token);
  const provider = getProvider(track.provider);
  if (!provider.saveSearchTrack) return reply.code(422).send({ error: "该来源暂不支持保存搜索结果" });
  return { track: provider.saveSearchTrack(track) };
});

app.post<{ Params: { id: string }; Body: { content?: string } }>("/api/tracks/:id/lyrics", async (request, reply) => {
  const id = Number(request.params.id);
  if (!getTrack(id)) return reply.code(404).send({ error: "曲目不存在" });
  if (!request.body?.content) return reply.code(400).send({ error: "歌词内容为空" });
  db.prepare(`INSERT INTO lyrics(track_id, format, content) VALUES (?, 'lrc', ?)
    ON CONFLICT(track_id) DO UPDATE SET format='lrc', content=excluded.content, updated_at=CURRENT_TIMESTAMP`).run(id, request.body.content);
  return { ok: true };
});

// Resolve relative to this installed module, not the caller's working directory.
const staticRoot = join(fileURLToPath(new URL("..", import.meta.url)), "dist");
if (existsSync(staticRoot)) {
  await app.register(fastifyStatic, { root: staticRoot, wildcard: false });
  app.get("/*", async (_request, reply) => reply.sendFile("index.html"));
}

const port = Number(process.env.PORT || 8787);
await app.listen({ port, host: process.env.HOST || "0.0.0.0" });
