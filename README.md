# 回声仓 · EchoCrate

一个可自托管、可离线、多来源的个人音乐 PWA。回声仓把你有权访问的声音来源整理成统一音乐库，并允许将选定曲目保存到浏览器本地，断网后继续播放。

> Bilibili 是首个内置 Provider；它不是产品品牌，也不是项目唯一支持的来源。

## 特性

- Android 优先的可安装 PWA、Media Session、播放队列、歌词、倍速和睡眠定时
- OPFS 本地音频缓存、下载恢复、浏览器存储配额监测与自动清理
- Provider 架构：来源登录、导入、音频解析、歌词解析相互独立
- 内置 Bilibili Provider：扫码登录、BV 视频、收藏夹、空间合集和分 P
- SQLite 音乐库；Bilibili 临时音频地址按需刷新并通过支持 Range 的代理播放
- Docker Compose 一键部署；默认仅监听 `127.0.0.1:8787`

## 来源 Provider

Provider 实现统一的 `MusicProvider` 接口，并按能力声明是否支持登录、导入、播放和歌词。当前可用：

| Provider | 登录 | 导入 | 播放 | 歌词 |
| --- | --- | --- | --- | --- |
| Bilibili | 扫码 | 收藏夹、合集、视频 | 是 | 字幕 |

规划中的 Provider：本地文件、WebDAV、Navidrome/Jellyfin/Subsonic。贡献者可以在 `server/providers.ts` 注册新 Provider；Provider 不得绕过来源权限、导出受限音频或把用户凭据暴露给浏览器。

## 本地开发

```bash
npm install
npm run dev
```

后端监听 `http://127.0.0.1:8787`。前端热更新可另开终端运行 `npm run dev:client`。

## 部署

```bash
cp .env.example .env
docker compose up -d --build
```

服务会自动生成权限为 `0600` 的会话加密密钥；也可通过 `ECHOCRATE_SECRET` 提供 32 字节十六进制密钥。反向代理、域名、认证机制由部署者自行选择；Cloudflare Access 是可选方案，不是运行依赖。

从早期 Bilibili Music 版本升级时，服务会继续使用已有 `bilimusic.sqlite` 数据库，并自动添加通用 Provider 字段；新安装使用 `echocrate.sqlite`。

## 数据与边界

- 服务端只保存音乐库、历史、加密会话与来源引用，不建立音频仓库。
- 离线音频保存在每台设备的浏览器 OPFS/Cache Storage 中，不作为普通下载文件暴露。
- 请仅导入自己有权访问的内容。本项目不提供音频导出、公开分享或绕过来源权限的功能。

## 开源协作

提交前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [SECURITY.md](SECURITY.md)。项目采用 Apache-2.0 许可证。
