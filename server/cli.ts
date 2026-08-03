import { getTrack, listPlaylists, listTracks, playlistTracks } from "./db.js";
import { getProvider, listProviders, providerForInput } from "./providers.js";

type Args = { command?: string; values: string[]; provider?: string };

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  const values: string[] = [];
  let provider: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--provider") provider = rest[++index];
    else values.push(rest[index]);
  }
  return { command, values, provider };
}

function usage() {
  return `EchoCrate CLI\n\nUsage:\n  echo-crate providers\n  echo-crate profile [provider]\n  echo-crate login [provider]\n  echo-crate login-status <qr-key> [--provider <id>]\n  echo-crate logout [provider]\n  echo-crate search <query> [--provider <id>]\n  echo-crate preview <url> [--provider <id>]\n  echo-crate import <url> [--provider <id>]\n  echo-crate sync <playlist-id>\n  echo-crate library\n  echo-crate playlist <playlist-id>\n  echo-crate track <track-id>\n  echo-crate audio <track-id>\n  echo-crate lyrics <track-id>\n\nRead-only commands: providers, profile, search, preview, library, playlist, track, audio, lyrics.\nMutating commands: login, logout, import, sync.`;
}

function numberArg(value: string | undefined, label: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} 必须是正整数`);
  return parsed;
}

async function run(args: Args) {
  const providerId = args.provider || args.values[0] || "bilibili";
  switch (args.command) {
    case "providers": return { providers: await listProviders() };
    case "profile": return { provider: providerId, profile: await getProvider(providerId).profile() };
    case "login": {
      const login = getProvider(providerId).login;
      if (!login) throw new Error(`${providerId} 不支持登录`);
      return { provider: providerId, ...(await login.createQr()) };
    }
    case "login-status": {
      const key = args.values[0];
      if (!key) throw new Error("请提供二维码会话 key");
      const login = getProvider(args.provider || "bilibili").login;
      if (!login) throw new Error("该来源不支持登录");
      return { provider: args.provider || "bilibili", ...(await login.pollQr(key)) };
    }
    case "logout": {
      const login = getProvider(providerId).login;
      if (!login) throw new Error(`${providerId} 不支持登录`);
      login.logout();
      return { ok: true, provider: providerId };
    }
    case "search": {
      const query = args.values.join(" ").trim();
      if (query.length < 2) throw new Error("搜索关键词至少需要 2 个字符");
      const provider = getProvider(args.provider || "bilibili");
      if (!provider.search) throw new Error(`${provider.id} 暂不支持搜索`);
      return { provider: provider.id, query, tracks: await provider.search(query) };
    }
    case "preview": {
      const input = args.values[0];
      if (!input) throw new Error("请提供来源链接");
      const provider = providerForInput(input, args.provider);
      return { provider: provider.id, ...(await provider.previewSource(input)) };
    }
    case "import": {
      const input = args.values[0];
      if (!input) throw new Error("请提供来源链接");
      const provider = providerForInput(input, args.provider);
      return { provider: provider.id, ...(await provider.importSource(input)) };
    }
    case "sync": {
      const id = numberArg(args.values[0], "歌单 ID");
      const playlist = listPlaylists().find((item) => item.id === id);
      if (!playlist) throw new Error("歌单不存在");
      return { provider: playlist.provider, ...(await getProvider(playlist.provider).syncPlaylist(id)) };
    }
    case "library": return { tracks: listTracks(), playlists: listPlaylists() };
    case "playlist": {
      const id = numberArg(args.values[0], "歌单 ID");
      return { playlist: listPlaylists().find((item) => item.id === id) || null, tracks: playlistTracks(id) };
    }
    case "track": return { track: getTrack(numberArg(args.values[0], "曲目 ID")) || null };
    case "audio": {
      const track = getTrack(numberArg(args.values[0], "曲目 ID"));
      if (!track) throw new Error("曲目不存在");
      const source = await getProvider(track.source.provider).resolveAudio(track.source);
      return { track: { id: track.id, title: track.title, provider: track.source.provider }, source };
    }
    case "lyrics": {
      const track = getTrack(numberArg(args.values[0], "曲目 ID"));
      if (!track) throw new Error("曲目不存在");
      return { track: { id: track.id, title: track.title, provider: track.source.provider }, lyrics: await getProvider(track.source.provider).resolveLyrics(track.source) };
    }
    default: throw new Error(usage());
  }
}

const args = parseArgs(process.argv.slice(2));
run(args).then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
