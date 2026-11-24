"""OSM place names -> web/data/places.json, used to name the map's grid squares.

Keeps named nodes tagged place = suburb (in Madrid: districts), quarter (barrios), neighbourhood and square,
as [name, type, x, y] in the shared local frame. The page picks, for each square, the nearest name of a level
that suits the square's size.
usage: python scripts/places.py <overpass.json> [out.json]
Overpass query (frame + 2 km):
  [out:json];node["place"~"^(suburb|quarter|neighbourhood|square)$"]["name"](40.336,-3.787,40.500,-3.597);out;
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # works under python -I too
from frame import inside, proj

TYPES = ('suburb', 'quarter', 'neighbourhood', 'square')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('overpass')
    ap.add_argument('out', nargs='?', default='web/data/places.json')
    a = ap.parse_args()

    with open(a.overpass) as f:
        elements = json.load(f)['elements']
    places = []
    for e in elements:
        t = e.get('tags', {})
        if e['type'] != 'node' or t.get('place') not in TYPES or not t.get('name'):
            continue
        x, y = proj(e['lon'], e['lat'])
        if inside(x, y, 2048):
            places.append([t['name'], t['place'], round(x), round(y)])
    places.sort(key=lambda p: (TYPES.index(p[1]), p[0]))
    with open(a.out, 'w') as f:
        json.dump({'source': 'OpenStreetMap contributors (ODbL)', 'fields': ['name', 'type', 'x', 'y'], 'places': places},
                  f, ensure_ascii=False, separators=(',', ':'))
    print(len(places), 'places', {k: sum(p[1] == k for p in places) for k in TYPES})


if __name__ == '__main__':
    main()
