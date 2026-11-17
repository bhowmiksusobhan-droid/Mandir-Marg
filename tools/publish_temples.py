#!/usr/bin/env python3
"""Publish approved temple suggestions to the public map.

The website never calls Supabase for the map. Instead, a moderator marks a row
``status = approved`` in the Supabase dashboard, then runs this script. It writes
``public/data/community-temples.json`` (and any photos) ready to be committed and
deployed as ordinary static files.

Usage
-----
    # Read approved rows from Supabase (service role key recommended)
    set SUPABASE_URL=https://xxxx.supabase.co
    set SUPABASE_SERVICE_ROLE_KEY=eyJ...
    python tools/publish_temples.py

    # Or preview from a JSON export, without touching the network
    python tools/publish_temples.py --input rows.json --dry-run

    # Explicit paths
    python tools/publish_temples.py --out public/data/community-temples.json

Photos submitted as downscaled data URLs are written as JPEG/PNG/WebP files under
``public/data/photos/``. The JSON then points at a small relative path, so the
file stays quick to load and the photo is served by the same free host.

This script only uses the Python standard library.
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "public" / "data" / "community-temples.json"
DEFAULT_PHOTOS = ROOT / "public" / "data" / "photos"

BASE_COLUMNS = [
    "id",
    "kind",
    "temple_name",
    "deity",
    "city",
    "address",
    "notes",
    "osm_id",
    "lat",
    "lng",
    "created_at",
]
PHOTO_COLUMN = "photo"
MAX_PHOTO_BYTES = 1_500_000
DEDUPE_METERS = 75


def normalise_name(value: str) -> str:
    return re.sub(r"[^\w]+", "", (value or "").lower(), flags=re.UNICODE)


def names_match(left: str, right: str) -> bool:
    a, b = normalise_name(left), normalise_name(right)
    if not a or not b:
        return False
    return a == b or a in b or b in a


def haversine(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    radius = 6_371_000.0
    to_rad = math.radians
    d_lat = to_rad(lat2 - lat1)
    d_lng = to_rad(lng2 - lng1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(to_rad(lat1)) * math.cos(to_rad(lat2)) * math.sin(d_lng / 2) ** 2
    )
    return 2 * radius * math.asin(math.sqrt(a))


def created_key(record: dict) -> str:
    return str(record.get("createdAt") or "")


def fetch_rows(base_url: str, key: str, status: str, limit: int = 1000) -> list[dict]:
    """Read every matching row, paging until Supabase returns a short batch."""
    columns = BASE_COLUMNS + [PHOTO_COLUMN]
    rows: list[dict] = []
    offset = 0

    while True:
        query = urllib.parse.urlencode(
            {
                "select": ",".join(columns),
                "status": f"eq.{status}",
                "order": "created_at.asc",
                "limit": str(limit),
                "offset": str(offset),
            }
        )
        request = urllib.request.Request(
            f"{base_url.rstrip('/')}/rest/v1/temple_suggestions?{query}",
            headers={
                "apikey": key,
                "Authorization": f"Bearer {key}",
                "Accept": "application/json",
                "User-Agent": "MandirMarg-Publisher/1.0",
            },
        )

        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                batch = json.load(response)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            # Older installations may not have run the photo migration yet.
            if error.code == 400 and PHOTO_COLUMN in columns and PHOTO_COLUMN in detail:
                columns = BASE_COLUMNS
                print("Note: the photo column is missing; publishing without photos.")
                continue
            raise SystemExit(f"Supabase returned HTTP {error.code}: {detail[:300]}")

        if not isinstance(batch, list):
            raise SystemExit("Unexpected Supabase response (expected a JSON array).")
        rows.extend(batch)
        if len(batch) < limit:
            return rows
        offset += len(batch)


def load_input(path: Path) -> list[dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise SystemExit(f"Could not read {path}: {error}")
    if isinstance(data, dict) and isinstance(data.get("rows"), list):
        data = data["rows"]
    if not isinstance(data, list):
        raise SystemExit(f"{path} must contain a JSON array of suggestion rows.")
    return data


def publish_photo(photo: str, record_id: str, photos_dir: Path, dry_run: bool) -> str:
    """Return a web path for the photo, writing a data URL out as a file."""
    text = str(photo or "").strip()
    if not text:
        return ""

    if re.match(r"^(?:\./)?data/photos/[A-Za-z0-9._-]+$", text):
        return text.removeprefix("./")

    match = re.match(r"^data:image/(jpeg|png|webp);base64,(.+)$", text, re.IGNORECASE | re.DOTALL)
    if not match:
        print(f"  skipped a photo for {record_id}: only local photos and image data URLs are accepted")
        return ""

    extension = {"jpeg": "jpg", "png": "png", "webp": "webp"}[match.group(1).lower()]
    try:
        raw = base64.b64decode(re.sub(r"\s+", "", match.group(2)), validate=True)
    except (ValueError, TypeError):
        print(f"  skipped a photo for {record_id}: invalid base64")
        return ""
    if len(raw) < 32:
        return ""
    if len(raw) > MAX_PHOTO_BYTES:
        print(f"  skipped a photo for {record_id}: {len(raw) // 1024} KB is above the limit")
        return ""

    slug = re.sub(r"[^A-Za-z0-9-]+", "-", record_id.split("/", 1)[-1]).strip("-")[:60]
    filename = f"photo-{slug or 'temple'}.{extension}"
    if not dry_run:
        photos_dir.mkdir(parents=True, exist_ok=True)
        (photos_dir / filename).write_bytes(raw)
    return f"data/photos/{filename}"


def build_record(row: dict, photos_dir: Path, dry_run: bool) -> dict | None:
    name = str(row.get("temple_name") or row.get("name") or "").strip()
    if not name:
        print("  skipped a row without a temple name")
        return None

    try:
        lat = float(row.get("lat"))
        lng = float(row.get("lng"))
    except (TypeError, ValueError):
        print(f"  skipped {name}: invalid coordinates")
        return None

    if not (-90 <= lat <= 90 and -180 <= lng <= 180) or (lat == 0 and lng == 0):
        print(f"  skipped {name}: coordinates are outside the map")
        return None

    osm_id = str(row.get("osm_id") or "").strip()

    # An edit of a community temple stores its community/<uuid> id here so the
    # publisher replaces that exact entry. It is not re-emitted as osmId.
    if osm_id.startswith("community/"):
        record_id = osm_id
        emit_osm_id = ""
    else:
        raw_id = str(row.get("id") or "").strip()
        if not raw_id:
            raw_id = f"{name}-{lat:.5f}-{lng:.5f}"
            raw_id = re.sub(r"[^A-Za-z0-9._-]+", "-", raw_id).strip("-")
        record_id = f"community/{raw_id}"
        emit_osm_id = osm_id

    photo = publish_photo(str(row.get(PHOTO_COLUMN) or ""), record_id, photos_dir, dry_run)

    return {
        "id": record_id,
        "name": name,
        "deity": str(row.get("deity") or "").strip(),
        "city": str(row.get("city") or "").strip(),
        "address": str(row.get("address") or "").strip(),
        "notes": str(row.get("notes") or "").strip(),
        "osmId": emit_osm_id,
        "lat": round(lat, 7),
        "lng": round(lng, 7),
        "photo": photo,
        "createdAt": str(row.get("created_at") or ""),
    }


def dedupe(records: list[dict]) -> tuple[list[dict], list[tuple[str, str]]]:
    """Drop near-identical entries, keeping the earliest approved record."""
    kept: list[dict] = []
    skipped: list[tuple[str, str]] = []

    for record in sorted(records, key=created_key):
        duplicate = None
        for existing in kept:
            if haversine(record["lat"], record["lng"], existing["lat"], existing["lng"]) > DEDUPE_METERS:
                continue
            if names_match(record["name"], existing["name"]):
                duplicate = existing
                break
        if duplicate:
            skipped.append((record["name"], duplicate["name"]))
        else:
            kept.append(record)

    return kept, skipped


def main() -> int:
    parser = argparse.ArgumentParser(description="Publish approved temples to the community map.")
    parser.add_argument("--url", default=os.environ.get("SUPABASE_URL", ""), help="Supabase project URL")
    parser.add_argument(
        "--key",
        default=os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("SUPABASE_ANON_KEY", ""),
        help="Supabase key (service role is safest; the approved-only policy allows anon)",
    )
    parser.add_argument("--status", default="approved", help="status to publish (default: approved)")
    parser.add_argument("--input", type=Path, help="read rows from a JSON file instead of Supabase")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="community JSON to write")
    parser.add_argument("--photos-dir", type=Path, default=DEFAULT_PHOTOS, help="where photos are written")
    parser.add_argument("--dry-run", action="store_true", help="report what would change, write nothing")
    args = parser.parse_args()

    if args.input:
        rows = load_input(args.input)
    else:
        if not args.url or not args.key:
            parser.error("provide --input, or SUPABASE_URL and a Supabase key")
        rows = fetch_rows(args.url, args.key, args.status)

    print(f"Read {len(rows)} {args.status} suggestion(s).")

    records: list[dict] = []
    for row in rows:
        record = build_record(row, args.photos_dir, args.dry_run)
        if record:
            records.append(record)

    # Collapse duplicate record ids: the latest approved edit wins, so a
    # moderator can correct a previously published community temple.
    by_id: dict[str, dict] = {}
    for record in records:
        existing = by_id.get(record["id"])
        if existing is None or record["createdAt"] >= existing["createdAt"]:
            by_id[record["id"]] = record
    records = sorted(by_id.values(), key=created_key)

    records, skipped = dedupe(records)

    # Keep hand-curated entries; replace every previously published community
    # entry with the current approved set so rejections disappear from the map.
    existing: dict = {"version": 1, "temples": []}
    if args.out.exists():
        try:
            existing = json.loads(args.out.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise SystemExit(f"Existing {args.out} is not valid JSON: {error}")

    old_temples = existing.get("temples") if isinstance(existing, dict) else None
    if not isinstance(old_temples, list):
        old_temples = []

    manual = [
        item
        for item in old_temples
        if isinstance(item, dict) and not str(item.get("id", "")).startswith("community/")
    ]
    final = manual + records
    final.sort(key=lambda item: (str(item.get("name", "")).casefold(), str(item.get("id", ""))))

    payload = {
        "version": int(existing.get("version") or 1) if isinstance(existing, dict) else 1,
        "updatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "temples": final,
    }

    photos = sum(1 for record in records if record.get("photo"))
    print(f"  {len(records)} temple(s) published, {photos} with a photo.")
    print(f"  {len(manual)} hand-curated entr{'y' if len(manual) == 1 else 'ies'} kept.")
    for name, original in skipped:
        print(f"  skipped duplicate: {name} (same place as {original})")

    if args.dry_run:
        print(f"Dry run: would write {args.out}")
        return 0

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {args.out}")
    print("Commit this file (and public/data/photos) to publish the approvals.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
