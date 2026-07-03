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

Poi in Stremio aggiungi l'URL dell'utente:

```text
https://streaming.mylabella.it/nicola/manifest.json
```

## Utenti

Gli utenti abilitati sono definiti in `src/index.ts`:

```ts
const UTENTI = new Set([
  "nicola",
]);
```

Per aggiungerne uno, inserisci il nome nella lista e fai deploy.
Esempio: `https://streaming.mylabella.it/mario/manifest.json`.

## Struttura

```text
src/
├── index.ts        # Worker principale (router + endpoint Stremio)
└── m3u.ts          # Parser M3U
```

## Endpoint

Tutti gli endpoint passano dal prefisso utente `/<utente>`.

| Path | Descrizione |
|---|---|
| `/<utente>/manifest.json` | Manifest Stremio |
| `/<utente>/catalog/tv/streaming-mylabella.json` | Catalog default: Italia, tutte le categorie |
| `/<utente>/catalog/tv/streaming-mylabella/genre=Sport.json` | Canali per categoria |
| `/<utente>/catalog/tv/streaming-mylabella/genre=Sport/paese=it.json` | Canali per categoria e paese |
| `/<utente>/stream/tv/<id>.json` | Stream M3U8 diretto |
| `/<utente>/meta/tv/<id>.json` | Metadati canale |
