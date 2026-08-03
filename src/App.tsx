import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine, CheckCircle2, ChevronDown, ChevronRight, Clock3, CloudOff,
  Disc3, Download, Heart, Home, Library, ListMusic, LogOut, Menu, MoreHorizontal,
  Music2, Pause, Play, Plus, RefreshCw, Repeat, Repeat1, Search, Settings,
  Shuffle, SkipBack, SkipForward, Smartphone, Timer, Trash2, UserRound, Wifi,
  WifiOff, X,
} from "lucide-react";
import { api } from "./lib/api";
import { cleanupStorage, downloadTrack, pauseDownload, removeDownload } from "./lib/downloads";
import { getDownloads, saveDownload } from "./lib/idb";
import type { DownloadRecord, Playlist, ProviderProfile, RepeatMode, Tab, Track } from "./types";

type LibrarySnapshot = { tracks: Track[]; playlists: Playlist[] };
type Profile = { name: string; avatar?: string; id?: string | number };

const EMPTY_LIBRARY: LibrarySnapshot = { tracks: [], playlists: [] };
const ACCENT = ["#ff7a59", "#7c5cff", "#25c6a0", "#f4bd4f", "#ee5c8a", "#4898ff"];

function fmt(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  return `${m}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function bytes(value: number) {
  if (!value) return "0 MB";
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / 1024 ** 2).toFixed(value > 1024 ** 3 ? 0 : 1)} MB`;
}

function coverStyle(track?: Track | Playlist, index = 0) {
  const cover = track?.cover;
  return cover
    ? { backgroundImage: `linear-gradient(180deg, transparent 45%, rgba(5,4,10,.7)), url(${cover})` }
    : { background: `linear-gradient(145deg, ${ACCENT[index % ACCENT.length]}, #17141f 76%)` };
}

function loadSnapshot(): LibrarySnapshot {
  try { return JSON.parse(localStorage.getItem("echocrate.library") || localStorage.getItem("bilimusic.library") || "null") || EMPTY_LIBRARY; }
  catch { return EMPTY_LIBRARY; }
}

