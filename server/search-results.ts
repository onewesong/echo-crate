import { randomUUID } from "node:crypto";
import type { RemoteTrack, SearchTrack } from "./types.js";

const TTL_MS = 10 * 60_000;
const results = new Map<string, { expiresAt: number; track: SearchTrack }>();

function prune() {
  const now = Date.now();
  for (const [token, value] of results) if (value.expiresAt <= now) results.delete(token);
}

export function storeSearchTrack(track: SearchTrack): RemoteTrack {
  prune();
  const token = randomUUID();
  results.set(token, { expiresAt: Date.now() + TTL_MS, track });
  return { ...track, id: `remote:${token}`, token, kind: "remote", favorite: false, status: "available" };
}

export function getSearchTrack(token: string) {
  const value = results.get(token);
  if (!value || value.expiresAt <= Date.now()) {
    results.delete(token);
    throw Object.assign(new Error("搜索结果已过期，请重新搜索"), { statusCode: 410 });
  }
  return value.track;
}
