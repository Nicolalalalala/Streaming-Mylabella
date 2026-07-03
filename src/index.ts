/**
 * Streaming Mylabella — Addon Stremio per IPTV su Cloudflare Workers.
 * Serverless, pubblico, filtri: Categoria → Paese.
 */

import { parseM3U, urlToId, idToUrl, type Canale } from "./m3u";

const ADDON_ID = "org.streaming-mylabella";
const CATALOG_ID = "streaming-mylabella";
const ID_PREFIX = "mylabella-";

const IPTV_API = "https://iptv-org.github.io/api";
const M3U_BASE =
  "https://raw.githubusercontent.com/iptv-org/iptv/master/streams";

const DEFAULT_COUNTRY = "it";

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
        name: "Streaming Mylabella",
        extra: [
          { name: "genre", options: opzioniCategoria, isRequired: false },
          { name: "paese", options: opzioniPaese, isRequired: false },
        ],
      },
    ],
    idPrefixes: [ID_PREFIX],
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

// ─── Stream & Meta ────────────────────────────────────

async function streamHandler(id: string): Promise<Response> {
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
    const path = url.pathname;

    if (path === "/manifest.json") return manifesto();

    // /catalog/tv/streaming-mylabella(.json|/genre=X.json|/genre=X/paese=YY.json|...)
    const catalogMatch = path.match(
      /^\/catalog\/tv\/streaming-mylabella(\.json|\/(?:genre=[^/]+|paese=[a-z]{2})(?:\/(?:genre=[^/]+|paese=[a-z]{2}))?\.json)$/
    );
    if (catalogMatch) {
      const extras = parseExtras(path);
      return catalogo(extras["genre"] || null, extras["paese"] || null);
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
