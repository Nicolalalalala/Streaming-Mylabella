#!/usr/bin/env python3
"""Content-blind site link lister for Streaming Mylabella.

Given a site URL, fetch public HTML, extract links faithfully, classify them as
stream/page, and update the Stremio worker bundled JSON listing.

stdout is JSON. No content interpretation: titles are derived from link text,
URL path, or filename only.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

DEFAULT_WORKSPACE = Path("/home/ai-brain/site-listing-agent")
DEFAULT_OUTPUT = Path(
    "/home/ai-brain/software-dev-channel/repos/streaming-mylabella-worker/data/site-listings.json"
)
MEDIA_EXTENSIONS = (
    ".m3u8",
    ".mp4",
    ".webm",
    ".mov",
    ".mkv",
    ".avi",
    ".mpd",
)
RAW_URL_RE = re.compile(r"https?://[^\s'\"<>]+", re.IGNORECASE)


@dataclass
class ExtractedLink:
    title: str
    url: str
    kind: str
    source: str


class LinkParser(HTMLParser):
    def __init__(self, base_url: str):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.links: list[tuple[str, str, str]] = []
        self._current_href: str | None = None
        self._current_text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr = {k.lower(): v for k, v in attrs if v}
        if tag == "a" and attr.get("href"):
            self._current_href = attr["href"]
            self._current_text = []
            return
        for name in ("src", "href"):
            value = attr.get(name)
            if value and tag in {"video", "source", "iframe", "embed", "track"}:
                self.links.append((tag, value, ""))

    def handle_data(self, data: str) -> None:
        if self._current_href is not None:
            self._current_text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._current_href is not None:
            text = " ".join(" ".join(self._current_text).split())
            self.links.append(("a", self._current_href, text))
            self._current_href = None
            self._current_text = []


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def fetch_html(url: str, timeout: int) -> tuple[str, dict[str, Any]]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) StreamingMylabellaSiteLister/1.0",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        charset = resp.headers.get_content_charset() or "utf-8"
        html = raw.decode(charset, errors="replace")
        meta = {
            "status": getattr(resp, "status", None),
            "content_type": resp.headers.get("content-type"),
            "bytes": len(raw),
            "final_url": resp.geturl(),
        }
        return html, meta


def normalize_url(base: str, value: str) -> str | None:
    value = value.strip()
    if not value or value.startswith(("#", "javascript:", "mailto:", "tel:")):
        return None
    absolute = urllib.parse.urljoin(base, value)
    parsed = urllib.parse.urlsplit(absolute)
    if parsed.scheme not in {"http", "https", "magnet"}:
        return None
    # Keep query because signed media links often need it; drop fragments.
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))


def classify(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    path = parsed.path.lower()
    if url.lower().startswith("magnet:"):
        return "external"
    if any(path.endswith(ext) for ext in MEDIA_EXTENSIONS):
        return "stream"
    return "page"


def title_from_url(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    tail = Path(urllib.parse.unquote(parsed.path)).name
    if not tail:
        tail = parsed.netloc or url
    title = re.sub(r"[-_]+", " ", tail).strip()
    return title[:160] or url[:160]


def clean_title(text: str, url: str) -> str:
    text = " ".join((text or "").split()).strip()
    if not text:
        text = title_from_url(url)
    return text[:180]


def extract_links(html: str, base_url: str, max_links: int) -> list[ExtractedLink]:
    parser = LinkParser(base_url)
    parser.feed(html)

    candidates: list[tuple[str, str, str]] = list(parser.links)
    for match in RAW_URL_RE.finditer(html):
        raw = match.group(0).rstrip("),.;]")
        if any(urllib.parse.urlsplit(raw).path.lower().endswith(ext) for ext in MEDIA_EXTENSIONS):
            candidates.append(("raw", raw, ""))

    seen: set[str] = set()
    result: list[ExtractedLink] = []
    for source, raw_url, text in candidates:
        url = normalize_url(base_url, raw_url)
        if not url or url in seen:
            continue
        seen.add(url)
        result.append(
            ExtractedLink(
                title=clean_title(text, url),
                url=url,
                kind=classify(url),
                source=source,
            )
        )
        if len(result) >= max_links:
            break
    return result


def load_listing(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": 1, "sites": {}}
    data = json.loads(path.read_text(encoding="utf-8"))
    if "sites" not in data or not isinstance(data["sites"], dict):
        raise RuntimeError(f"Invalid listing file: {path}")
    return data


def save_listing(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def safe_site_name(name: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "-", name.strip()).strip("-").lower()
    if not cleaned:
        raise RuntimeError("site name is empty after sanitization")
    return cleaned[:80]


def print_json(payload: dict[str, Any], code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return code


def main() -> int:
    ap = argparse.ArgumentParser(description="List public links from a site and update Streaming Mylabella listings")
    ap.add_argument("--site-name", required=True, help="Stable site key, e.g. example")
    ap.add_argument("--url", required=True, help="Public page/listing URL to scan")
    ap.add_argument("--output", default=str(DEFAULT_OUTPUT), help="site-listings.json path")
    ap.add_argument("--workspace", default=str(DEFAULT_WORKSPACE))
    ap.add_argument("--max-links", type=int, default=500)
    ap.add_argument("--timeout", type=int, default=30)
    ap.add_argument("--preview", action="store_true", help="Do not write output JSON")
    args = ap.parse_args()

    workspace = Path(args.workspace).expanduser().resolve()
    logs = workspace / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    output = Path(args.output).expanduser().resolve()
    site_name = safe_site_name(args.site_name)

    summary: dict[str, Any] = {
        "success": False,
        "mode": "preview" if args.preview else "write",
        "site_name": site_name,
        "source_url": args.url,
        "output": str(output),
        "started_at": now_iso(),
        "warnings": [],
    }

    try:
        html, fetch_meta = fetch_html(args.url, timeout=args.timeout)
        items = extract_links(html, fetch_meta.get("final_url") or args.url, max_links=args.max_links)
        stream_count = sum(1 for item in items if item.kind == "stream")
        page_count = sum(1 for item in items if item.kind == "page")
        external_count = sum(1 for item in items if item.kind == "external")

        site_payload = {
            "name": site_name,
            "sourceUrl": args.url,
            "finalUrl": fetch_meta.get("final_url"),
            "updatedAt": now_iso(),
            "counts": {
                "total": len(items),
                "stream": stream_count,
                "page": page_count,
                "external": external_count,
            },
            "items": [asdict(item) for item in items],
        }

        if not args.preview:
            listing = load_listing(output)
            listing.setdefault("version", 1)
            listing.setdefault("sites", {})[site_name] = site_payload
            save_listing(output, listing)

        summary.update(
            {
                "success": True,
                "fetch": fetch_meta,
                "links_found": len(items),
                "media_links": stream_count,
                "page_links": page_count,
                "external_links": external_count,
                "sample_items": [asdict(item) for item in items[:10]],
            }
        )
    except urllib.error.HTTPError as exc:
        summary.update({"error": f"HTTP {exc.code}: {exc.reason}"})
    except Exception as exc:
        summary.update({"error": str(exc)})

    log_path = logs / f"site-listing-{datetime.now():%Y%m%d-%H%M%S}.json"
    log_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    summary["log_path"] = str(log_path)
    return print_json(summary, 0 if summary.get("success") else 1)


if __name__ == "__main__":
    raise SystemExit(main())
