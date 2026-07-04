# #site-listing — aggiunta siti a Streaming Mylabella

Posta un sito così:

```text
sito: https://example.com
nome: example
```

Cosa succede:
1. Perry estrae i link pubblici dalla pagina in modalità content-blind.
2. Verifica e salva nel listing Stremio solo i link che rispondono davvero.
3. Dopo push/deploy compaiono nel catalogo `Streaming Mylabella — Siti`.

Regole:
- niente login/paywall/DRM/CAPTCHA;
- non interpretiamo il contenuto, listiamo i link;
- niente pagine di blocco/avviso tipo AGCOM: quelle si scartano, perché la burocrazia in Stremio anche no;
- `.m3u8`, `.mp4`, `.webm`, `.mov`, `.mkv`, `.avi`, `.mpd` diventano stream diretti;
- gli altri link sono pagine esterne e potrebbero non partire in Stremio.

URL Stremio utente:

```text
https://streaming.mylabella.it/nicola/manifest.json
```
