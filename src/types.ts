export type Track = {
  id: number;
  title: string;
  artist: string;
  cover: string;
  duration: number;
  source: { provider: string; resourceId: string; itemId?: string; metadata?: Record<string, unknown> };
  favorite: boolean;
  status: "available" | "unavailable";
  createdAt: string;
  lastPlayedAt: string | null;
};

export type Playlist = {
  id: number;
  title: string;
  cover: string;
  provider: string;
  sourceType: string;
  sourceId: string;
  sourceUrl: string;
  itemCount: number;
  lastSyncedAt: string;
};

export type ProviderProfile = {
  id: string;
  name: string;
  description: string;
  connected: boolean;
  capabilities: Array<"import" | "stream" | "lyrics" | "login">;
  profile?: { name: string; avatar?: string; id?: string | number } | null;
};

export type DownloadRecord = {
  trackId: number;
  status: "queued" | "downloading" | "paused" | "complete" | "failed";
  received: number;
  total: number;
  updatedAt: number;
  pinned: boolean;
  lastPlayedAt: number;
  error?: string;
};

export type RepeatMode = "off" | "all" | "one";
export type Tab = "home" | "library" | "downloads" | "settings";
