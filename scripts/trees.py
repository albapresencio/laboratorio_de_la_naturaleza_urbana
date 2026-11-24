"""Madrid tree inventory shapefile (ARBOLADO_MADRID_7_7_26) -> compact web/data/trees.json.

Positions are int16 metres in the shared local frame, species an index into `species`, height in quarter metres.
usage: python scripts/trees.py <dir with ARBOLADO_MADRID_7_7_26.shp/.dbf> [out.json]
"""
import argparse
import array
import collections
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # works under python -I too
from frame import HALF_H, HALF_W, LAT0, LON0, b64, inside, proj

BASENAME = 'ARBOLADO_MADRID_7_7_26'
SOURCE = 'Ayuntamiento de Madrid, Arbolado 2026 (ARBOLADO_MADRID_7_7_26), datos.madrid.es'


def read_points(base):
    """Yields (lon, lat, record) for each point in a .shp, with its .dbf record as a field -> str dict."""
    with open(base + '.shp', 'rb') as shp, open(base + '.dbf', 'rb') as dbf:
        n, header_len, rec_len = struct.unpack('<IHH', dbf.read(32)[4:12])
        fields, off = {}, 1
        while True:
            b = dbf.read(32)
            if b[0] == 0x0d:
                break
            fields[b[:11].split(b'\0')[0].decode()] = (off, b[16])
            off += b[16]
        dbf.seek(header_len)
        shp.seek(100)
        for _ in range(n):
            content_len = struct.unpack('>I', shp.read(8)[4:])[0] * 2
            body, rec = shp.read(content_len), dbf.read(rec_len)
            if struct.unpack('<i', body[:4])[0] != 1:          # not a point
                continue
            lon, lat = struct.unpack('<2d', body[4:20])
            yield lon, lat, {k: rec[o:o + ln].decode('utf-8', 'replace').strip() for k, (o, ln) in fields.items()}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('src')
    ap.add_argument('out', nargs='?', default='web/data/trees.json')
    a = ap.parse_args()

    xs, ys, sp, hs = array.array('h'), array.array('h'), array.array('H'), array.array('B')
    names, idx, count = [], {}, collections.Counter()
    for lon, lat, rec in read_points(os.path.join(a.src, BASENAME)):
        x, y = proj(lon, lat)
        if not inside(x, y):
            continue
        s = rec.get('ESPECIE') or 'Sin especie'
        if s not in idx:
            idx[s] = len(names)
            names.append(s)
        count[s] += 1
        try:
            height = float(rec.get('ALTURA_TOT') or 0)
        except ValueError:
            height = 0
        xs.append(round(x))
        ys.append(round(y))
        sp.append(idx[s])
        hs.append(max(0, min(255, round(height * 4))))

    with open(a.out, 'w') as f:
        json.dump({'source': SOURCE, 'origin': [LON0, LAT0], 'frame': [HALF_W, HALF_H], 'count': len(xs),
                   'species': names, 'speciesCount': [count[s] for s in names],
                   'x': b64(xs), 'y': b64(ys), 's': b64(sp), 'h_quarter_m': b64(hs)}, f)
    print(len(xs), 'trees in frame;', len(names), 'species; top:', count.most_common(8))


if __name__ == '__main__':
    main()
