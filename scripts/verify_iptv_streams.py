#!/usr/bin/env python3
"""Verify IPTV stream URLs from iptv-org country M3U.

Content-blind network check: fetch playlist, parse EXTINF entries, probe stream URLs
with small HTTP requests, emit JSON summary. Does not download full streams.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import re
import socket
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

M3U_BASE = "https://raw.githubusercontent.com/iptv-org/iptv/master/streams"
UA = "Mozilla/5.0 (X11; Linux x86_64) StreamingMylabellaVerifier/1.0"


@dataclass
class Channel:
    name: str
    url: str
    tvg_id: str | None
    quality: str | None
    flags: list[str]


@dataclass
class ProbeResult:
    ok: bool
    name: str
    url: str
    tvg_id: str | None
    status: int | None
    content_type: str | None
    bytes_read: int
    final_url: str | None
    failure_kind: str | None
    error: str | None
    elapsed_ms: int


def fetch_text(url: str, timeout: int) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def parse_m3u(text: str) -> list[Channel]:
    out: list[Channel] = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        i += 1
        if not line.startswith("#EXTINF:"):
            continue
        tvg_match = re.search(r'tvg-id="([^"]*)"', line)
        tvg_id = tvg_match.group(1) if tvg_match else None
        comma = line.find(",")
        raw_name = line[comma + 1 :].strip() if comma != -1 else tvg_id or "channel"
        flags = re.findall(r"\[([^\]]+)\]", raw_name)
        clean = re.sub(r"\s*\[[^\]]+\]\s*", " ", raw_name).strip()
        q_match = re.search(r"\((\d+p)\)", clean)
        quality = q_match.group(1) if q_match else None
        if q_match:
            clean = (clean[: q_match.start()] + clean[q_match.end() :]).strip()
        while i < len(lines) and (not lines[i].strip() or lines[i].startswith("#")):
            i += 1
        if i >= len(lines):
            break
        url = lines[i].strip()
        i += 1
        if url:
            out.append(Channel(clean, url, tvg_id, quality, flags))
    return out


def classify_error(exc: BaseException) -> tuple[str, str, int | None]:
    if isinstance(exc, urllib.error.HTTPError):
        return "http", f"HTTP {exc.code}: {exc.reason}", exc.code
    if isinstance(exc, urllib.error.URLError):
        reason = exc.reason
        if isinstance(reason, socket.gaierror):
            return "dns", str(reason), None
        if isinstance(reason, TimeoutError):
            return "timeout", str(reason), None
        if isinstance(reason, ssl.SSLError):
            return "ssl", str(reason), None
        return "url", str(reason), None
    if isinstance(exc, TimeoutError):
        return "timeout", str(exc), None
    return "other", repr(exc), None


def looks_like_stream(content_type: str | None, sample: bytes, url: str) -> bool:
    path = urllib.parse.urlsplit(url).path.lower()
    if path.endswith((".m3u8", ".mp4", ".webm", ".mov", ".mkv", ".avi", ".mpd")):
        return True
    ct = (content_type or "").lower()
    if any(token in ct for token in ["mpegurl", "mp4", "video", "dash+xml", "octet-stream"]):
        return True
    if sample.startswith(b"#EXTM3U"):
        return True
    return False


def probe(channel: Channel, timeout: int) -> ProbeResult:
    start = time.monotonic()
    status = None
    try:
        req = urllib.request.Request(
            channel.url,
            headers={"User-Agent": UA, "Accept": "*/*"},
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status = getattr(r, "status", None)
            sample = r.read(4096)
            content_type = r.headers.get("content-type")
            ok = (status is None or 200 <= status < 400) and looks_like_stream(content_type, sample, r.geturl())
            return ProbeResult(
                ok=ok,
                name=channel.name,
                url=channel.url,
                tvg_id=channel.tvg_id,
                status=status,
                content_type=content_type,
                bytes_read=len(sample),
                final_url=r.geturl(),
                failure_kind=None if ok else "not_stream_like",
                error=None if ok else "response did not look like a stream",
                elapsed_ms=int((time.monotonic() - start) * 1000),
            )
    except BaseException as exc:
        kind, err, http_status = classify_error(exc)
        return ProbeResult(
            ok=False,
            name=channel.name,
            url=channel.url,
            tvg_id=channel.tvg_id,
            status=http_status or status,
            content_type=None,
            bytes_read=0,
            final_url=None,
            failure_kind=kind,
            error=err,
            elapsed_ms=int((time.monotonic() - start) * 1000),
        )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--country", default="it")
    ap.add_argument("--timeout", type=int, default=8)
    ap.add_argument("--workers", type=int, default=24)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--output", default="/home/ai-brain/site-listing-agent/logs/iptv-verify-latest.json")
    args = ap.parse_args()

    playlist_url = f"{M3U_BASE}/{args.country}.m3u"
    channels = parse_m3u(fetch_text(playlist_url, timeout=30))
    if args.limit:
        channels = channels[: args.limit]

    started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    results: list[ProbeResult] = []
    with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = [ex.submit(probe, ch, args.timeout) for ch in channels]
        for fut in cf.as_completed(futs):
            results.append(fut.result())

    results.sort(key=lambda r: (not r.ok, r.name.lower(), r.url))
    broken = [r for r in results if not r.ok]
    working = [r for r in results if r.ok]
    by_failure: dict[str, int] = {}
    for r in broken:
        by_failure[r.failure_kind or "unknown"] = by_failure.get(r.failure_kind or "unknown", 0) + 1

    payload: dict[str, Any] = {
        "success": True,
        "country": args.country,
        "playlist_url": playlist_url,
        "started_at": started,
        "completed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "total": len(results),
        "working": len(working),
        "broken": len(broken),
        "failure_counts": by_failure,
        "working_sample": [asdict(r) for r in working[:20]],
        "broken_sample": [asdict(r) for r in broken[:50]],
        "broken": [asdict(r) for r in broken],
    }
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: payload[k] for k in ["success", "country", "total", "working", "broken", "failure_counts"]}, ensure_ascii=False, indent=2))
    print(f"log_path={out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
