"""Vuelo Americano Serie B (1956-57) orthophoto for the whole map frame -> web/tiles/1956/{L}/{c}_{r}.jpg

The IGN only serves this flight through a WMS that renders on demand (2-12 s per image), so we fetch it once
in 1 km chunks and cut it into our own tile pyramid, aligned to the map frame (local equirectangular metres).
Level L: 0.5 * 2**L m/px, 512 px tiles, column c from the west edge, row r from the south edge.
The tiles reach PAD metres beyond the frame on every side (negative indices west and south of it), so the
explorer's lens still shows 1956 when a square near the edge is opened.

usage: python scripts/ortho1956.py [out dir, default web/tiles/1956] [--pyramid-only]
       re-runs skip finished chunks; --pyramid-only rebuilds the coarser levels from whatever level 0 holds now
Source: (c) Instituto Geografico Nacional, CC BY 4.0.
"""
import argparse
import concurrent.futures as cf
import io
import math
import os
import sys
import time
import urllib.request

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # works under python -I too
from frame import HALF_H, HALF_W, unproj

RES, TILE, LEVELS = 0.5, 512, 5           # level 0 = 0.5 m/px ... level 4 = 8 m/px
CHUNK = 4                                  # level-0 tiles per chunk side: 2048 px = 1024 m
T0 = TILE * RES                            # level-0 tile side in metres (256 m)
PAD = 2 * CHUNK * T0                       # 2048 m beyond the frame (keep in step with T56.pad in web/app.js)
PT = int(PAD // T0)                            # ... in level-0 tiles
C_RANGE = range(-PT, math.ceil(2 * HALF_W / T0) + PT)   # level-0 columns
R_RANGE = range(-PT, math.ceil(2 * HALF_H / T0) + PT)   # level-0 rows
WMS = ('https://www.ign.es/wms/pnoa-historico?service=WMS&version=1.3.0&request=GetMap&layers=AMS_1956-1957'
       '&styles=&crs=EPSG:4326&bbox={la0:.7f},{lo0:.7f},{la1:.7f},{lo1:.7f}&width={px}&height={px}&format=image/jpeg')


class Pyramid:
    def __init__(self, out):
        self.out = out

    def path(self, L, c, r):
        return os.path.join(self.out, str(L), f'{c}_{r}.jpg')

    @staticmethod
    def save(im, p):
        os.makedirs(os.path.dirname(p), exist_ok=True)
        im.save(p, 'JPEG', quality=80, optimize=True, progressive=True)

    def chunk(self, cc, rr):
        """Fetch one CHUNK x CHUNK block of level-0 tiles. Returns 'ok', 'skip' or 'FAILED ...'."""
        c0, r0 = cc * CHUNK, rr * CHUNK
        todo = [(c, r) for c in range(c0, c0 + CHUNK) for r in range(r0, r0 + CHUNK) if c in C_RANGE and r in R_RANGE]
        if all(os.path.exists(self.path(0, c, r)) for c, r in todo):
            return 'skip'
        x0, y0, side = -HALF_W + c0 * T0, -HALF_H + r0 * T0, CHUNK * T0
        try:
            im = fetch(x0, y0, side, CHUNK * TILE)
        except Exception:
            # some areas make the IGN fail at 2048 px every time: ask for the four quarters instead
            try:
                h = CHUNK * TILE // 2
                im = Image.new('L', (CHUNK * TILE, CHUNK * TILE), 255)
                for i in range(2):
                    for j in range(2):
                        im.paste(fetch(x0 + i * side / 2, y0 + j * side / 2, side / 2, h), (i * h, (1 - j) * h))
            except Exception as e:
                return f'FAILED {cc},{rr}: {e}'
        for c, r in todo:                                              # image rows run north -> south
            i, j = c - c0, r - r0
            self.save(im.crop((i * TILE, (CHUNK - 1 - j) * TILE, (i + 1) * TILE, (CHUNK - j) * TILE)), self.path(0, c, r))
        return 'ok'

    def build_levels(self, quiet=False):
        """Coarser levels: each tile = 2x2 tiles of the level below, halved."""
        cs, rs = C_RANGE, R_RANGE
        for L in range(1, LEVELS):
            cs, rs = range(cs.start // 2, (cs.stop + 1) // 2), range(rs.start // 2, (rs.stop + 1) // 2)
            for c in cs:
                for r in rs:
                    kids = [(i, j, self.path(L - 1, 2 * c + i, 2 * r + j)) for i in range(2) for j in range(2)]
                    if not any(os.path.exists(p) for _, _, p in kids):
                        continue                                       # nothing downloaded here yet
                    im = Image.new('L', (2 * TILE, 2 * TILE), 255)
                    for i, j, p in kids:
                        if os.path.exists(p):
                            im.paste(Image.open(p), (i * TILE, (1 - j) * TILE))
                    self.save(im.resize((TILE, TILE), Image.LANCZOS), self.path(L, c, r))
            if not quiet:
                print(f'level {L}: {len(cs)} x {len(rs)}', flush=True)


def fetch(x0, y0, side, px, tries=4):
    lo0, la0 = unproj(x0, y0)
    lo1, la1 = unproj(x0 + side, y0 + side)
    url = WMS.format(la0=la0, lo0=lo0, la1=la1, lo1=lo1, px=px)
    req = urllib.request.Request(url, headers={'User-Agent': 'urban-nature-map/1.0'})
    for k in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=120) as f:
                return Image.open(io.BytesIO(f.read())).convert('L')   # the 1956 flight is black and white
        except Exception:
            if k == tries - 1:
                raise
            time.sleep(10 * (k + 1))                                   # IGN answers 502/500 under load: back off


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('out', nargs='?', default='web/tiles/1956')
    ap.add_argument('--pyramid-only', action='store_true')
    a = ap.parse_args()
    pyr = Pyramid(a.out)

    chunks = lambda rng: range(rng.start // CHUNK, -(-rng.stop // CHUNK))
    jobs = [] if a.pyramid_only else [(cc, rr) for cc in chunks(C_RANGE) for rr in chunks(R_RANGE)]
    jobs.sort(key=lambda j: ((j[0] + .5) * CHUNK * T0 - HALF_W) ** 2 + ((j[1] + .5) * CHUNK * T0 - HALF_H) ** 2)  # centre first
    print(f'{len(jobs)} chunks, level 0 = {len(C_RANGE)} x {len(R_RANGE)} tiles', flush=True)
    failed = []
    with cf.ThreadPoolExecutor(2) as ex:                               # be gentle with the IGN server
        for n, res in enumerate(ex.map(lambda j: pyr.chunk(*j), jobs), 1):
            if res.startswith('FAILED'):
                failed.append(res)
                print(' ', res, flush=True)
            if n % 10 == 0 or n == len(jobs):
                print(f'  {n}/{len(jobs)}', flush=True)
                pyr.build_levels(quiet=True)                           # new areas show up while it runs
    pyr.build_levels()
    if failed:
        sys.exit(f'{len(failed)} chunks failed; run again to fetch only those')
    print('done')


if __name__ == '__main__':
    main()
