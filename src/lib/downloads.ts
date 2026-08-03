import { getDownloads, removeDownloadRecord, saveDownload } from "./idb";
import type { DownloadRecord } from "../types";

const controllers = new Map<number, AbortController>();
const CACHE = "echocrate-media-v1";
const PREFETCH_CACHE = "echocrate-prebuffer-v1";
const PREFETCH_BYTES = 1_572_864;

async function opfsRoot() {
  return navigator.storage?.getDirectory?.();
}

async function copyFile(root: FileSystemDirectoryHandle, from: string, to: string) {
  const source = await (await root.getFileHandle(from)).getFile();
  const target = await root.getFileHandle(to, { create: true });
  const writer = await target.createWritable();
  await source.stream().pipeTo(writer);
}

export async function downloadTrack(trackId: number, onProgress: (record: DownloadRecord) => void) {
  const controller = new AbortController();
  controllers.set(trackId, controller);
  let record: DownloadRecord = {
    trackId, status: "downloading", received: 0, total: 0,
    updatedAt: Date.now(), pinned: false, lastPlayedAt: 0,
  };
  const previous = (await getDownloads()).find((item) => item.trackId === trackId);
  if (previous) record = { ...previous, status: "downloading", error: undefined, updatedAt: Date.now() };
  onProgress(record);
  await saveDownload(record);

  try {
    const root = await opfsRoot();
    if (!root) {
      const response = await fetch(`/api/tracks/${trackId}/audio`, { signal: controller.signal });
      if (!response.ok) throw new Error("下载失败");
      const total = Number(response.headers.get("content-length") || 0);
      await (await caches.open(CACHE)).put(`/api/tracks/${trackId}/audio`, response.clone());
      record = { ...record, status: "complete", received: total, total, updatedAt: Date.now() };
    } else {
      const partialName = `track-${trackId}.partial`;
      const finalName = `track-${trackId}.media`;
      const partial = await root.getFileHandle(partialName, { create: true });
      const existing = await partial.getFile();
      let offset = existing.size;
      let response = await fetch(`/api/tracks/${trackId}/audio`, {
        headers: offset ? { Range: `bytes=${offset}-` } : undefined,
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`下载失败 (${response.status})`);
      if (offset && response.status !== 206) {
        offset = 0;
        response = await fetch(`/api/tracks/${trackId}/audio`, { signal: controller.signal });
      }
      if (!response.body) throw new Error("来源没有返回音频内容");
      const totalHeader = Number(response.headers.get("content-length") || 0);
      const total = totalHeader ? totalHeader + offset : 0;
      const writer = await partial.createWritable({ keepExistingData: offset > 0 });
      if (offset) await writer.seek(offset);
      const reader = response.body.getReader();
      let received = offset;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
        received += value.byteLength;
        record = { ...record, received, total, updatedAt: Date.now() };
        onProgress(record);
      }
      await writer.close();
      if (total && received !== total) throw new Error("下载文件不完整，请重试");
      await copyFile(root, partialName, finalName);
      await root.removeEntry(partialName);
      record = { ...record, status: "complete", received, total: total || received, updatedAt: Date.now() };
    }
    await saveDownload(record);
    onProgress(record);
  } catch (error) {
    const paused = controller.signal.aborted;
    record = { ...record, status: paused ? "paused" : "failed", error: paused ? undefined : (error as Error).message, updatedAt: Date.now() };
    await saveDownload(record);
    onProgress(record);
  } finally {
    controllers.delete(trackId);
  }
}

export function pauseDownload(trackId: number) {
  controllers.get(trackId)?.abort();
}

export async function removeDownload(trackId: number) {
  pauseDownload(trackId);
  const root = await opfsRoot();
  if (root) {
    for (const name of [`track-${trackId}.media`, `track-${trackId}.partial`]) {
      try { await root.removeEntry(name); } catch { /* absent */ }
    }
  }
  await (await caches.open(CACHE)).delete(`/api/tracks/${trackId}/audio`);
  await removeDownloadRecord(trackId);
}

export async function cleanupStorage(records: DownloadRecord[], favoriteIds = new Set<number>()) {
  const estimate = await navigator.storage?.estimate?.();
  if (!estimate?.quota || !estimate.usage || estimate.usage / estimate.quota < 0.85) return [];
  const candidates = records
    .filter((item) => item.status === "complete" && !item.pinned && !favoriteIds.has(item.trackId))
    .sort((a, b) => a.lastPlayedAt - b.lastPlayedAt);
  const removed: number[] = [];
  for (const item of candidates) {
    await removeDownload(item.trackId);
    removed.push(item.trackId);
    const next = await navigator.storage.estimate();
    if (!next.quota || !next.usage || next.usage / next.quota < 0.75) break;
  }
  return removed;
}

/** Cache only the beginning of a likely next track so playback can start immediately. */
export async function prebufferTrack(trackId: number) {
  if (!navigator.onLine || !("caches" in window)) return;
  const cache = await caches.open(PREFETCH_CACHE);
  const key = `/__echocrate/prebuffer/${trackId}`;
  if (await cache.match(key)) return;

  const response = await fetch(`/api/tracks/${trackId}/audio`, {
    headers: { Range: `bytes=0-${PREFETCH_BYTES - 1}` },
  });
  if (!response.ok) throw new Error("下一首预读失败");

  // Retain only one likely-next prefix; this is intentionally not an offline download.
  await Promise.all((await cache.keys()).map((request) => cache.delete(request)));
  await cache.put(key, response);
}
