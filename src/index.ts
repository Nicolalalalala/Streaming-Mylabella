/**
 * Streaming Mylabella — Addon Stremio per IPTV e listing siti su Cloudflare Workers.
 * Serverless, multi-utente, filtri: Consigliati + Categoria + Siti.
 */

import { parseM3U, urlToId, idToUrl, type Canale } from "./m3u";
import siteListings from "../data/site-listings.json";
import blockedStreams from "../data/blocked-streams.json";

const ADDON_ID = "org.streaming-mylabella";
const RECOMMENDED_CATALOG_ID = "streaming-mylabella-consigliati";
const CATALOG_ID = "streaming-mylabella";
const SITE_CATALOG_ID = "streaming-mylabella-sites";
const ID_PREFIX = "mylabella-";
const SITE_ID_PREFIX = "site-";

const IPTV_API = "https://iptv-org.github.io/api";
const M3U_BASE =
  "https://raw.githubusercontent.com/iptv-org/iptv/master/streams";
const FAMELACK_IT_URL =
  "https://raw.githubusercontent.com/famelack/famelack-data/main/tv/raw/countries/it.json";
const DEFAULT_TV_POSTER = "https://img.icons8.com/color/96/tv.png";
const DEFAULT_SITE_POSTER = "https://img.icons8.com/color/96/link.png";

const DEFAULT_COUNTRY = "it";
const NON_ITALY_MESSAGE = "Non disponibile in Italia - Try Finger But Hole";

const CANALI_CONSIGLIATI: Array<{ name: string; aliases: string[] }> = [
  { name: "Rai 1", aliases: ["Rai 1", "Rai 1 HD", "Rai 1 (Geo)"] },
  { name: "Rai 2", aliases: ["Rai 2", "Rai 2 HD"] },
  { name: "Rai 3", aliases: ["Rai 3", "Rai 3 HD"] },
  { name: "Rete 4", aliases: ["Rete 4"] },
  { name: "Canale 5", aliases: ["Canale 5"] },
  { name: "Italia 1", aliases: ["Italia 1"] },
  { name: "LA7", aliases: ["LA7", "La7"] },
  { name: "TV8", aliases: ["TV8"] },
  { name: "NOVE", aliases: ["NOVE", "Nove"] },
];

// ─── Utenti ────────────────────────────────────────────
// Aggiungere nomi qui. Poi ridistribuire con `npx wrangler deploy`.
// URL Stremio: https://streaming.mylabella.it/<utente>/manifest.json

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

function estraiUtente(path: string): string | null {
  const match = path.match(/^\/([a-zA-Z0-9_-]+)(\/|$)/);
  return match ? match[1] : null;
}

function rimuoviUtente(path: string, utente: string): string {
  const prefix = "/" + utente;
  if (path === prefix) return "/";
  return path.slice(prefix.length);
}

// ─── Tipi listing siti ─────────────────────────────────

type SiteItem = {
  title: string;
  url: string;
  kind: "stream" | "page" | "external";
  source: string;
};

type SiteListing = {
  name: string;
  sourceUrl: string;
  finalUrl?: string;
  updatedAt: string;
  counts: Record<string, number>;
  items: SiteItem[];
};

type SiteListingFile = {
  version: number;
  sites: Record<string, SiteListing>;
};

type BlockedStreamsFile = {
  version: number;
  blockedUrls: string[];
};

type FamelackChannel = {
  nanoid?: string;
  name: string;
  sources?: { streams?: string[] };
  languages?: string[];
  country?: string;
  isGeoBlocked?: boolean;
};

const SITE_LISTINGS = siteListings as SiteListingFile;
const BLOCKED_STREAMS = new Set((blockedStreams as BlockedStreamsFile).blockedUrls);

// ─── Cache categorie/loghi ─────────────────────────────

type CategoriaMap = Map<string, string[]>;
type LogoMap = Map<string, string>;

let categoriaCache: CategoriaMap | null = null;
let categoriaPromise: Promise<CategoriaMap> | null = null;
let logoCache: LogoMap | null = null;
let logoPromise: Promise<LogoMap> | null = null;