function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [library, setLibrary] = useState<LibrarySnapshot>(loadSnapshot);
  const [downloads, setDownloads] = useState<DownloadRecord[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");
  const [query, setQuery] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [providers, setProviders] = useState<ProviderProfile[]>([]);
  const [storage, setStorage] = useState({ usage: 0, quota: 0 });

  const savedPlayer = useMemo(() => {
    try { return JSON.parse(localStorage.getItem("echocrate.player") || localStorage.getItem("bilimusic.player") || "{}"); } catch { return {}; }
  }, []);
  const [queue, setQueue] = useState<number[]>(savedPlayer.queue || []);
  const [currentId, setCurrentId] = useState<number | null>(savedPlayer.currentId || null);
  const [repeat, setRepeat] = useState<RepeatMode>(savedPlayer.repeat || "off");
  const [shuffle, setShuffle] = useState(Boolean(savedPlayer.shuffle));
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(Number(savedPlayer.position || 0));
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [lyrics, setLyrics] = useState<Array<{ from: number; to: number; content: string }>>([]);
  const [sleepUntil, setSleepUntil] = useState<number | null>(null);
  const [sleepAfterTrack, setSleepAfterTrack] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  const current = library.tracks.find((track) => track.id === currentId) || null;
  const downloadedIds = useMemo(() => new Set(downloads.filter((item) => item.status === "complete").map((item) => item.trackId)), [downloads]);
  const filteredTracks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? library.tracks.filter((track) => `${track.title} ${track.artist}`.toLowerCase().includes(needle)) : library.tracks;
  }, [library.tracks, query]);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  const refreshStorage = useCallback(async () => {
    const value = await navigator.storage?.estimate?.();
    setStorage({ usage: value?.usage || 0, quota: value?.quota || 0 });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const value = await api.library();
      setLibrary(value);
      localStorage.setItem("echocrate.library", JSON.stringify(value));
    } catch (error) {
      if (!library.tracks.length) notify((error as Error).message);
    } finally { setLoading(false); }
  }, [library.tracks.length, notify]);

  useEffect(() => {
    void refresh();
    void getDownloads().then(setDownloads);
    void api.providers().then((value) => {
      setProviders(value.providers);
      setProfile(value.providers.find((item) => item.id === "bilibili")?.profile || null);
    }).catch(() => undefined);
    void refreshStorage();
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => { window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = window.setTimeout(() => localStorage.setItem("echocrate.player", JSON.stringify({ queue, currentId, repeat, shuffle, position })), 500);
    return () => clearTimeout(timer);
  }, [queue, currentId, repeat, shuffle, position]);

  useEffect(() => {
    if (!current) { setLyrics([]); return; }
    void api.lyrics(current.id).then((value) => {
      if (value.lines) setLyrics(value.lines);
      else if (value.content) setLyrics(parseLrc(value.content));
      else setLyrics([]);
    }).catch(() => setLyrics([]));
  }, [current?.id]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.playbackRate = speed;
  }, [speed]);

  useEffect(() => {
    if (!sleepUntil) return;
    const timer = window.setInterval(() => {
      if (Date.now() >= sleepUntil) {
        audioRef.current?.pause();
        setSleepUntil(null);
        notify("睡眠定时已结束");
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [sleepUntil, notify]);

  const updateDownload = useCallback((record: DownloadRecord) => {
    setDownloads((items) => [...items.filter((item) => item.trackId !== record.trackId), record]);
    if (record.status === "complete") { notify("已保存到本地"); void refreshStorage(); }
  }, [notify, refreshStorage]);

  const startDownload = useCallback(async (trackId: number) => {
    notify("开始下载，可切换页面继续使用");
    await downloadTrack(trackId, updateDownload);
    const latest = await getDownloads();
    setDownloads(latest);
    const removed = await cleanupStorage(latest, new Set(library.tracks.filter((track) => track.favorite).map((track) => track.id)));
    if (removed.length) { setDownloads(await getDownloads()); notify(`空间不足，已清理 ${removed.length} 首旧缓存`); }
  }, [library.tracks, notify, updateDownload]);

  const playTrack = useCallback((track: Track, list = library.tracks) => {
    if (!online && !downloadedIds.has(track.id)) { notify("这首歌尚未离线保存"); return; }
    setQueue(list.map((item) => item.id));
    setCurrentId(track.id);
    setPosition(0);
    window.setTimeout(() => audioRef.current?.play().catch(() => notify("点击播放键开始播放")), 0);
  }, [downloadedIds, library.tracks, notify, online]);

  const move = useCallback((direction: 1 | -1) => {
    if (!currentId || !queue.length) return;
    const index = queue.indexOf(currentId);
    let nextIndex = index + direction;
    if (shuffle) nextIndex = Math.floor(Math.random() * queue.length);
    if (nextIndex < 0 || nextIndex >= queue.length) {
      if (repeat === "all") nextIndex = (nextIndex + queue.length) % queue.length;
      else { audioRef.current?.pause(); return; }
    }
    const next = library.tracks.find((track) => track.id === queue[nextIndex]);
    if (next) playTrack(next, queue.map((id) => library.tracks.find((track) => track.id === id)).filter(Boolean) as Track[]);
  }, [currentId, library.tracks, playTrack, queue, repeat, shuffle]);

  useEffect(() => {
    if (!current || !("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.title, artist: current.artist, album: "回声仓",
      artwork: current.cover ? [{ src: current.cover, sizes: "512x512" }] : [],
    });
    navigator.mediaSession.setActionHandler("play", () => audioRef.current?.play());
    navigator.mediaSession.setActionHandler("pause", () => audioRef.current?.pause());
    navigator.mediaSession.setActionHandler("previoustrack", () => move(-1));
    navigator.mediaSession.setActionHandler("nexttrack", () => move(1));
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (audioRef.current && details.seekTime != null) audioRef.current.currentTime = details.seekTime;
    });
  }, [current?.id, move]);

  const onEnded = () => {
    if (sleepAfterTrack) { setSleepAfterTrack(false); audioRef.current?.pause(); return; }
    if (repeat === "one" && audioRef.current) { audioRef.current.currentTime = 0; void audioRef.current.play(); }
    else move(1);
  };

  const togglePlay = () => {
    if (!current && library.tracks[0]) return playTrack(library.tracks[0]);
    if (playing) audioRef.current?.pause(); else void audioRef.current?.play();
  };

  const favorite = async (track: Track) => {
    try {
      const value = await api.favorite(track.id);
      setLibrary((old) => ({ ...old, tracks: old.tracks.map((item) => item.id === track.id ? { ...item, favorite: value.favorite } : item) }));
    } catch (error) { notify((error as Error).message); }
  };

  const nav = [
    { id: "home" as const, label: "首页", icon: Home },
    { id: "library" as const, label: "音乐库", icon: Library },
    { id: "downloads" as const, label: "下载", icon: ArrowDownToLine },
    { id: "settings" as const, label: "设置", icon: Settings },
  ];

  return (
    <div className="app-shell">
      <audio
        ref={audioRef}
        src={current ? `/api/tracks/${current.id}/audio` : undefined}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={(event) => { setDuration(event.currentTarget.duration || current?.duration || 0); if (position) event.currentTarget.currentTime = position; }}
        onTimeUpdate={(event) => {
          const time = event.currentTarget.currentTime;
          setPosition(time);
          if (current && Math.floor(time) % 15 === 0) void api.history(current.id, time).catch(() => undefined);
          if ("mediaSession" in navigator && Number.isFinite(event.currentTarget.duration)) {
            try { navigator.mediaSession.setPositionState({ duration: event.currentTarget.duration, position: time, playbackRate: event.currentTarget.playbackRate }); } catch { /* transient metadata */ }
          }
        }}
        onEnded={onEnded}
        onError={() => current && notify(online ? "音频来源暂时不可用" : "本地缓存读取失败")}
      />

      <header className="topbar">
        <div className="brand"><span className="brand-mark"><Disc3 size={19} /></span><span>回声仓</span></div>
        <div className={`network-pill ${online ? "" : "offline"}`}>{online ? <Wifi size={13} /> : <WifiOff size={13} />}{online ? "在线" : "离线模式"}</div>
      </header>

      <main className="content">
        {tab === "home" && <HomePage library={library} loading={loading} downloadedIds={downloadedIds} playTrack={playTrack} setTab={setTab} openImport={() => setImportOpen(true)} />}
        {tab === "library" && <LibraryPage library={library} query={query} setQuery={setQuery} downloadedIds={downloadedIds} playTrack={playTrack} favorite={favorite} download={startDownload} sync={async (id) => { try { await api.sync(id); await refresh(); notify("歌单已同步"); } catch (error) { notify((error as Error).message); } }} openImport={() => setImportOpen(true)} />}
        {tab === "downloads" && <DownloadsPage records={downloads} tracks={library.tracks} storage={storage} pause={pauseDownload} retry={startDownload} remove={async (id) => { await removeDownload(id); setDownloads(await getDownloads()); await refreshStorage(); }} togglePin={async (record) => { const next = { ...record, pinned: !record.pinned }; await saveDownload(next); setDownloads(await getDownloads()); }} playTrack={playTrack} />}
        {tab === "settings" && <SettingsPage profile={profile} providers={providers} storage={storage} setProfile={setProfile} setProviders={setProviders} refreshStorage={refreshStorage} notify={notify} />}
      </main>

      {current && <MiniPlayer track={current} playing={playing} progress={duration ? position / duration : 0} downloaded={downloadedIds.has(current.id)} onOpen={() => setPlayerOpen(true)} onPlay={togglePlay} onNext={() => move(1)} />}

      <nav className="bottom-nav">
        {nav.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><item.icon size={21} strokeWidth={tab === item.id ? 2.5 : 1.8} /><span>{item.label}</span></button>)}
      </nav>

      {importOpen && <ImportSheet providers={providers} onClose={() => setImportOpen(false)} onDone={async (message) => { setImportOpen(false); await refresh(); notify(message); }} notify={notify} />}
      {playerOpen && current && <FullPlayer track={current} playing={playing} position={position} duration={duration || current.duration} repeat={repeat} shuffle={shuffle} speed={speed} lyrics={lyrics} queue={queue.map((id) => library.tracks.find((track) => track.id === id)).filter(Boolean) as Track[]} downloaded={downloadedIds.has(current.id)} sleepUntil={sleepUntil} sleepAfterTrack={sleepAfterTrack} close={() => setPlayerOpen(false)} togglePlay={togglePlay} move={move} seek={(value) => { if (audioRef.current) audioRef.current.currentTime = value; }} toggleFavorite={() => favorite(current)} setRepeat={setRepeat} setShuffle={setShuffle} setSpeed={setSpeed} download={() => void startDownload(current.id)} setSleep={(minutes) => { setSleepAfterTrack(false); setSleepUntil(minutes ? Date.now() + minutes * 60_000 : null); }} setSleepAfterTrack={setSleepAfterTrack} removeFromQueue={(id) => setQueue((old) => old.filter((value) => value !== id))} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function HomePage({ library, loading, downloadedIds, playTrack, setTab, openImport }: { library: LibrarySnapshot; loading: boolean; downloadedIds: Set<number>; playTrack: (track: Track, list?: Track[]) => void; setTab: (tab: Tab) => void; openImport: () => void }) {
  const recent = library.tracks.slice(0, 5);
  const offline = library.tracks.filter((track) => downloadedIds.has(track.id)).slice(0, 5);
  if (!loading && !library.tracks.length) return <EmptyLibrary openImport={openImport} />;
  return <>
    <section className="hero-section">
      <p className="eyebrow">你的私人声场</p>
      <h1>今天，想听点<br /><em>什么？</em></h1>
      <button className="hero-play" disabled={!recent.length} onClick={() => recent[0] && playTrack(recent[0], recent)}><Play size={22} fill="currentColor" /> 播放最近音乐</button>
      <div className="orb orb-one" /><div className="orb orb-two" />
    </section>
    <SectionHeader title="最近歌单" action="查看全部" onClick={() => setTab("library")} />
    <div className="playlist-scroll">
      {library.playlists.slice(0, 6).map((playlist, index) => <article className="playlist-card" key={playlist.id}><div className="playlist-cover" style={coverStyle(playlist, index)}><span>{playlist.itemCount} 首</span></div><h3>{playlist.title}</h3><p>{playlist.provider === "bilibili" ? `Bilibili · ${playlist.sourceType === "favorite" ? "收藏夹" : playlist.sourceType === "collection" ? "合集" : "视频"}` : playlist.provider}</p></article>)}
      {loading && [0,1,2].map((item) => <div className="playlist-card skeleton" key={item} />)}
    </div>
    <SectionHeader title="最近新增" action={`${library.tracks.length} 首`} />
    <TrackList tracks={recent} downloadedIds={downloadedIds} onPlay={(track) => playTrack(track, recent)} />
    {offline.length > 0 && <><SectionHeader title="离线可播" action="全部下载" onClick={() => setTab("downloads")} /><TrackList tracks={offline} downloadedIds={downloadedIds} onPlay={(track) => playTrack(track, offline)} /></>}
  </>;
}

function EmptyLibrary({ openImport }: { openImport: () => void }) {
  return <div className="empty-library"><div className="empty-record"><Disc3 size={70} /></div><p className="eyebrow">欢迎来到回声仓</p><h1>把喜欢的声音<br />带到这里</h1><p>连接音乐来源，建立只属于你的私人声音库。</p><button className="primary-button" onClick={openImport}><Plus size={18} /> 导入第一份歌单</button></div>;
}

function SectionHeader({ title, action, onClick }: { title: string; action?: string; onClick?: () => void }) {
  return <div className="section-header"><h2>{title}</h2>{action && <button onClick={onClick}>{action}{onClick && <ChevronRight size={15} />}</button>}</div>;
}

function TrackList({ tracks, downloadedIds, onPlay, extra }: { tracks: Track[]; downloadedIds: Set<number>; onPlay: (track: Track) => void; extra?: (track: Track) => React.ReactNode }) {
  return <div className="track-list">{tracks.map((track, index) => <div className="track-row" key={track.id}><button className="track-cover" style={coverStyle(track, index)} onClick={() => onPlay(track)} aria-label={`播放 ${track.title}`}><Play className="cover-play" size={18} fill="currentColor" /></button><button className="track-copy" onClick={() => onPlay(track)}><strong>{track.title}</strong><span>{track.artist}{downloadedIds.has(track.id) && <><i>·</i><CloudOff size={12} /> 已下载</>}</span></button><span className="track-time">{fmt(track.duration)}</span>{extra?.(track)}</div>)}</div>;
}

function LibraryPage({ library, query, setQuery, downloadedIds, playTrack, favorite, download, sync, openImport }: { library: LibrarySnapshot; query: string; setQuery: (value: string) => void; downloadedIds: Set<number>; playTrack: (track: Track, list?: Track[]) => void; favorite: (track: Track) => void; download: (id: number) => void; sync: (id: number) => void; openImport: () => void }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [selectedTracks, setSelectedTracks] = useState<Track[]>([]);
  useEffect(() => {
    if (selected === null) { setSelectedTracks([]); return; }
    void api.playlistTracks(selected).then((value) => setSelectedTracks(value.tracks)).catch(() => setSelectedTracks([]));
  }, [selected, library.tracks]);
  const baseTracks = selected === null ? library.tracks : selectedTracks;
  const filtered = query.trim() ? baseTracks.filter((track) => `${track.title} ${track.artist}`.toLowerCase().includes(query.toLowerCase())) : baseTracks;
  return <>
    <div className="page-title"><div><p className="eyebrow">你的收藏</p><h1>音乐库</h1></div><button className="round-button" onClick={openImport}><Plus size={22} /></button></div>
    <label className="search-box"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索歌曲或创作者" />{query && <button onClick={() => setQuery("")}><X size={16} /></button>}</label>
    <div className="filter-pills"><button className={selected === null ? "active" : ""} onClick={() => setSelected(null)}>全部歌曲 <span>{library.tracks.length}</span></button><button>收藏 <span>{library.tracks.filter((track) => track.favorite).length}</span></button><button>离线 <span>{downloadedIds.size}</span></button></div>
    <SectionHeader title="我的歌单" />
    <div className="library-playlists">{library.playlists.map((playlist, index) => <button className={`library-playlist ${selected === playlist.id ? "selected" : ""}`} key={playlist.id} onClick={() => setSelected(selected === playlist.id ? null : playlist.id)}><span className="small-cover" style={coverStyle(playlist, index)} /><span><strong>{playlist.title}</strong><small>{playlist.itemCount} 首 · {playlist.provider === "bilibili" ? "Bilibili" : playlist.provider}</small></span><span className="sync-button" onClick={(event) => { event.stopPropagation(); void sync(playlist.id); }}><RefreshCw size={16} /></span></button>)}</div>
    <SectionHeader title={selected ? library.playlists.find((item) => item.id === selected)?.title || "歌单" : "全部歌曲"} action={selected ? "下载全部" : `${filtered.length} 首`} onClick={selected ? () => filtered.filter((track) => !downloadedIds.has(track.id)).forEach((track) => void download(track.id)) : undefined} />
    <TrackList tracks={filtered} downloadedIds={downloadedIds} onPlay={(track) => playTrack(track, filtered)} extra={(track) => <div className="track-actions"><button className={track.favorite ? "liked" : ""} onClick={() => void favorite(track)}><Heart size={17} fill={track.favorite ? "currentColor" : "none"} /></button><button onClick={() => void download(track.id)} disabled={downloadedIds.has(track.id)}>{downloadedIds.has(track.id) ? <CheckCircle2 size={17} /> : <Download size={17} />}</button></div>} />
  </>;
}

function DownloadsPage({ records, tracks, storage, pause, retry, remove, togglePin, playTrack }: { records: DownloadRecord[]; tracks: Track[]; storage: { usage: number; quota: number }; pause: (id: number) => void; retry: (id: number) => void; remove: (id: number) => void; togglePin: (record: DownloadRecord) => void; playTrack: (track: Track) => void }) {
  const complete = records.filter((item) => item.status === "complete");
  const active = records.filter((item) => item.status !== "complete");
  const percent = storage.quota ? Math.min(100, storage.usage / storage.quota * 100) : 0;
  return <>
    <div className="page-title"><div><p className="eyebrow">随时随地</p><h1>离线下载</h1></div><Smartphone size={31} /></div>
    <section className="storage-card"><div className="storage-ring" style={{ "--progress": `${percent * 3.6}deg` } as React.CSSProperties}><strong>{Math.round(percent)}%</strong></div><div><span>浏览器本地空间</span><h3>{bytes(storage.usage)} <small>/ {bytes(storage.quota)}</small></h3><p>达到 85% 后自动清理最久未播放的普通缓存</p></div></section>
    {active.length > 0 && <><SectionHeader title="下载任务" action={`${active.length}`} /><div className="download-list">{active.map((record) => { const track = tracks.find((item) => item.id === record.trackId); return <div className="download-row" key={record.trackId}><span className="small-cover" style={coverStyle(track)} /><div className="download-info"><strong>{track?.title || `曲目 ${record.trackId}`}</strong><span>{record.status === "downloading" ? `${bytes(record.received)} / ${bytes(record.total)}` : record.status === "paused" ? "已暂停" : record.error || "等待重试"}</span><div className="progress"><i style={{ width: `${record.total ? record.received / record.total * 100 : 12}%` }} /></div></div><button onClick={() => record.status === "downloading" ? pause(record.trackId) : void retry(record.trackId)}>{record.status === "downloading" ? <Pause size={18} /> : <RefreshCw size={18} />}</button></div>; })}</div></>}
    <SectionHeader title="已下载" action={`${complete.length} 首`} />
    {complete.length ? <div className="download-list">{complete.map((record) => { const track = tracks.find((item) => item.id === record.trackId); return <div className="download-row complete" key={record.trackId}><button className="small-cover" style={coverStyle(track)} onClick={() => track && playTrack(track)}><Play size={16} fill="currentColor" /></button><div className="download-info"><strong>{track?.title || `曲目 ${record.trackId}`}</strong><span>{bytes(record.total)} · 本地可播</span></div><button className={record.pinned ? "liked" : ""} onClick={() => void togglePin(record)}><Heart size={17} fill={record.pinned ? "currentColor" : "none"} /></button><button onClick={() => void remove(record.trackId)}><Trash2 size={17} /></button></div>; })}</div> : <div className="soft-empty"><ArrowDownToLine size={30} /><p>还没有离线歌曲</p><span>在音乐库点下载，断网也能继续听。</span></div>}
  </>;
}

function SettingsPage({ profile, providers, storage, setProfile, setProviders, refreshStorage, notify }: { profile: Profile | null; providers: ProviderProfile[]; storage: { usage: number; quota: number }; setProfile: (profile: Profile | null) => void; setProviders: (providers: ProviderProfile[]) => void; refreshStorage: () => void; notify: (message: string) => void }) {
  const [qr, setQr] = useState<{ key: string; image: string } | null>(null);
  const [status, setStatus] = useState("");
  const beginLogin = async () => {
    try { const value = await api.createQr("bilibili"); setQr(value); setStatus("请使用哔哩哔哩客户端扫码"); }
    catch (error) { notify((error as Error).message); }
  };
  useEffect(() => {
    if (!qr) return;
    const timer = window.setInterval(async () => {
      try {
        const value = await api.pollQr("bilibili", qr.key);
        if (value.status === "confirmed" && value.profile) { setProfile(value.profile); setQr(null); void api.providers().then((next) => setProviders(next.providers)); notify("Bilibili 已绑定"); }
        else if (value.status === "expired") { setStatus("二维码已过期，请重新生成"); clearInterval(timer); }
        else setStatus(value.status === "scanned" ? "已扫码，请在手机上确认" : "等待扫码…");
      } catch { /* retry on next poll */ }
    }, 2000);
    return () => clearInterval(timer);
  }, [qr, notify, setProfile]);
  return <>
    <div className="page-title"><div><p className="eyebrow">个人空间</p><h1>设置</h1></div><Settings size={30} /></div>
    <SectionHeader title="音乐来源" />
    <section className="setting-card account-card">
      {profile ? <><img src={profile.avatar} alt="Bilibili 头像" /><div><strong>{profile.name}</strong><span>UID {profile.id} · 会话已加密保存</span></div><button onClick={async () => { await api.logout("bilibili"); setProfile(null); void api.providers().then((next) => setProviders(next.providers)); }}><LogOut size={18} /></button></> : <><span className="account-icon"><UserRound size={25} /></span><div><strong>Bilibili 未连接</strong><span>连接后可读取私人收藏夹</span></div><button className="small-primary" onClick={() => void beginLogin()}>扫码绑定</button></>}
    </section>
    {qr && <div className="qr-card"><button className="qr-close" onClick={() => setQr(null)}><X size={18} /></button><img src={qr.image} alt="Bilibili 登录二维码" /><strong>{status}</strong><span>登录凭据只保存在你的 WanLab 服务端</span></div>}
    <section className="provider-summary">{providers.filter((item) => item.id !== "bilibili").length ? providers.filter((item) => item.id !== "bilibili").map((item) => <div key={item.id}><span className="setting-icon purple"><Music2 size={19} /></span><span><strong>{item.name}</strong><small>{item.description}</small></span></div>) : <div><span className="setting-icon purple"><Plus size={19} /></span><span><strong>更多来源即将接入</strong><small>EchoCrate 通过 Provider 插件扩展本地音乐、WebDAV 与媒体服务器。</small></span></div>}</section>
    <SectionHeader title="离线与存储" />
    <section className="settings-list"><button onClick={() => void refreshStorage()}><span className="setting-icon purple"><ArrowDownToLine size={19} /></span><span><strong>本地缓存</strong><small>已使用 {bytes(storage.usage)}</small></span><ChevronRight size={18} /></button><div><span className="setting-icon orange"><RefreshCw size={19} /></span><span><strong>自动清理</strong><small>85% 开始，清理到 75%</small></span><span className="toggle on"><i /></span></div><div><span className="setting-icon green"><CloudOff size={19} /></span><span><strong>离线优先</strong><small>已有缓存时不请求远端</small></span><span className="toggle on"><i /></span></div></section>
    <SectionHeader title="关于" />
    <section className="settings-list"><div><span className="setting-icon pink"><Disc3 size={19} /></span><span><strong>回声仓 · EchoCrate</strong><small>可自托管、多来源音乐 PWA · v0.2.0</small></span></div><div><span className="setting-icon blue"><Smartphone size={19} /></span><span><strong>安装到桌面</strong><small>在 Chrome 菜单选择“安装应用”</small></span></div></section>
  </>;
}

function MiniPlayer({ track, playing, progress, downloaded, onOpen, onPlay, onNext }: { track: Track; playing: boolean; progress: number; downloaded: boolean; onOpen: () => void; onPlay: () => void; onNext: () => void }) {
  return <div className="mini-player"><div className="mini-progress" style={{ width: `${progress * 100}%` }} /><button className="mini-main" onClick={onOpen}><span className={`mini-cover ${playing ? "spinning" : ""}`} style={coverStyle(track)} /><span><strong>{track.title}</strong><small>{track.artist} {downloaded ? "· 本地" : "· 在线"}</small></span></button><button onClick={onPlay}>{playing ? <Pause size={21} fill="currentColor" /> : <Play size={21} fill="currentColor" />}</button><button onClick={onNext}><SkipForward size={21} fill="currentColor" /></button></div>;
}

function FullPlayer({ track, playing, position, duration, repeat, shuffle, speed, lyrics, queue, downloaded, sleepUntil, sleepAfterTrack, close, togglePlay, move, seek, toggleFavorite, setRepeat, setShuffle, setSpeed, download, setSleep, setSleepAfterTrack, removeFromQueue }: { track: Track; playing: boolean; position: number; duration: number; repeat: RepeatMode; shuffle: boolean; speed: number; lyrics: Array<{ from: number; to: number; content: string }>; queue: Track[]; downloaded: boolean; sleepUntil: number | null; sleepAfterTrack: boolean; close: () => void; togglePlay: () => void; move: (value: 1 | -1) => void; seek: (value: number) => void; toggleFavorite: () => void; setRepeat: (value: RepeatMode) => void; setShuffle: (value: boolean) => void; setSpeed: (value: number) => void; download: () => void; setSleep: (minutes: number) => void; setSleepAfterTrack: (value: boolean) => void; removeFromQueue: (id: number) => void }) {
  const [panel, setPanel] = useState<"lyrics" | "queue" | "sleep" | null>(null);
  const activeLine = lyrics.findIndex((line) => position >= line.from && position < line.to);
  const cycleRepeat = () => setRepeat(repeat === "off" ? "all" : repeat === "all" ? "one" : "off");
  return <div className="full-player">
    <div className="player-backdrop" style={coverStyle(track)} />
    <header><button onClick={close}><ChevronDown size={27} /></button><span><small>正在播放</small><strong>回声仓</strong></span><button onClick={() => setPanel(panel === "queue" ? null : "queue")}><Menu size={23} /></button></header>
    <div className="art-wrap"><div className={`big-art ${playing ? "playing" : ""}`} style={coverStyle(track)}><span className="vinyl-hole" /></div></div>
    <div className="player-meta"><div><h2>{track.title}</h2><p>{track.artist}</p></div><button className={track.favorite ? "liked" : ""} onClick={toggleFavorite}><Heart size={24} fill={track.favorite ? "currentColor" : "none"} /></button></div>
    <div className="seek"><input type="range" min="0" max={duration || 1} value={position} onChange={(event) => seek(Number(event.target.value))} style={{ "--value": `${duration ? position / duration * 100 : 0}%` } as React.CSSProperties} /><div><span>{fmt(position)}</span><span>{downloaded ? "本地缓存" : track.source.provider === "bilibili" ? "Bilibili 音频" : `${track.source.provider} 音频`}</span><span>-{fmt(Math.max(0, duration - position))}</span></div></div>
    <div className="main-controls"><button className={shuffle ? "active" : ""} onClick={() => setShuffle(!shuffle)}><Shuffle size={21} /></button><button onClick={() => move(-1)}><SkipBack size={29} fill="currentColor" /></button><button className="play-button" onClick={togglePlay}>{playing ? <Pause size={31} fill="currentColor" /> : <Play size={31} fill="currentColor" />}</button><button onClick={() => move(1)}><SkipForward size={29} fill="currentColor" /></button><button className={repeat !== "off" ? "active" : ""} onClick={cycleRepeat}>{repeat === "one" ? <Repeat1 size={21} /> : <Repeat size={21} />}</button></div>
    <div className="player-tools"><button onClick={() => setPanel(panel === "lyrics" ? null : "lyrics")}><Music2 size={19} /><span>歌词</span></button><button onClick={download} disabled={downloaded}>{downloaded ? <CheckCircle2 size={19} /> : <Download size={19} />}<span>{downloaded ? "已下载" : "下载"}</span></button><button onClick={() => setSpeed(speed >= 2 ? .75 : speed + .25)}><strong>{speed}×</strong><span>倍速</span></button><button onClick={() => setPanel(panel === "sleep" ? null : "sleep")} className={sleepUntil || sleepAfterTrack ? "active" : ""}><Timer size={19} /><span>定时</span></button></div>
    {panel && <div className="player-panel"><div className="panel-handle" />{panel === "lyrics" && <><h3>歌词</h3>{lyrics.length ? <div className="lyrics">{lyrics.map((line, index) => <p className={index === activeLine ? "active" : ""} key={`${line.from}-${index}`} onClick={() => seek(line.from)}>{line.content}</p>)}</div> : <div className="soft-empty"><Music2 size={28} /><p>这首歌暂时没有歌词</p></div>}</>}{panel === "queue" && <><h3>播放队列 <small>{queue.length} 首</small></h3><div className="queue-list">{queue.map((item) => <div className={item.id === track.id ? "active" : ""} key={item.id}><Menu size={16} /><span><strong>{item.title}</strong><small>{item.artist}</small></span>{item.id !== track.id && <button onClick={() => removeFromQueue(item.id)}><X size={17} /></button>}</div>)}</div></>}{panel === "sleep" && <><h3>睡眠定时</h3><div className="sleep-grid">{[15,30,60,90].map((minutes) => <button key={minutes} onClick={() => setSleep(minutes)}>{minutes}<small>分钟</small></button>)}<button className={sleepAfterTrack ? "selected" : ""} onClick={() => { setSleep(0); setSleepAfterTrack(!sleepAfterTrack); }}>本曲<small>结束后</small></button><button onClick={() => { setSleep(0); setSleepAfterTrack(false); }}>关闭<small>定时</small></button></div></>}</div>}
  </div>;
}

function ImportSheet({ providers, onClose, onDone, notify }: { providers: ProviderProfile[]; onClose: () => void; onDone: (message: string) => void; notify: (message: string) => void }) {
  const [url, setUrl] = useState("");
  const [provider, setProvider] = useState("bilibili");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try { const value = await api.import(url, provider); onDone(`已导入 ${value.imported} 首曲目`); }
    catch (error) { notify((error as Error).message); }
    finally { setBusy(false); }
  };
  const selected = providers.find((item) => item.id === provider);
  return <div className="sheet-shade" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="import-sheet"><div className="panel-handle" /><button className="sheet-close" onClick={onClose}><X size={20} /></button><span className="import-icon"><ListMusic size={30} /></span><p className="eyebrow">添加音乐</p><h2>导入音乐来源</h2><p>{selected?.description || "选择来源后导入你的音乐。"}</p><label><span>音乐来源</span><select value={provider} onChange={(event) => setProvider(event.target.value)}>{providers.filter((item) => item.capabilities.includes("import")).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label><span>链接地址</span><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder={provider === "bilibili" ? "https://www.bilibili.com/video/BV..." : "粘贴来源链接"} autoFocus /></label><button className="primary-button full" onClick={() => void submit()} disabled={busy || !url.trim()}>{busy ? <RefreshCw className="rotating" size={18} /> : <Plus size={18} />}{busy ? "正在读取歌单…" : "开始导入"}</button><small className="privacy-note">仅导入你有权访问的内容，不提供音频文件导出或公开分享。</small></div></div>;
}

function parseLrc(content: string) {
  return content.split("\n").flatMap((line) => {
    const match = line.match(/\[(\d+):(\d+(?:\.\d+)?)\](.*)/);
    if (!match) return [];
    const from = Number(match[1]) * 60 + Number(match[2]);
    return [{ from, to: from + 8, content: match[3].trim() }];
  }).map((line, index, all) => ({ ...line, to: all[index + 1]?.from || line.to }));
}

export default App;
