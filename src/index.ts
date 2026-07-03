/**
 * Pezzotto Worker — Addon Stremio per IPTV su Cloudflare Workers.
 * Serverless, senza VPN, senza proxy. Solo metadati.
 * Supporto multi-utente via token nell'URL.
 */

import { parseM3U, urlToId, idToUrl, type Canale } from "./m3u";

const ADDON_ID = "org.pezzotto";
const CATALOG_ID = "pezzotto-paesi";

const IPTV_API = "https://iptv-org.github.io/api";
const M3U_BASE =
  "https://raw.githubusercontent.com/iptv-org/iptv/master/streams";

const DEFAULT_COUNTRY = "it"; // Italia

// ─── Token ─────────────────────────────────────────────

/** Token validi. Aggiungi/rimuovi qui per gestire gli utenti. */
const TOKENS = new Set([
  "nicola",
  // "amico1",
  // "amico2",
]);

/** Estrae il token dal primo segmento del path. Restituisce null se assente. */
function estraiToken(path: string): string | null {
  const match = path.match(/^\/([a-zA-Z0-9_-]+)(\/|$)/);
  return match ? match[1] : null;
}

/** Rimuove il token dal path, restituendo il path "pulito". */
function rimuoviToken(path: string, token: string): string {
  const prefix = "/" + token;
  if (path === prefix) return "/";
  return path.slice(prefix.length);
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
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

// ─── Endpoint handlers ────────────────────────────────

async function manifesto(token: string): Promise<Response> {
  let opzioniGenere: string[] = ["it", "us", "gb", "fr", "de", "es"];
  try {
    const resp = await fetch(`${IPTV_API}/countries.json`);
    if (resp.ok) {
      const paesi = (await resp.json()) as Array<{ code: string }>;
      opzioniGenere = paesi.map((p) => p.code.toLowerCase());
    }
  } catch {
    // usa fallback
  }

  return jsonResponse({
    id: ADDON_ID,
    name: "Pezzotto",
    version: "1.0.0",
    description:
      "Canali IPTV da iptv-org — Cloudflare Workers, senza VPN.",
    logo: "https://img.icons8.com/color/96/tv.png",
    resources: ["catalog", "stream", "meta"],
    types: ["tv"],
    catalogs: [
      {
        type: "tv",
        id: CATALOG_ID,
        name: "Pezzotto — Canali TV",
        extra: [
          {
            name: "genre",
            options: opzioniGenere,
            isRequired: false,
          },
        ],
      },
    ],
    idPrefixes: ["pezzotto-"],
  });
}

async function catalogo(genre: string | null): Promise<Response> {
  const codice = genre || DEFAULT_COUNTRY;
  const m3uUrl = `${M3U_BASE}/${codice}.m3u`;

  let contenuto: string;
  try {
    const resp = await fetch(m3uUrl);
    if (!resp.ok) {
      return jsonResponse(
        { error: `Paese '${codice}' non trovato` },
        404
      );
    }
    contenuto = await resp.text();
  } catch (e) {
    return jsonResponse(
      { error: `Impossibile scaricare M3U: ${e}` },
      502
    );
  }

  const canali = parseM3U(contenuto);
  return jsonResponse({
    metas: canali.map(canaleToMeta),
  });
}

async function streamHandler(id: string): Promise<Response> {
  if (!id.startsWith("pezzotto-")) {
    return jsonResponse({ error: "ID non valido" }, 404);
  }

  const raw = id.slice("pezzotto-".length);
  let url: string;
  try {
    url = idToUrl(raw);
  } catch {
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
  try {
    url = idToUrl(raw);
  } catch {
    return jsonResponse({ error: "ID canale non valido" }, 404);
  }

  return jsonResponse({
    meta: {
      id,
      type: "tv",
      name: "Canale TV",
      description: url,
    },
  });
}

// ─── Router ───────────────────────────────────────────

export default {
  async fetch(request: Request): Promise<Response> {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const rawPath = url.pathname;

    // Estrai e valida il token
    const token = estraiToken(rawPath);
    if (!token || !TOKENS.has(token)) {
      return jsonResponse(
        { error: "Accesso negato. Token mancante o non valido." },
        403
      );
    }

    // Path senza il token
    const path = rimuoviToken(rawPath, token);

    // GET /manifest.json
    if (path === "/manifest.json") {
      return manifesto(token);
    }

    // GET /catalog/tv/pezzotto-paesi.json e .../genre=XX.json
    const catalogMatch = path.match(
      /^\/catalog\/tv\/pezzotto-paesi(\.json|\/(genre=[a-z]{2})\.json)$/
    );
    if (catalogMatch) {
      const genre =
        url.searchParams.get("genre") ||
        catalogMatch[2]?.replace("genre=", "") ||
        null;
      return catalogo(genre);
    }

    // GET /stream/tv/{id}.json
    const streamMatch = path.match(/^\/stream\/tv\/(.+\.json)$/);
    if (streamMatch) {
      const id = streamMatch[1].replace(/\.json$/, "");
      return streamHandler(id);
    }

    // GET /meta/tv/{id}.json
    const metaMatch = path.match(/^\/meta\/tv\/(.+\.json)$/);
    if (metaMatch) {
      const id = metaMatch[1].replace(/\.json$/, "");
      return metaHandler(id);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};