/** Mappa nomi categoria inglese → italiano. */
const NOMI_CATEGORIE: Record<string, string> = {
  news: "Notizie",
  sports: "Sport",
  music: "Musica",
  movies: "Film",
  entertainment: "Intrattenimento",
  kids: "Bambini",
  documentary: "Documentari",
  general: "Generalista",
  business: "Economia",
  culture: "Cultura",
  education: "Educazione",
  family: "Famiglia",
  cooking: "Cucina",
  travel: "Viaggi",
  science: "Scienza",
  lifestyle: "Stile di vita",
  religious: "Religione",
  weather: "Meteo",
  auto: "Motori",
  animation: "Animazione",
  classic: "Classica",
  comedy: "Commedia",
  series: "Serie TV",
  shop: "Shopping",
  outdoor: "Outdoor",
  relax: "Relax",
  public: "Pubblico",
  legislative: "Politica",
  interactive: "Interattivo",
  xxx: "XXX",
};

/** Mappa inversa: nome italiano → chiave inglese. */
const CAT_IT_TO_EN: Record<string, string> = {};
for (const [en, it] of Object.entries(NOMI_CATEGORIE)) {
  CAT_IT_TO_EN[it.toLowerCase()] = en;
}

async function caricaCategorie(): Promise<CategoriaMap> {
  if (categoriaCache) return categoriaCache;
  if (categoriaPromise) {
    try { return await categoriaPromise; } catch { /* riprova */ }
  }

  categoriaPromise = (async () => {
    const resp = await fetch(`${IPTV_API}/channels.json`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const canali = (await resp.json()) as Array<{
      id: string; categories: string[];
    }>;
    const map: CategoriaMap = new Map();
    for (const c of canali) {
      if (c.categories?.length) map.set(c.id, c.categories);
    }
    categoriaCache = map;
    return map;
  })();

  try { return await categoriaPromise; } catch {
    categoriaPromise = null;
    return new Map();
  }
}

async function caricaLoghi(): Promise<LogoMap> {
  if (logoCache) return logoCache;
  if (logoPromise) {
    try { return await logoPromise; } catch { /* riprova */ }
  }

  logoPromise = (async () => {
    const resp = await fetch(`${IPTV_API}/logos.json`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const loghi = (await resp.json()) as Array<{
      channel: string;
      in_use?: boolean;
      format?: string;
      url: string;
    }>;
    const map: LogoMap = new Map();

    for (const logo of loghi) {
      if (!logo.channel || !logo.url) continue;
      const format = logo.format?.toLowerCase();
      const isRaster = !format || ["png", "jpg", "jpeg", "webp"].includes(format);
      if (!map.has(logo.channel) && logo.in_use && isRaster) {
        map.set(logo.channel, logo.url);
      }
    }

    for (const logo of loghi) {
      if (!logo.channel || !logo.url || map.has(logo.channel)) continue;
      map.set(logo.channel, logo.url);
    }

    logoCache = map;
    return map;
  })();

  try { return await logoPromise; } catch {
    logoPromise = null;
    return new Map();
  }
}

// ─── Helpers ──────────────────────────────────────────

function normalizzaTvgId(tvgId?: string): string | null {
  if (!tvgId) return null;
  return tvgId.replace(/@[A-Za-z0-9]+$/, "");
}

function logoCanale(canale: Canale, loghi: LogoMap): string {
  const tvgId = normalizzaTvgId(canale.tvgId);
  return (tvgId && loghi.get(tvgId)) || DEFAULT_TV_POSTER;
}

function fonteLabel(canale: Canale): string {
  return canale.fonte === "famelack" ? "Famelack" : "iptv-org";
}

function faviconDaUrl(value: string): string {
  try {
    const host = new URL(value).hostname;
    if (!host) return DEFAULT_SITE_POSTER;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`;
  } catch {
    return DEFAULT_SITE_POSTER;
  }
}

function canaleToMeta(canale: Canale, loghi: LogoMap): Record<string, unknown> {
  const id = ID_PREFIX + urlToId(canale.url);
  let nomeCompleto = canale.nome;
  if (canale.qualita) nomeCompleto += ` (${canale.qualita})`;
  if (canale.geoBlocked) nomeCompleto += " [Geo-blocked]";
  const poster = logoCanale(canale, loghi);
  return {
    id, type: "tv", name: nomeCompleto,
    poster,
    logo: poster,
    description: [canale.tvgId, fonteLabel(canale)].filter(Boolean).join(" · "),
  };
}

function siteItemToMeta(siteName: string, item: SiteItem): Record<string, unknown> {
  const id = SITE_ID_PREFIX + urlToId(item.url);
  const badge = item.kind === "stream" ? "stream" : "page";
  const poster = faviconDaUrl(item.url);
  return {
    id,
    type: "tv",
    name: `[${badge}] ${item.title}`,
    poster,
    logo: poster,
    description: `${siteName} · ${item.kind} · ${item.url}`,
    behaviorHints: { defaultVideoId: id },
  };
}

function isDirectStreamUrl(value: string): boolean {
  try {
    const path = new URL(value).pathname.toLowerCase();
    return [".m3u8", ".mp4", ".webm", ".mov", ".mkv", ".avi", ".mpd"].some((ext) =>
      path.endsWith(ext)
    );
  } catch {
    return false;
  }
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

async function caricaCanaliIptvOrg(): Promise<Canale[]> {
  const m3uUrl = `${M3U_BASE}/${DEFAULT_COUNTRY}.m3u`;
  const m3uResp = await fetch(m3uUrl);
  if (!m3uResp.ok) throw new Error(`Catalogo Italia non trovato: HTTP ${m3uResp.status}`);
  const contenuto = await m3uResp.text();
  return parseM3U(contenuto)
    .filter((c) => !BLOCKED_STREAMS.has(c.url))
    .map((c) => ({ ...c, fonte: "iptv-org" as const, country: "it" }));
}

async function caricaCanaliFamelack(): Promise<Canale[]> {
  const resp = await fetch(FAMELACK_IT_URL);
  if (!resp.ok) throw new Error(`Famelack Italia non trovato: HTTP ${resp.status}`);
  const payload = (await resp.json()) as FamelackChannel[];
  const canali: Canale[] = [];
  for (const item of payload) {
    const streams = item.sources?.streams ?? [];
    for (const streamUrl of streams) {
      if (!streamUrl || BLOCKED_STREAMS.has(streamUrl)) continue;
      canali.push({
        nome: item.name,
        url: streamUrl,
        tvgId: item.nanoid ? `famelack:${item.nanoid}` : undefined,
        geoBlocked: Boolean(item.isGeoBlocked),
        flags: item.isGeoBlocked ? ["Geo-blocked"] : [],
        fonte: "famelack",
        languages: item.languages ?? [],
        country: item.country,
      });
    }
  }
  return canali;
}

function normalizzaNomeCanale(nome: string): string {
  return nome
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(hd|fhd|uhd|4k|sd)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function qualityScore(qualita?: string): number {
  if (!qualita) return 0;
  const match = qualita.match(/(\d+)p/);
  return match ? Math.min(Number(match[1]) / 10, 120) : 0;
}

function scoreCanale(canale: Canale): number {
  let score = 0;
  if ((canale.country ?? "it").toLowerCase() === "it") score += 30;
  if (canale.languages?.includes("ita")) score += 25;
  if (!canale.geoBlocked) score += 15;
  if (canale.url.startsWith("https://")) score += 10;
  if (canale.url.toLowerCase().includes(".m3u8")) score += 10;
  score += qualityScore(canale.qualita);
  // iptv-org porta metadati/loghi/categorie migliori; Famelack allarga la copertura.
  if (canale.fonte === "iptv-org") score += 5;
  return score;
}

function scegliMiglioriCanali(canali: Canale[]): Canale[] {
  const byName = new Map<string, Canale>();
  for (const canale of canali) {
    const key = normalizzaNomeCanale(canale.nome);
    if (!key) continue;
    const current = byName.get(key);
    if (!current || scoreCanale(canale) > scoreCanale(current)) {
      byName.set(key, canale);
    }
  }
  return [...byName.values()].sort((a, b) => a.nome.localeCompare(b.nome, "it"));
}

async function caricaCanaliItaliani(): Promise<Canale[]> {
  const [iptvResult, famelackResult] = await Promise.allSettled([
    caricaCanaliIptvOrg(),
    caricaCanaliFamelack(),
  ]);
  const canali: Canale[] = [];
  if (iptvResult.status === "fulfilled") canali.push(...iptvResult.value);
  if (famelackResult.status === "fulfilled") canali.push(...famelackResult.value);
  if (!canali.length) {
    const errors = [iptvResult, famelackResult]
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => String(r.reason));
    throw new Error(errors.join("; ") || "Nessun canale italiano disponibile");
  }
  return scegliMiglioriCanali(canali);
}

// ─── Manifest ─────────────────────────────────────────

async function manifesto(): Promise<Response> {
  const opzioniCategoria = Object.values(NOMI_CATEGORIE);
  const opzioniSito = Object.keys(SITE_LISTINGS.sites).sort((a, b) =>
    a.localeCompare(b, "it")
  );

  return jsonResponse({
    id: ADDON_ID,
    name: "Streaming Mylabella",
    version: "2.2.0",
    description: "Canali IPTV da iptv-org + Famelack e listing siti — Cloudflare Workers.",
    logo: DEFAULT_TV_POSTER,
    resources: ["catalog", "stream", "meta"],
    types: ["tv"],
    catalogs: [
      {
        type: "tv",
        id: RECOMMENDED_CATALOG_ID,
        name: "Streaming Mylabella — Consigliati",
      },
      {
        type: "tv",
        id: CATALOG_ID,
        name: "Streaming Mylabella — Italiani",
        extra: [
          { name: "genre", options: opzioniCategoria, isRequired: false },
        ],
      },
      {
        type: "tv",
        id: SITE_CATALOG_ID,
        name: "Streaming Mylabella — Siti",
        extra: [
          { name: "sito", options: opzioniSito, isRequired: false },
        ],
      },
    ],
    idPrefixes: [ID_PREFIX, SITE_ID_PREFIX],
  });
}

// ─── Catalog ──────────────────────────────────────────

function parseExtras(path: string): Record<string, string> {
  const extras: Record<string, string> = {};
  const re = /([a-z]+)=([^/\\.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    extras[m[1]] = decodeURIComponent(m[2]);
  }
  return extras;
}

async function catalogo(
  categoria: string | null
): Promise<Response> {
  let canali: Canale[];
  let catMap: CategoriaMap;
  let loghi: LogoMap;
  try {
    [canali, catMap, loghi] = await Promise.all([
      caricaCanaliItaliani(),
      caricaCategorie(),
      caricaLoghi(),
    ]);
  } catch (e) {
    return jsonResponse({ error: `Errore: ${e}` }, 502);
  }

  // Filtra per categoria. Famelack non espone categorie: resta nel catalogo
  // principale e nei consigliati, mentre i cataloghi di categoria usano iptv-org.
  if (categoria && catMap.size > 0) {
    const catKey =
      CAT_IT_TO_EN[categoria.toLowerCase()] ??  // "Sport" → "sports"
      categoria.toLowerCase();                    // già in inglese

    canali = canali.filter((c) => {
      const idRaw = normalizzaTvgId(c.tvgId);
      if (!idRaw) return false;
      const cats = catMap.get(idRaw) ?? catMap.get(c.tvgId ?? "");
      return cats?.includes(catKey);
    });
  }

  return jsonResponse({ metas: canali.map((canale) => canaleToMeta(canale, loghi)) });
}

async function catalogoConsigliati(): Promise<Response> {
  let canali: Canale[];
  let loghi: LogoMap;
  try {
    [canali, loghi] = await Promise.all([
      caricaCanaliItaliani(),
      caricaLoghi(),
    ]);
  } catch (e) {
    return jsonResponse({ error: `Errore: ${e}` }, 502);
  }

  const canaliPerNome = new Map<string, Canale[]>();
  for (const canale of canali) {
    const key = normalizzaNomeCanale(canale.nome);
    const gruppo = canaliPerNome.get(key) ?? [];
    gruppo.push(canale);
    canaliPerNome.set(key, gruppo);
  }

  const consigliati: Canale[] = [];
  const urlsUsati = new Set<string>();
  for (const voce of CANALI_CONSIGLIATI) {
    const candidato = voce.aliases
      .flatMap((alias) => canaliPerNome.get(normalizzaNomeCanale(alias)) ?? [])
      .filter((canale) => !urlsUsati.has(canale.url))
      .sort((a, b) => scoreCanale(b) - scoreCanale(a))[0];
    if (!candidato) continue;
    urlsUsati.add(candidato.url);
    consigliati.push({ ...candidato, nome: voce.name });
  }

  return jsonResponse({ metas: consigliati.map((canale) => canaleToMeta(canale, loghi)) });
}

function catalogoSiti(sito: string | null): Response {
  const entries = Object.entries(SITE_LISTINGS.sites).sort(([a], [b]) =>
    a.localeCompare(b, "it")
  );
  const selected = sito ? entries.filter(([name]) => name === sito) : entries;
  const metas = selected.flatMap(([siteName, listing]) =>
    listing.items.map((item) => siteItemToMeta(siteName, item))
  );
  return jsonResponse({ metas });
}

// ─── Stream & Meta ────────────────────────────────────

async function streamHandler(id: string): Promise<Response> {
  if (id.startsWith(SITE_ID_PREFIX)) {
    const raw = id.slice(SITE_ID_PREFIX.length);
    let url: string;
    try { url = idToUrl(raw); } catch {
      return jsonResponse({ error: "ID sito non valido" }, 404);
    }
    if (isDirectStreamUrl(url)) {
      return jsonResponse({
        streams: [
          { title: "Stream diretto", url, behaviorHints: { notWebReady: false } },
        ],
      });
    }
    return jsonResponse({
      streams: [
        { title: "Apri pagina esterna", externalUrl: url },
      ],
    });
  }

  if (!id.startsWith(ID_PREFIX)) {
    return jsonResponse({ error: "ID non valido" }, 404);
  }
  const raw = id.slice(ID_PREFIX.length);
  let url: string;
  try { url = idToUrl(raw); } catch {
    return jsonResponse({ error: "ID canale non valido" }, 404);
  }
  return jsonResponse({
    streams: [
      { title: "M3U8 (diretto)", url, behaviorHints: { notWebReady: false } },
    ],
  });
}

async function metaHandler(id: string): Promise<Response> {
  if (id.startsWith(SITE_ID_PREFIX)) {
    const raw = id.slice(SITE_ID_PREFIX.length);
    let url: string;
    try { url = idToUrl(raw); } catch {
      return jsonResponse({ error: "ID sito non valido" }, 404);
    }
    const poster = faviconDaUrl(url);
    return jsonResponse({
      meta: { id, type: "tv", name: "Link sito", poster, logo: poster, description: url },
    });
  }

  if (!id.startsWith(ID_PREFIX)) {
    return jsonResponse({ error: "ID non valido" }, 404);
  }
  const raw = id.slice(ID_PREFIX.length);
  let url: string;
  try { url = idToUrl(raw); } catch {
    return jsonResponse({ error: "ID canale non valido" }, 404);
  }
  return jsonResponse({
    meta: { id, type: "tv", name: "Canale TV", description: url },
  });
}

// ─── Router ───────────────────────────────────────────

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const rawPath = url.pathname;

    const utente = estraiUtente(rawPath);
    if (!utente || !UTENTI.has(utente)) {
      return jsonResponse({ error: "Utente non riconosciuto." }, 403);
    }

    const path = rimuoviUtente(rawPath, utente);

    if (path === "/manifest.json") return manifesto();

    // /catalog/tv/streaming-mylabella-consigliati.json
    if (path === `/catalog/tv/${RECOMMENDED_CATALOG_ID}.json`) {
      return catalogoConsigliati();
    }

    // /catalog/tv/streaming-mylabella(.json|/genre=X.json)
    // Compat legacy: se Stremio ha in cache /paese=it.json, lo accettiamo ma ignoriamo il paese.
    const catalogMatch = path.match(
      /^\/catalog\/tv\/streaming-mylabella(\.json|\/(?:genre=[^/]+|paese=it)(?:\/(?:genre=[^/]+|paese=it))?\.json)$/
    );
    if (catalogMatch) {
      const extras = parseExtras(path);
      return catalogo(extras["genre"] || null);
    }

    const unsupportedCountryCatalogMatch = path.match(
      /^\/catalog\/tv\/streaming-mylabella\/(?:.*\/)?paese=(?!it)[a-z]{2}\.json$/
    );
    if (unsupportedCountryCatalogMatch) {
      return jsonResponse({ error: NON_ITALY_MESSAGE }, 404);
    }

    // /catalog/tv/streaming-mylabella-sites(.json|/sito=X.json)
    const siteCatalogMatch = path.match(
      /^\/catalog\/tv\/streaming-mylabella-sites(\.json|\/sito=[^/\\.]+\.json)$/
    );
    if (siteCatalogMatch) {
      const extras = parseExtras(path);
      return catalogoSiti(extras["sito"] || null);
    }

    const streamMatch = path.match(/^\/stream\/tv\/(.+\.json)$/);
    if (streamMatch) {
      return streamHandler(streamMatch[1].replace(/\.json$/, ""));
    }

    const metaMatch = path.match(/^\/meta\/tv\/(.+\.json)$/);
    if (metaMatch) {
      return metaHandler(metaMatch[1].replace(/\.json$/, ""));
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};
