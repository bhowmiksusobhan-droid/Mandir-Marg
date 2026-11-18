#!/usr/bin/env python3
"""Build the static temple dataset that ships with Mandir Marg.

Reads a Geofabrik OSM extract (for example india-latest.osm.pbf) and writes
one small JSON file per 2-degree grid cell into public/data/temples/. The app
loads only the cells that touch the current map view, so the map still works
when every Overpass mirror is unreachable.

Each file uses the same element shape as the live /api/temples response:

    {"version": 1, "bbox": [south, west, north, east], "elements": [...]}

so the browser can reuse its existing OSM-to-temple conversion and dedupe
logic. Coordinates for way/relation geometries are reduced to a bbox centre.

Usage:
    python tools/build_temple_data.py --pbf india.osm.pbf --out public/data/temples
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections import defaultdict

import osmium

# Tags the app actually reads. Keeping this list short is what keeps the
# dataset small enough to ship as static files.
KEEP_TAGS = {
    "name",
    "name:en",
    "name:hi",
    "amenity",
    "building",
    "religion",
    "denomination",
    "deity",
    "deity:en",
    "description",
    "description:en",
    "phone",
    "contact:phone",
    "website",
    "contact:website",
    "wikipedia",
    "addr:housenumber",
    "addr:street",
    "addr:suburb",
    "addr:city",
    "addr:town",
    "addr:village",
    "addr:district",
    "addr:state",
    "addr:postcode",
}

CELL_DEGREES = 2.0


def is_temple(tags) -> bool:
    if tags.get("religion") != "hindu":
        return False
    return tags.get("amenity") == "place_of_worship" or tags.get("building") == "temple"


def kept_tags(tags) -> dict:
    # amenity/religion/building are constant for every record, so they are not
    # stored: the app already knows these are Hindu places of worship.
    return {
        key: tags[key]
        for key in KEEP_TAGS
        if key in tags and key not in ("amenity", "religion", "building")
    }


def cell_for(lat: float, lng: float) -> tuple[int, int]:
    return (
        int(math.floor(lat / CELL_DEGREES) * CELL_DEGREES),
        int(math.floor(lng / CELL_DEGREES) * CELL_DEGREES),
    )


def cell_name(lat_cell: int, lng_cell: int) -> str:
    return f"{lat_cell}_{lng_cell}.json"


class TempleScan(osmium.SimpleHandler):
    """First pass: collect matching nodes directly and ways/relations by ref."""

    def __init__(self) -> None:
        super().__init__()
        self.nodes = []      # (id, lat, lng, tags)
        self.ways = []       # (id, [node refs], tags)
        self.relations = []  # (id, [node refs], tags)
        self.needed_nodes = set()

    def node(self, node) -> None:
        if node.location.valid() and is_temple(node.tags):
            self.nodes.append(
                (node.id, node.location.lat, node.location.lon, kept_tags(node.tags))
            )

    def way(self, way) -> None:
        if not is_temple(way.tags):
            return
        refs = [node.ref for node in way.nodes]
        if not refs:
            return
        self.ways.append((way.id, refs, kept_tags(way.tags)))
        self.needed_nodes.update(refs)

    def relation(self, relation) -> None:
        if not is_temple(relation.tags):
            return
        # Only node members can be resolved without a second geometry index.
        refs = [member.ref for member in relation.members if member.type == "n"]
        if not refs:
            return
        self.relations.append((relation.id, refs, kept_tags(relation.tags)))
        self.needed_nodes.update(refs)


class NodeCollector(osmium.SimpleHandler):
    """Second pass: coordinates for the node ids used by way/relation centres."""

    def __init__(self, wanted: set[int]) -> None:
        super().__init__()
        self.wanted = wanted
        self.coords: dict[int, tuple[float, float]] = {}

    def node(self, node) -> None:
        if node.id in self.wanted and node.location.valid():
            self.coords[node.id] = (node.location.lat, node.location.lon)


def centre(coords: list[tuple[float, float]]) -> tuple[float, float] | None:
    if not coords:
        return None
    lats = [lat for lat, _ in coords]
    lngs = [lng for _, lng in coords]
    return ((min(lats) + max(lats)) / 2.0, (min(lngs) + max(lngs)) / 2.0)


def main() -> int:
    global CELL_DEGREES

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pbf", required=True, help="Path to the .osm.pbf extract")
    parser.add_argument("--out", required=True, help="Output directory, e.g. public/data/temples")
    parser.add_argument("--cell", type=float, default=CELL_DEGREES, help="Grid size in degrees")
    parser.add_argument(
        "--bbox",
        help="Keep only temples inside south,west,north,east (decimal degrees)",
    )
    parser.add_argument(
        "--cell-file",
        action="store_true",
        help="Also write a manifest of the cells that were produced",
    )
    args = parser.parse_args()

    CELL_DEGREES = args.cell

    bbox = None
    if args.bbox:
        values = [float(part) for part in args.bbox.split(",")]
        if len(values) != 4:
            print("error: --bbox wants south,west,north,east", file=sys.stderr)
            return 2
        bbox = values

    if not os.path.exists(args.pbf):
        print(f"error: {args.pbf} not found", file=sys.stderr)
        return 2

    print(f"pass 1/2: scanning {args.pbf}", flush=True)
    scan = TempleScan()
    scan.apply_file(args.pbf)
    print(
        f"  nodes={len(scan.nodes)} ways={len(scan.ways)} "
        f"relations={len(scan.relations)} needed_nodes={len(scan.needed_nodes)}",
        flush=True,
    )

    print("pass 2/2: resolving way/relation centres", flush=True)
    collector = NodeCollector(scan.needed_nodes)
    collector.apply_file(args.pbf)
    coords = collector.coords
    print(f"  resolved {len(coords)} node coordinates", flush=True)

    cells: dict[tuple[int, int], list[dict]] = defaultdict(list)
    seen: set[tuple[str, int]] = set()

    def emit(osm_type: str, osm_id: int, lat: float, lng: float, tags: dict) -> None:
        if not tags.get("name"):
            return
        if bbox and not (bbox[0] <= lat <= bbox[2] and bbox[1] <= lng <= bbox[3]):
            return
        key = (osm_type, osm_id)
        if key in seen:
            return
        seen.add(key)
        lat_cell, lng_cell = cell_for(lat, lng)
        cells[(lat_cell, lng_cell)].append(
            {
                "type": osm_type,
                "id": osm_id,
                "lat": round(lat, 6),
                "lon": round(lng, 6),
                "tags": tags,
            }
        )

    for osm_id, lat, lng, tags in scan.nodes:
        emit("node", osm_id, lat, lng, tags)

    skipped_ways = 0
    for osm_id, refs, tags in scan.ways:
        found = [coords[ref] for ref in refs if ref in coords]
        point = centre(found)
        if point is None:
            skipped_ways += 1
            continue
        emit("way", osm_id, point[0], point[1], tags)

    skipped_relations = 0
    for osm_id, refs, tags in scan.relations:
        found = [coords[ref] for ref in refs if ref in coords]
        point = centre(found)
        if point is None:
            skipped_relations += 1
            continue
        emit("relation", osm_id, point[0], point[1], tags)

    os.makedirs(args.out, exist_ok=True)
    for name in os.listdir(args.out):
        if name.endswith(".json") and name != "index.json":
            os.remove(os.path.join(args.out, name))

    total = 0
    manifest = []
    for (lat_cell, lng_cell), elements in sorted(cells.items()):
        elements.sort(key=lambda item: (item["type"], item["id"]))
        payload = {
            "version": 1,
            "bbox": [
                lat_cell,
                lng_cell,
                lat_cell + CELL_DEGREES,
                lng_cell + CELL_DEGREES,
            ],
            "elements": elements,
        }
        name = cell_name(lat_cell, lng_cell)
        with open(os.path.join(args.out, name), "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        total += len(elements)
        manifest.append(
            {
                "file": name,
                "bbox": payload["bbox"],
                "count": len(elements),
                "bytes": os.path.getsize(os.path.join(args.out, name)),
            }
        )

    if args.cell_file:
        with open(os.path.join(args.out, "index.json"), "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "version": 1,
                    "cell_degrees": CELL_DEGREES,
                    "cells": manifest,
                },
                handle,
                ensure_ascii=False,
                separators=(",", ":"),
            )

    print(
        f"wrote {len(cells)} cells, {total} temples "
        f"(skipped {skipped_ways} ways, {skipped_relations} relations)",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
