"""Overpass JSON responses -> web/data/osm.json: parks and water as delta-encoded metre polygons.

Accepts ways with inline geometry (`out geom`) or with node refs (osmnx cache files).
Multipolygon relations (the Manzanares, big parks) are stitched from their outer ways.
usage: python scripts/osm.py <out.json> <overpass1.json> [overpass2.json ...]
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # works under python -I too
from frame import delta_encode, inside, proj, simplify


def layer(tags):
    """The map layer an OSM feature belongs to, or None. Streets and railways are not drawn."""
    if 'highway' in tags or 'railway' in tags:
        return None
    if tags.get('natural') == 'water' or tags.get('water'):
        return 'water'
    if tags.get('leisure') == 'park' or tags.get('landuse') == 'forest':
        return 'green'
    return None


def stitch(segs):
    """Join way segments that share end points into rings."""
    segs = [s for s in segs if len(s) > 1]
    while segs:
        ring = segs.pop(0)
        while ring[0] != ring[-1]:
            for i, sg in enumerate(segs):
                if sg[0] == ring[-1]:
                    ring += sg[1:]
                    break
                if sg[-1] == ring[-1]:
                    ring += sg[::-1][1:]
                    break
            else:
                break
            segs.pop(i)
        yield ring


def features(elements):
    """Yields (way id, layer, [(lon, lat), ...]) for every way and stitched relation ring of interest."""
    nodes = {e['id']: (e['lon'], e['lat']) for e in elements if e['type'] == 'node' and 'lat' in e}
    ways = {e['id']: e for e in elements if e['type'] == 'way'}

    def coords(w):
        if 'geometry' in w:
            return [(g['lon'], g['lat']) for g in w['geometry'] if g]
        return [nodes[i] for i in w.get('nodes', []) if i in nodes]

    for r in elements:
        L = r['type'] == 'relation' and layer(r.get('tags', {}))
        if not L:
            continue
        segs = [coords(ways[m['ref']]) if m['ref'] in ways else [(g['lon'], g['lat']) for g in m.get('geometry', [])]
                for m in r.get('members', []) if m['type'] == 'way' and m.get('role') in ('outer', '')]
        for k, ring in enumerate(stitch(segs)):
            yield ('r', r['id'], k), L, ring
    for w in ways.values():
        L = layer(w.get('tags', {}))
        if L:
            yield w['id'], L, coords(w)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('out')
    ap.add_argument('inputs', nargs='+')
    a = ap.parse_args()

    out, seen = {}, set()
    for path in a.inputs:
        with open(path) as f:
            elements = json.load(f)['elements']
        for wid, L, ll in features(elements):
            if wid in seen or len(ll) < 2:
                continue
            seen.add(wid)
            pts = [proj(lon, lat) for lon, lat in ll]
            if not any(inside(x, y, 400) for x, y in pts):
                continue
            pts = simplify([(round(x), round(y)) for x, y in pts], 1.5)
            out.setdefault(L, []).append(delta_encode(pts))
    with open(a.out, 'w') as f:
        json.dump({'source': 'OpenStreetMap contributors (ODbL)', 'layers': out}, f, separators=(',', ':'))
    print({k: len(v) for k, v in out.items()}, 'features')


if __name__ == '__main__':
    main()
