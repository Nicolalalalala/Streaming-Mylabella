# Streaming Mylabella — Cloudflare Workers

Addon Stremio per canali IPTV italiani da [iptv-org/iptv](https://github.com/iptv-org/iptv) e listing link da siti pubblici.
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
https://streaming.mylabella.it/<utente>/manifest.json
```

Da PC: apri Stremio → Addon → aggiungi un nuovo addon usando quell'URL.

Da Android/iPhone/iPad non si può aggiungere direttamente un addon via URL. Va fatto da PC: crea/configura l'utente lì, installa l'addon, poi fai login sull'app mobile con lo stesso account Stremio. La configurazione resta condivisa.

## Utenti

Gli utenti abilitati sono definiti in `src/index.ts`:

```ts
const UTENTI = new Set([
  "simonefratello",
  "simonemongelli",
  "gioele",
  "sergio",
  "alardi",
  "antonino",
  "alex",
  "nicola",
  "casa",
]);
```

Per aggiungerne uno, inserisci il nome nella lista e fai deploy.
Esempio: `https://streaming.mylabella.it/mario/manifest.json`.

## Verifica e filtro canali IPTV

Il catalogo IPTV usa solo `streams/it.m3u`. Non espone il filtro paese nel manifest; eventuali vecchi URL con paesi diversi da `it` rispondono con `Non disponibile in Italia - Try Finger But Hole`.

Il catalogo `Streaming Mylabella — Consigliati` mostra, in ordine, i canali principali da Rai 1 a NOVE quando esiste uno stream non blacklistato:

```text
Rai 1, Rai 2, Rai 3, Rete 4, Canale 5, Italia 1, LA7, TV8, NOVE
```

Se un canale consigliato ha solo stream verificati rotti, viene omesso invece di mostrare un placeholder inutile.

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

La blacklist va aggiornata solo dopo verifica reale degli stream. Non usare blocchi AGCOM/ISP locali come motivo di blacklist globale: `ai-brain` verifica dall'Italia, ma chi guarda può essere all'estero. Niente tagli sulla fiducia: già basta IPTV-org a fare archeologia digitale.

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
| `/<utente>/catalog/tv/streaming-mylabella-consigliati.json` | Canali consigliati Rai 1 → NOVE, solo se disponibili |
| `/<utente>/catalog/tv/streaming-mylabella.json` | Catalog IPTV italiano: tutte le categorie |
| `/<utente>/catalog/tv/streaming-mylabella/genre=Sport.json` | Canali IPTV per categoria |
| `/<utente>/catalog/tv/streaming-mylabella-sites.json` | Tutti i link dai siti indicizzati |
| `/<utente>/catalog/tv/streaming-mylabella-sites/sito=example.json` | Link del singolo sito |
| `/<utente>/stream/tv/<id>.json` | Stream diretto o pagina esterna |
| `/<utente>/meta/tv/<id>.json` | Metadati item |
