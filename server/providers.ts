import {
  BILIBILI_PROVIDER_ID,
  BILIBILI_PROVIDER_NAME,
  createQrLogin,
  getProfile,
  importSource as importBilibiliSource,
  previewSource as previewBilibiliSource,
  logout,
  pollQrLogin,
  resolveAudio,
  resolveLyrics,
  saveBilibiliSearchTrack,
  searchBilibili,
  syncPlaylist as syncBilibiliPlaylist,
  upstreamHeaders,
} from "./bilibili.js";
import type { ProviderProfile, SearchTrack, SourceRef, Track } from "./types.js";

export type MusicProvider = {
  id: string;
  name: string;
  description: string;
  capabilities: ProviderProfile["capabilities"];
  accepts(input: string): boolean;
  profile(): Promise<ProviderProfile["profile"]>;
  importSource(input: string): ReturnType<typeof importBilibiliSource>;
  previewSource(input: string): ReturnType<typeof previewBilibiliSource>;
  search?(query: string): Promise<SearchTrack[]>;
  saveSearchTrack?(track: SearchTrack): Track;
  syncPlaylist(id: number): ReturnType<typeof syncBilibiliPlaylist>;
  resolveAudio(source: SourceRef): ReturnType<typeof resolveAudio>;
  resolveLyrics(source: SourceRef): ReturnType<typeof resolveLyrics>;
  login?: { createQr: typeof createQrLogin; pollQr: typeof pollQrLogin; logout: typeof logout };
  upstreamHeaders?(range?: string): Record<string, string>;
};

const bilibili: MusicProvider = {
  id: BILIBILI_PROVIDER_ID,
  name: BILIBILI_PROVIDER_NAME,
  description: "导入收藏夹、合集和视频分 P，并按需代理音频播放。",
  capabilities: ["import", "stream", "lyrics", "login", "search"],
  accepts: (input) => /(?:bilibili\.com|b23\.tv|BV[0-9A-Za-z]{10})/i.test(input),
  profile: async () => {
    const profile = await getProfile();
    return profile ? { name: profile.name, avatar: profile.avatar, id: profile.mid } : null;
  },
  importSource: importBilibiliSource,
  previewSource: previewBilibiliSource,
  search: searchBilibili,
  saveSearchTrack: saveBilibiliSearchTrack,
  syncPlaylist: syncBilibiliPlaylist,
  resolveAudio: (source) => resolveAudio(source.resourceId, Number(source.itemId)),
  resolveLyrics: (source) => resolveLyrics(source.resourceId, Number(source.itemId)),
  login: { createQr: createQrLogin, pollQr: pollQrLogin, logout },
  upstreamHeaders,
};

const providers = new Map<string, MusicProvider>([[bilibili.id, bilibili]]);

export function listProviders(): Promise<ProviderProfile[]> {
  return Promise.all([...providers.values()].map(async (provider) => {
    const profile = await provider.profile();
    return { id: provider.id, name: provider.name, description: provider.description, capabilities: provider.capabilities, connected: Boolean(profile), profile };
  }));
}

export function getProvider(id: string) {
  const provider = providers.get(id);
  if (!provider) throw Object.assign(new Error(`不支持的音乐来源：${id}`), { statusCode: 422 });
  return provider;
}

export function providerForInput(input: string, requestedId?: string) {
  if (requestedId) return getProvider(requestedId);
  const provider = [...providers.values()].find((item) => item.accepts(input));
  if (!provider) throw Object.assign(new Error("未识别音乐来源，请先选择支持的来源"), { statusCode: 422 });
  return provider;
}
