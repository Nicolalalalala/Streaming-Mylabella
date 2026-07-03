1|# Streaming Mylabella — Cloudflare Workers
2|
3|Addon Stremio per canali IPTV da [iptv-org/iptv](https://github.com/iptv-org/iptv).
4|Serverless su Cloudflare Workers. Niente server locale, niente VPN.
5|
6|Dominio: **streaming.mylabella.it**
7|
8|## Sviluppo locale
9|
10|```bash
11|npm install
12|npm run dev        # wrangler dev su :8787
13|```
14|
15|## Deploy
16|
17|```bash
18|npm run deploy     # wrangler deploy
19|```
20|
21|Dopo il primo deploy, aggiungi il dominio custom su Cloudflare Dashboard:
22|Workers & Pages → streaming-mylabella → Settings → Domains & Routes → Add `streaming.mylabella.it`
23|
24|Poi in Stremio aggiungi `https://streaming.mylabella.it/nicola/manifest.json`.
25|
26|## Struttura
27|
28|```
29|src/
30|├── index.ts        # Worker principale (router + endpoint Stremio)
31|└── m3u.ts          # Parser M3U
32|```
33|
34|## Endpoint
35|
36|| Path | Descrizione |
37||---|---|
38|| `/manifest.json` | Manifest Stremio |
39|| `/catalog/tv/streaming-mylabella-paesi.json` | Catalog default (Italia) |
40|| `/catalog/tv/streaming-mylabella-paesi/genre=XX.json` | Canali per paese |
41|| `/stream/tv/streaming-mylabella-{id}.json` | Stream M3U8 diretto |
42|| `/meta/tv/streaming-mylabella-{id}.json` | Metadati canale |
43|