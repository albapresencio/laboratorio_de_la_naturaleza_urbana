"""Catastro INSPIRE building footprints (EPSG:25830 GML) -> web/data/buildings.json.

Rings are int16 metre deltas in the shared local frame, grouped by use class, base64-packed.
usage: python scripts/buildings.py <A.ES.SDGC.BU.28900.building.gml> [out.json]
"""
import argparse
import array
import json
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # works under python -I too
from frame import inside, proj, simplify, b64

CLASSES = ['residential', 'industrial', 'services and other']
CLASS_OF_USE = {'1_residential': 0, '3_industrial': 1, '2_agriculture': 1}   # anything else -> 2
SOURCE = 'Dirección General del Catastro, INSPIRE Buildings 28900 Madrid (Aug 2026)'

# UTM zone 30N (ETRS89, ~WGS84 at this scale) -> lon/lat
A, F = 6378137.0, 1 / 298.257222101
E2 = F * (2 - F)
EP2 = E2 / (1 - E2)
K0 = 0.9996
LON_C = math.radians(-3)
E1 = (1 - math.sqrt(1 - E2)) / (1 + math.sqrt(1 - E2))


def utm2ll(x, y):
    x -= 500000
    mu = y / K0 / (A * (1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256))
    p = (mu + (3 * E1 / 2 - 27 * E1 ** 3 / 32) * math.sin(2 * mu) + (21 * E1 ** 2 / 16 - 55 * E1 ** 4 / 32) * math.sin(4 * mu)
         + (151 * E1 ** 3 / 96) * math.sin(6 * mu) + (1097 * E1 ** 4 / 512) * math.sin(8 * mu))
    sp, cp, tp = math.sin(p), math.cos(p), math.tan(p)
    n = A / math.sqrt(1 - E2 * sp * sp)
    t, c = tp * tp, EP2 * cp * cp
    r = A * (1 - E2) / (1 - E2 * sp * sp) ** 1.5
    d = x / (n * K0)
    lat = p - (n * tp / r) * (d * d / 2 - (5 + 3 * t + 10 * c - 4 * c * c - 9 * EP2) * d ** 4 / 24
                             + (61 + 90 * t + 298 * c + 45 * t * t - 252 * EP2 - 3 * c * c) * d ** 6 / 720)
    lon = LON_C + (d - (1 + 2 * t + c) * d ** 3 / 6 + (5 - 2 * c + 28 * t - 3 * c * c + 8 * EP2 + 24 * t * t) * d ** 5 / 120) / cp
    return math.degrees(lon), math.degrees(lat)


def ring(pos_list):
    """A gml:posList string -> rounded local points, consecutive duplicates removed."""
    v = pos_list.split()
    pts = []
    for i in range(0, len(v) - 1, 2):
        x, y = proj(*utm2ll(float(v[i]), float(v[i + 1])))
        q = (round(x), round(y))
        if not pts or q != pts[-1]:
            pts.append(q)
    return pts


def read_buildings(path):
    """Yields (currentUse, [posList, ...]) per building, streaming the (large) GML file line by line."""
    pos_re = re.compile(r'<gml:posList[^>]*>([^<]*)</gml:posList>')
    use, rings = None, []
    with open(path, encoding='utf-8') as f:
        for line in f:
            if '<bu-ext2d:Building ' in line:
                if rings:
                    yield use, rings
                use, rings = None, []
            elif '<gml:posList' in line:
                m = pos_re.search(line)
                if m:
                    rings.append(m.group(1))
            elif '<bu-ext2d:currentUse>' in line:
                use = line.split('>')[1].split('<')[0].strip()
    if rings:
        yield use, rings


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('gml')
    ap.add_argument('out', nargs='?', default='web/data/buildings.json')
    a = ap.parse_args()

    by_class = [[] for _ in CLASSES]
    n_buildings = 0
    for use, pos_lists in read_buildings(a.gml):
        cls, kept = CLASS_OF_USE.get(use, 2), False
        for pos in pos_lists:
            pts = ring(pos)
            if len(pts) >= 4 and any(inside(x, y) for x, y in pts):
                pts = simplify(pts, 1.0)
                if len(pts) >= 4:
                    by_class[cls].append(pts)
                    kept = True
        n_buildings += kept

    packed = []
    for rings in by_class:
        lens, d = array.array('H'), array.array('h')
        for pts in rings:
            lens.append(len(pts))
            px = py = 0
            for x, y in pts:
                d.extend((x - px, y - py))
                px, py = x, y
        packed.append({'n': len(rings), 'len': b64(lens), 'd': b64(d)})
    with open(a.out, 'w') as f:
        json.dump({'source': SOURCE, 'classes': CLASSES, 'rings': packed}, f)
    print(n_buildings, 'buildings;', [len(c) for c in by_class], 'rings per class')


if __name__ == '__main__':
    main()
