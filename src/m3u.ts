/**
 * Parser M3U per file di iptv-org.
 */

export interface Canale {
  nome: string;
  url: string;
  tvgId?: string;
  qualita?: string;   // es. "720p", "1080p"
  geoBlocked: boolean;
  flags: string[];     // es. ["Not 24/7"]
}

/**
 * Estrae la qualità dal nome (es. "Rai 1 (720p)" → "720p").
 */
function estraiQualita(nome: string): { nomePulito: string; qualita?: string } {
  const match = nome.match(/\((\d+p)\)/);
  if (match) {
    return {
      nomePulito: nome.slice(0, match.index!).trim(),
      qualita: match[1],
    };
  }
  return { nomePulito: nome };
}

/**
 * Estrae flag tra parentesi quadre (es. "[Geo-blocked]").
 */
function estraiFlags(nome: string): { nomePulito: string; flags: string[] } {
  const flags: string[] = [];
  let nomePulito = nome;
  const re = /\[([^\]]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(nome)) !== null) {
    flags.push(match[1]);
  }
  nomePulito = nome.replace(/\s*\[[^\]]+\]\s*/g, " ").trim();
  return { nomePulito, flags };
}

/**
 * Parsa un file M3U e restituisce la lista dei canali.
 */
export function parseM3U(contenuto: string): Canale[] {
  const canali: Canale[] = [];
  const righe = contenuto.split(/\r?\n/);

  for (let i = 0; i < righe.length; i++) {
    const riga = righe[i].trim();

    if (!riga.startsWith("#EXTINF:")) continue;

    // Estrai tvg-id
    const tvgMatch = riga.match(/tvg-id="([^"]*)"/);
    const tvgId = tvgMatch ? tvgMatch[1] : undefined;

    // Estrai nome (dopo la virgola)
    const virgolaIdx = riga.indexOf(",");
    if (virgolaIdx === -1) continue;
    const nomeRaw = riga.slice(virgolaIdx + 1).trim();

    // Prossima riga non-commento = URL. Alcuni stream hanno direttive VLC
    // tipo #EXTVLCOPT prima dell'URL vero: saltarle, non droppare il canale.
    i++;
    while (i < righe.length && (!righe[i].trim() || righe[i].trim().startsWith("#"))) {
      i++;
    }
    if (i >= righe.length) break;
    const url = righe[i].trim();
    if (!url) continue;

    const { nomePulito: nomeSenzaFlags, flags } = estraiFlags(nomeRaw);
    const { nomePulito, qualita } = estraiQualita(nomeSenzaFlags);
    const geoBlocked = flags.includes("Geo-blocked");

    canali.push({ nome: nomePulito, url, tvgId, qualita, geoBlocked, flags });
  }

  return canali;
}

/**
 * Codifica un URL in un ID base64 url-safe (senza padding).
 */
export function urlToId(url: string): string {
  return btoa(url).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decodifica un ID nell'URL originale.
 */
export function idToUrl(id: string): string {
  // Ripristina caratteri base64 standard
  let base64 = id.replace(/-/g, "+").replace(/_/g, "/");
  // Aggiungi padding
  while (base64.length % 4 !== 0) base64 += "=";
  return atob(base64);
}
