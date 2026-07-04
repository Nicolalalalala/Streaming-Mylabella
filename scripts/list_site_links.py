#!/usr/bin/env python3
"""Content-blind site link lister for Streaming Mylabella.

Given a site URL, fetch public HTML, extract links faithfully, classify them as
stream/page, and update the Stremio worker bundled JSON listing.

stdout is JSON. No content interpretation: titles are derived from link text,
URL path, or filename only.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import re
import ssl
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
# Do not reject Italian AGCOM/ISP notice redirects here.
# The lister runs from ai-brain in Italy, but viewers may be abroad; local
# censorship/notice results must not become a global blacklist. Keep the
# extraction content-blind and let runtime availability decide.


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


def request_headers() -> dict[str, str]:
    return {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) StreamingMylabellaSiteLister/1.0",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }


def fetch_html(url: str, timeout: int) -> tuple[str, dict[str, Any]]:
    req = urllib.request.Request(url, headers=request_headers())
    warnings: list[str] = []
    try:
        resp_ctx = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, ssl.SSLCertVerificationError):
            warnings.append("tls_verification_failed_retrying_unverified")
            resp_ctx = urllib.request.urlopen(
                req, timeout=timeout, context=ssl._create_unverified_context()
            )
        else:
            raise
    with resp_ctx as resp:
        raw = resp.read()
        charset = resp.headers.get_content_charset() or "utf-8"
        html = raw.decode(charset, errors="replace")
        meta = {
            "status": getattr(resp, "status", None),
            "content_type": resp.headers.get("content-type"),
            "bytes": len(raw),
            "final_url": resp.geturl(),
        }
        if warnings:
            meta["warnings"] = warnings
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


def blocked_reason(url: str | None) -> str | None:
    if not url:
        return None
    try:
        urllib.parse.urlsplit(url)
    except Exception:
        return "invalid_url"
    return None


def looks_like_stream(content_type: str | None, sample: bytes, url: str) -> bool:
    path = urllib.parse.urlsplit(url).path.lower()
    if any(path.endswith(ext) for ext in MEDIA_EXTENSIONS):
        return True
    ct = (content_type or "").lower()
    if any(token in ct for token in ["mpegurl", "mp4", "video", "dash+xml", "octet-stream"]):
        return True
    if sample.startswith(b"#EXTM3U"):
        return True
    return False


def probe_link(item: ExtractedLink, timeout: int) -> tuple[bool, str | None]:
    reason = blocked_reason(item.url)
    if reason:
        return False, reason
    if item.kind == "external":
        return False, "external_unverifiable"
    req = urllib.request.Request(item.url, headers={**request_headers(), "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            final_reason = blocked_reason(resp.geturl())
            if final_reason:
                return False, f"redirected_to_{final_reason}"
            status = getattr(resp, "status", None)
            if status is not None and not (200 <= status < 400):
                return False, f"http_{status}"
            sample = resp.read(4096)
            if item.kind == "stream" and not looks_like_stream(
                resp.headers.get("content-type"), sample, resp.geturl()
            ):
                return False, "not_stream_like"
            return True, None
    except urllib.error.HTTPError as exc:
        return False, f"http_{exc.code}"
    except urllib.error.URLError as exc:
        return False, type(exc.reason).__name__ if exc.reason else "url_error"
    except Exception as exc:
        return False, type(exc).__name__


def filter_working_links(items: list[ExtractedLink], timeout: int, workers: int) -> tuple[list[ExtractedLink], dict[str, int], list[dict[str, str]]]:
    if not items:
        return [], {}, []
    rejected_counts: dict[str, int] = {}
    rejected_sample: list[dict[str, str]] = []
    keep_by_url: dict[str, bool] = {}
    reason_by_url: dict[str, str | None] = {}
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(probe_link, item, timeout): item for item in items}
        for fut in cf.as_completed(futures):
            item = futures[fut]
            ok, reason = fut.result()
            keep_by_url[item.url] = ok
            reason_by_url[item.url] = reason
    working: list[ExtractedLink] = []
    for item in items:
        if keep_by_url.get(item.url):
            working.append(item)
        else:
            reason = reason_by_url.get(item.url) or "unknown"
            rejected_counts[reason] = rejected_counts.get(reason, 0) + 1
            if len(rejected_sample) < 20:
                rejected_sample.append({"title": item.title, "url": item.url, "reason": reason})
    return working, rejected_counts, rejected_sample


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
    ap.add_argument("--probe-timeout", type=int, default=8)
    ap.add_argument("--probe-workers", type=int, default=16)
    ap.add_argument("--no-probe", action="store_true", help="Do not verify extracted links")
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
        summary["warnings"].extend(fetch_meta.get("warnings", []))
        final_reason = blocked_reason(fetch_meta.get("final_url"))
        extracted_items = extract_links(html, fetch_meta.get("final_url") or args.url, max_links=args.max_links)
        if final_reason:
            items = []
            rejected_counts = {f"source_{final_reason}": len(extracted_items)}
            rejected_sample = [
                {"title": item.title, "url": item.url, "reason": f"source_{final_reason}"}
                for item in extracted_items[:20]
            ]
        elif args.no_probe:
            items = [item for item in extracted_items if not blocked_reason(item.url)]
            rejected_counts = {"invalid_url": len(extracted_items) - len(items)} if len(items) != len(extracted_items) else {}
            rejected_sample = []
        else:
            items, rejected_counts, rejected_sample = filter_working_links(
                extracted_items, timeout=args.probe_timeout, workers=args.probe_workers
            )
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

        wrote_listing = False
        if not items:
            summary["warnings"].append("no_working_links_found_listing_not_written")
        elif not args.preview:
            listing = load_listing(output)
            listing.setdefault("version", 1)
            listing.setdefault("sites", {})[site_name] = site_payload
            save_listing(output, listing)
            wrote_listing = True

        summary.update(
            {
                "success": True,
                "fetch": fetch_meta,
                "links_extracted": len(extracted_items),
                "links_found": len(items),
                "links_rejected": len(extracted_items) - len(items),
                "rejected_counts": rejected_counts,
                "rejected_sample": rejected_sample,
                "media_links": stream_count,
                "page_links": page_count,
                "external_links": external_count,
                "listing_written": wrote_listing,
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
