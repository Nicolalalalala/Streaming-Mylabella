# Site Listing Agent

Routine locale per aggiungere siti al catalogo Stremio `Streaming Mylabella` senza interpretare il contenuto.

## Scopo
Dato un URL pubblico, lo script scarica l'HTML, estrae fedelmente i link e aggiorna il JSON usato dal Worker Stremio.

Non fa classificazione semantica. Non decide cosa sia "interessante". Prende link e basta, come una ruspa con un parser HTML.

## Path

- Script: `/home/ai-brain/site-listing-agent/list_site_links.py`
- Output Worker: `/home/ai-brain/software-dev-channel/repos/streaming-mylabella-worker/data/site-listings.json`
- Logs: `/home/ai-brain/site-listing-agent/logs/`

## Uso

Preview senza scrivere:

```bash
/home/ai-brain/site-listing-agent/list_site_links.py \
  --preview \
  --site-name example \
  --url 'https://example.com'
```

Scrittura nel listing Stremio:

```bash
/home/ai-brain/site-listing-agent/list_site_links.py \
  --site-name example \
  --url 'https://example.com'
```

Poi nel repo Worker:

```bash
cd /home/ai-brain/software-dev-channel/repos/streaming-mylabella-worker
npm run lint
git add data/site-listings.json
git commit -m "Aggiunto listing sito example"
git push
```

Deploy dal laptop:

```bash
git pull
npx wrangler deploy
```

## Formato richiesta Discord

```text
sito: https://example.com
nome: example
```

## Regole

- Content-blind: usare solo URL, link text e path del link.
- Non bypassare login, paywall, DRM, CAPTCHA o challenge interattive.
- Link streamabili: `.m3u8`, `.mp4`, `.webm`, `.mov`, `.mkv`, `.avi`, `.mpd`.
- Link pagina: tutto il resto.
