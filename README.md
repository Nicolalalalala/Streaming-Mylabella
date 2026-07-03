# Streaming Mylabella — Cloudflare Workers

Addon Stremio per canali IPTV da [iptv-org/iptv](https://github.com/iptv-org/iptv).
Serverless su Cloudflare Workers. Niente server locale, niente VPN.

Dominio: **streaming.mylabella.it**

## Sviluppo locale

```bash
npm install
npm run dev        # wrangler dev su :8787
```

## Deploy

```bash
npm run deploy     # wrangler deploy
```

Dopo il primo deploy, aggiungi il dominio custom su Cloudflare Dashboard:
Workers & Pages → streaming-mylabella → Settings → Domains & Routes → Add `streaming.mylabella.it`

Poi in Stremio aggiungi `https://streaming.mylabella.it/nicola/manifest.json`.

## Struttura

```
src/
├── index.ts        # Worker principale (router + endpoint Stremio)
└── m3u.ts          # Parser M3U
```

## Endpoint

| Path | Descrizione |
|---|---|
| `/manifest.json` | Manifest Stremio |
| `/catalog/tv/pezzotto-paesi.json` | Catalog default (Italia) |
| `/catalog/tv/pezzotto-paesi/genre=XX.json` | Canali per paese |
| `/stream/tv/pezzotto-{id}.json` | Stream M3U8 diretto |
| `/meta/tv/pezzotto-{id}.json` | Metadati canale |
