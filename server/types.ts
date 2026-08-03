export type SourceRef = {
  provider: string;
  resourceId: string;
  itemId?: string;
  metadata?: Record<string, unknown>;
};

export type Track = {
  id: number;
  title: string;
  artist: string;
  cover: string;
  duration: number;
  source: SourceRef;
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

export type BiliVideo = {
  bvid: string;
  title: string;
  owner: { name: string };
  pic: string;
  duration: number;
  pages: Array<{ cid: number; page: number; part: string; duration: number }>;
};
