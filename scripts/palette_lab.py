"""Data for the palette lab (palettes/index.html): a small crop of the web map.

Keeps buildings (by class), parks, water and trees inside a box of the shared local frame -> palettes/data/crop.json.
With --bundle also writes palettes/dist/index.html, a single self-contained page with the crop inlined.
usage: python scripts/palette_lab.py [--box X0 Y0 X1 Y1] [--bundle]
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # works under python -I too
from frame import delta_decode, delta_encode, unb64

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
DATA, LAB = os.path.join(ROOT, 'web', 'data'), os.path.join(ROOT, 'palettes')
DEFAULT_BOX = (-3200, -1700, 1800, 1300)          # Manzanares to Retiro


def load(name):
    with open(os.path.join(DATA, name)) as f:
        return json.load(f)


def crop(box):
    X0, Y0, X1, Y1 = box

    def keep(pts):
        return any(X0 <= x <= X1 and Y0 <= y <= Y1 for x, y in pts)

    def enc(pts):
        return delta_encode(pts, X0, Y0)

    buildings = []
    for c in load('buildings.json')['rings']:
        lens, d, j, rings = unb64(c['len'], 'H'), unb64(c['d'], 'h'), 0, []
        for n in lens:
            pts = delta_decode(d[j:j + 2 * n])
            j += 2 * n
            if keep(pts):
                rings.append(enc(pts))
        buildings.append(rings)

    osm = load('osm.json')['layers']
    layers = {k: [enc(p) for p in map(delta_decode, osm.get(k, [])) if keep(p)] for k in ('green', 'water')}

    t = load('trees.json')
    tx, ty, th = unb64(t['x'], 'h'), unb64(t['y'], 'h'), unb64(t['h_quarter_m'], 'B')
    trees = []
    for x, y, h in zip(tx, ty, th):
        if X0 <= x <= X1 and Y0 <= y <= Y1:
            trees += [x - X0, y - Y0, h]

    return {'box': list(box), 'buildings': buildings, 'green': layers['green'], 'water': layers['water'], 'trees': trees,
            'note': 'Crop of the Madrid map data: Catastro buildings, OSM parks/water, Ayuntamiento de Madrid trees 2026'}


def bundle(data):
    """Inline the crop into the page so it opens without a server."""
    with open(os.path.join(LAB, 'index.html')) as f:
        page = f.read()
    inline = json.dumps(data, separators=(',', ':')).replace('</', '<\\/')
    assert '<script>' in page
    page = page.replace('<script>', f'<script type="application/json" id="crop-data">{inline}</script>\n<script>', 1)
    os.makedirs(os.path.join(LAB, 'dist'), exist_ok=True)
    with open(os.path.join(LAB, 'dist', 'index.html'), 'w') as f:
        f.write(page)
    print('wrote palettes/dist/index.html', len(page) // 1024, 'KB')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--box', nargs=4, type=int, default=DEFAULT_BOX, metavar=('X0', 'Y0', 'X1', 'Y1'))
    ap.add_argument('--bundle', action='store_true')
    a = ap.parse_args()

    data = crop(a.box)
    os.makedirs(os.path.join(LAB, 'data'), exist_ok=True)
    with open(os.path.join(LAB, 'data', 'crop.json'), 'w') as f:
        json.dump(data, f, separators=(',', ':'))
    print('buildings', [len(b) for b in data['buildings']], 'green', len(data['green']),
          'water', len(data['water']), 'trees', len(data['trees']) // 3)
    if a.bundle:
        bundle(data)


if __name__ == '__main__':
    main()
