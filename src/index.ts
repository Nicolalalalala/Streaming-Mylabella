/**
 * Streaming Mylabella — Addon Stremio per IPTV su Cloudflare Workers.
 * Serverless, multi-utente, con filtri per paese e categoria.
 */

import { parseM3U, urlToId, idToUrl, type Canale } from "./m3u";

const ADDON_ID = "org.pezzotto";
const CATALOG_ID = "pezzotto-paesi";

const IPTV_API = "https://iptv-org.github.io/api";
const M3U_BASE =
  "https://raw.githubusercontent.com/iptv-org/iptv/master/streams";

const DEFAULT_COUNTRY = "it";

// ─── Token ─────────────────────────────────────────────

const TOKENS = new Set([
  "nicola",
  // "amico1",
]);

function estraiToken(path: string): string | null {
  const match = path.match(/^\/([a-zA-Z0-9_-]+)(\/|$)/);
  return match ? match[1] : null;
}

function rimuoviToken(path: string, token: string): string {
  const prefix = "/" + token;
  if (path === prefix) return "/";
  return path.slice(prefix.length);
}

// ─── Cache categorie ───────────────────────────────────

type CategoriaMap = Map<string, string[]>; // tvg-id → categorie

let categoriaCache: CategoriaMap | null = null;
let categoriaPromise: Promise<CategoriaMap> | null = null;

/** Mappa i nomi categoria inglese → italiano per la UI Stremio. */
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

async function caricaCategorie(): Promise<CategoriaMap> {
  if (categoriaCache) return categoriaCache;

  if (categoriaPromise) {
    try {
      return await categoriaPromise;
    } catch {
      // riprova
    }
  }

  categoriaPromise = (async () => {
    const resp = await fetch(`${IPTV_API}/channels.json`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const canali = (await resp.json()) as Array<{
      id: string;
      categories: string[];
    }>;
    const map: CategoriaMap = new Map();
    for (const c of canali) {
      if (c.categories?.length) map.set(c.id, c.categories);
    }
    categoriaCache = map;
    return map;
  })();

  try {
    return await categoriaPromise;
  } catch {
    categoriaPromise = null;
    return new Map();
  }
}

// ─── Helpers ──────────────────────────────────────────

function canaleToMeta(canale: Canale): Record<string, unknown> {
  const id = "pezzotto-" + urlToId(canale.url);
  let nomeCompleto = canale.nome;
  if (canale.qualita) nomeCompleto += ` (${canale.qualita})`;
  if (canale.geoBlocked) nomeCompleto += " [Geo-blocked]";

  return {
    id,
    type: "tv",
    name: nomeCompleto,
    poster: "https://img.icons8.com/color/96/tv.png",
    description: canale.tvgId || "",
  };
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

  const opzioniCategoria = Object.keys(NOMI_CATEGORIE);

  return jsonResponse({
    id: ADDON_ID,
    name: "Streaming Mylabella",
    version: "2.0.0",
    description: "Canali IPTV da iptv-org — Cloudflare Workers.",
    logo: "https://img.icons8.com/color/96/tv.png",
    resources: ["catalog", "stream", "meta"],
    types: ["tv"],
    catalogs: [
      {
        type: "tv",
        id: CATALOG_ID,
        name: "Canali TV",
        extra: [
          { name: "genre", options: opzioniPaese, isRequired: false },
          { name: "category", options: opzioniCategoria, isRequired: false },
        ],
      },
    ],
    idPrefixes: ["pezzotto-"],
  });
}

// ─── Catalog ──────────────────────────────────────────

/** Estrae i parametri extra dal path (es. genre=it, category=sports). */
function parseExtras(path: string): Record<string, string> {
  const extras: Record<string, string> = {};
  const re = /([a-z]+)=([a-zA-Z0-9_-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    extras[m[1]] = m[2];
  }
  return extras;
}

async function catalogo(
  genre: string | null,
  category: string | null
): Promise<Response> {
  const codice = genre || DEFAULT_COUNTRY;
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

  // Filtra per categoria (se richiesta)
  if (category && catMap.size > 0) {
    const catKey =
      Object.entries(NOMI_CATEGORIE).find(
        ([, it]) => it.toLowerCase() === category.toLowerCase()
      )?.[0] ?? category;

    canali = canali.filter((c) => {
      if (!c.tvgId) return false;
      const idRaw = c.tvgId.replace(/@[A-Za-z0-9]+$/, "");
      const cats = catMap.get(idRaw) ?? catMap.get(c.tvgId);
      return cats?.includes(catKey);
    });
  }

  // Ordina alfabeticamente
  canali.sort((a, b) => a.nome.localeCompare(b.nome, "it"));

  return jsonResponse({ metas: canali.map(canaleToMeta) });
}

// ─── Stream & Meta ────────────────────────────────────

async function streamHandler(id: string): Promise<Response> {
  if (!id.startsWith("pezzotto-")) {
    return jsonResponse({ error: "ID non valido" }, 404);
  }
  const raw = id.slice("pezzotto-".length);
  let url: string;
  try { url = idToUrl(raw); } catch {
    return jsonResponse({ error: "ID canale non valido" }, 404);
  }
  return jsonResponse({
    streams: [
      {
        title: "M3U8 (diretto)",
        url,
        behaviorHints: { notWebReady: false },
      },
    ],
  });
}

async function metaHandler(id: string): Promise<Response> {
  if (!id.startsWith("pezzotto-")) {
    return jsonResponse({ error: "ID non valido" }, 404);
  }
  const raw = id.slice("pezzotto-".length);
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

    // Auth
    const token = estraiToken(rawPath);
    if (!token || !TOKENS.has(token)) {
      return jsonResponse(
        { error: "Accesso negato. Token mancante o non valido." },
        403
      );
    }

    const path = rimuoviToken(rawPath, token);

    // GET /manifest.json
    if (path === "/manifest.json") {
      return manifesto();
    }

    // GET /catalog/tv/pezzotto-paesi(.json|/genre=XX.json|/category=YY.json|/genre=XX/category=YY.json)
    const catalogMatch = path.match(
      /^\/catalog\/tv\/pezzotto-paesi(\.json|\/(?:genre=[a-z]{2}|category=[a-zA-Z0-9_-]+)(?:\/(?:genre=[a-z]{2}|category=[a-zA-Z0-9_-]+))?\.json)$/
    );
    if (catalogMatch) {
      const extras = parseExtras(path);
      const genre = extras["genre"] || null;
      const category = extras["category"] || null;
      return catalogo(genre, category);
    }

    // GET /stream/tv/{id}.json
    const streamMatch = path.match(/^\/stream\/tv\/(.+\.json)$/);
    if (streamMatch) {
      return streamHandler(streamMatch[1].replace(/\.json$/, ""));
    }

    // GET /meta/tv/{id}.json
    const metaMatch = path.match(/^\/meta\/tv\/(.+\.json)$/);
    if (metaMatch) {
      return metaHandler(metaMatch[1].replace(/\.json$/, ""));
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};
