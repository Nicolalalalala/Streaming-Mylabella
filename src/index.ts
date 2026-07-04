/**
 * Streaming Mylabella — Addon Stremio per IPTV e listing siti su Cloudflare Workers.
 * Serverless, multi-utente, filtri: Categoria → Paese + Siti.
 */

import { parseM3U, urlToId, idToUrl, type Canale } from "./m3u";
import siteListings from "../data/site-listings.json";
import blockedStreams from "../data/blocked-streams.json";

const ADDON_ID = "org.streaming-mylabella";
const CATALOG_ID = "streaming-mylabella";
const SITE_CATALOG_ID = "streaming-mylabella-sites";
const ID_PREFIX = "mylabella-";
const SITE_ID_PREFIX = "site-";

const IPTV_API = "https://iptv-org.github.io/api";
const M3U_BASE =
  "https://raw.githubusercontent.com/iptv-org/iptv/master/streams";

const DEFAULT_COUNTRY = "it";

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

const SITE_LISTINGS = siteListings as SiteListingFile;
const BLOCKED_STREAMS = new Set((blockedStreams as BlockedStreamsFile).blockedUrls);

// ─── Cache categorie ───────────────────────────────────

type CategoriaMap = Map<string, string[]>;

let categoriaCache: CategoriaMap | null = null;
let categoriaPromise: Promise<CategoriaMap> | null = null;

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

// ─── Helpers ──────────────────────────────────────────

function canaleToMeta(canale: Canale): Record<string, unknown> {
  const id = ID_PREFIX + urlToId(canale.url);
  let nomeCompleto = canale.nome;
  if (canale.qualita) nomeCompleto += ` (${canale.qualita})`;
  if (canale.geoBlocked) nomeCompleto += " [Geo-blocked]";
  return {
    id, type: "tv", name: nomeCompleto,
    poster: "https://img.icons8.com/color/96/tv.png",
    description: canale.tvgId || "",
  };
}

function siteItemToMeta(siteName: string, item: SiteItem): Record<string, unknown> {
  const id = SITE_ID_PREFIX + urlToId(item.url);
  const badge = item.kind === "stream" ? "stream" : "page";
  return {
    id,
    type: "tv",
    name: `[${badge}] ${item.title}`,
    poster: "https://img.icons8.com/color/96/link.png",
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

// ─── Manifest ─────────────────────────────────────────

async function manifesto(): Promise<Response> {
  let opzioniPaese: string[] = ["it", "us", "gb", "fr", "de", "es"];
  try {
    const resp = await fetch(`${IPTV_API}/countries.json`);
    if (resp.ok) {
      const paesi = (await resp.json()) as Array<{ code: string }>;
      opzioniPaese = paesi.map((p) => p.code.toLowerCase());
    }
  } catch { /* fallback */ }

  const opzioniCategoria = Object.values(NOMI_CATEGORIE);
  const opzioniSito = Object.keys(SITE_LISTINGS.sites).sort((a, b) =>
    a.localeCompare(b, "it")
  );

  return jsonResponse({
    id: ADDON_ID,
    name: "Streaming Mylabella",
    version: "2.1.0",
    description: "Canali IPTV da iptv-org e listing siti — Cloudflare Workers.",
    logo: "https://img.icons8.com/color/96/tv.png",
    resources: ["catalog", "stream", "meta"],
    types: ["tv"],
    catalogs: [
      {
        type: "tv",
        id: CATALOG_ID,
        name: "Streaming Mylabella",
        extra: [
          { name: "genre", options: opzioniCategoria, isRequired: false },
          { name: "paese", options: opzioniPaese, isRequired: false },
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
  categoria: string | null,
  paese: string | null
): Promise<Response> {
  const codice = paese || DEFAULT_COUNTRY;
  const m3uUrl = `${M3U_BASE}/${codice}.m3u`;

  let contenuto: string;
  let catMap: CategoriaMap;
  try {
    const [m3uResp] = await Promise.all([
      fetch(m3uUrl),
      caricaCategorie(),
    ]);
    if (!m3uResp.ok) {
      return jsonResponse({ error: `Paese '${codice}' non trovato` }, 404);
    }
    contenuto = await m3uResp.text();
    catMap = categoriaCache ?? new Map();
  } catch (e) {
    return jsonResponse({ error: `Errore: ${e}` }, 502);
  }

  let canali = parseM3U(contenuto);
  canali = canali.filter((c) => !BLOCKED_STREAMS.has(c.url));

  // Filtra per categoria
  if (categoria && catMap.size > 0) {
    const catKey =
      CAT_IT_TO_EN[categoria.toLowerCase()] ??  // "Sport" → "sports"
      categoria.toLowerCase();                    // già in inglese

    canali = canali.filter((c) => {
      if (!c.tvgId) return false;
      const idRaw = c.tvgId.replace(/@[A-Za-z0-9]+$/, "");
      const cats = catMap.get(idRaw) ?? catMap.get(c.tvgId);
      return cats?.includes(catKey);
    });
  }

  canali.sort((a, b) => a.nome.localeCompare(b.nome, "it"));

  return jsonResponse({ metas: canali.map(canaleToMeta) });
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
    return jsonResponse({
      meta: { id, type: "tv", name: "Link sito", description: url },
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

    // /catalog/tv/streaming-mylabella(.json|/genre=X.json|/genre=X/paese=YY.json|...)
    const catalogMatch = path.match(
      /^\/catalog\/tv\/streaming-mylabella(\.json|\/(?:genre=[^/]+|paese=[a-z]{2})(?:\/(?:genre=[^/]+|paese=[a-z]{2}))?\.json)$/
    );
    if (catalogMatch) {
      const extras = parseExtras(path);
      return catalogo(extras["genre"] || null, extras["paese"] || null);
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
