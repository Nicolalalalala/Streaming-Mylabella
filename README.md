# Streaming Mylabella — Cloudflare Workers

Addon Stremio per canali IPTV da [iptv-org/iptv](https://github.com/iptv-org/iptv) e listing link da siti pubblici.
Serverless su Cloudflare Workers. Niente server locale per Stremio, niente VPN.

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

## Verifica e filtro canali IPTV

I canali rotti verificati vengono filtrati da:

```text
data/blocked-streams.json
```

Per rigenerare il report Italia:

```bash
python3 scripts/verify_iptv_streams.py \
  --country it \
  --timeout 8 \
  --workers 32 \
  --output /home/ai-brain/site-listing-agent/logs/iptv-it-verify.json
```

La blacklist va aggiornata solo dopo verifica reale degli stream. Niente tagli sulla fiducia: già basta IPTV-org a fare archeologia digitale.

## Listing siti

I listing siti sono generati localmente dal `site-listing-agent` e salvati in:

```text
data/site-listings.json
```

Routine:

```bash
/home/ai-brain/site-listing-agent/list_site_links.py \
  --site-name example \
  --url 'https://example.com'
```

Poi:

```bash
npm run lint
git add data/site-listings.json
git commit -m "Aggiunto listing sito example"
git push
```

Dopo il deploy, i link compaiono nel catalogo Stremio `Streaming Mylabella — Siti`.

## Struttura

```text
src/
├── index.ts        # Worker principale (router + endpoint Stremio)
└── m3u.ts          # Parser M3U
data/
└── site-listings.json
```

## Endpoint

Tutti gli endpoint passano dal prefisso utente `/<utente>`.

| Path | Descrizione |
|---|---|
| `/<utente>/manifest.json` | Manifest Stremio |
| `/<utente>/catalog/tv/streaming-mylabella.json` | Catalog IPTV default: Italia, tutte le categorie |
| `/<utente>/catalog/tv/streaming-mylabella/genre=Sport.json` | Canali IPTV per categoria |
| `/<utente>/catalog/tv/streaming-mylabella/genre=Sport/paese=it.json` | Canali IPTV per categoria e paese |
| `/<utente>/catalog/tv/streaming-mylabella-sites.json` | Tutti i link dai siti indicizzati |
| `/<utente>/catalog/tv/streaming-mylabella-sites/sito=example.json` | Link del singolo sito |
| `/<utente>/stream/tv/<id>.json` | Stream diretto o pagina esterna |
| `/<utente>/meta/tv/<id>.json` | Metadati item |
