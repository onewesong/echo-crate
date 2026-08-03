import type { Playlist, ProviderProfile, RemoteTrack, Track } from "../types";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload as T;
}

export const api = {
  library: () => request<{ tracks: Track[]; playlists: Playlist[] }>("/api/library"),
  playlistTracks: (id: number) => request<{ tracks: Track[] }>(`/api/playlists/${id}/tracks`),
  providers: () => request<{ providers: ProviderProfile[] }>("/api/providers"),
  search: (query: string, providers?: string[]) => request<{ query: string; tracks: RemoteTrack[]; errors: Array<{ provider: string; error: string }> }>(`/api/search?q=${encodeURIComponent(query)}${providers?.length ? `&providers=${encodeURIComponent(providers.join(","))}` : ""}`),
  saveSearchTrack: (token: string) => request<{ track: Track }>(`/api/search/results/${encodeURIComponent(token)}/save`, { method: "POST" }),
  import: (url: string, provider?: string) => request<{ playlist: Playlist; imported: number }>("/api/imports", { method: "POST", body: JSON.stringify({ url, provider }) }),
  sync: (id: number) => request(`/api/playlists/${id}/sync`, { method: "POST" }),
  favorite: (id: number) => request<{ favorite: boolean }>(`/api/tracks/${id}/favorite`, { method: "POST" }),
  history: (trackId: number, position: number) => request("/api/history", { method: "POST", body: JSON.stringify({ trackId, position }) }),
  profile: (provider: string) => request<{ profile: { name: string; avatar?: string; id?: string | number } | null }>(`/api/providers/${provider}/profile`),
  createQr: (provider: string) => request<{ key: string; image: string }>(`/api/providers/${provider}/login/qr`, { method: "POST" }),
  pollQr: (provider: string, key: string) => request<{ status: string; profile?: { name: string; avatar?: string; id?: string | number } }>(`/api/providers/${provider}/login/status?key=${encodeURIComponent(key)}`),
  logout: (provider: string) => request(`/api/providers/${provider}/logout`, { method: "POST" }),
  lyrics: (id: number) => request<{ format: string; content?: string; lines?: Array<{ from: number; to: number; content: string }> }>(`/api/tracks/${id}/lyrics`),
  remoteLyrics: (token: string) => request<{ format: string; content?: string; lines?: Array<{ from: number; to: number; content: string }> }>(`/api/search/results/${encodeURIComponent(token)}/lyrics`),
};
