"""Add a reviewed proposal (downloaded by `node scripts/propuestas.mjs importar <id>`) to the archive database.

It takes the next free Identificador, adds one row per photo to db/archivo_fotografias.xlsx (versions a, b, ...)
and copies the photos to db/fotografias/<n>-<v>.jpg. An exact location goes to the Coordenada column; an approximate
one (with a radius) to db/coordenadas_aproximadas.csv. Then run scripts/build_archive.py and, if all is well,
`node scripts/propuestas.mjs borrar <id>`.
usage: python scripts/importar_propuesta.py db/propuestas/<id> [--dry-run]
"""
import argparse
import csv
import json
import os
import shutil
import sys

from openpyxl import load_workbook

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # works under python -I too
import build_archive as db


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('folder')
    ap.add_argument('--dry-run', action='store_true', help='show what would be added, change nothing')
    a = ap.parse_args()

    with open(os.path.join(a.folder, 'caso.json')) as f:
        c = json.load(f)
    photos = [os.path.join(a.folder, p) for p in c.get('archivos', [])]
    if not photos or not all(os.path.exists(p) for p in photos):
        sys.exit(f'{a.folder}: falta caso.json o alguna foto; descárgala con `node scripts/propuestas.mjs importar <id>`')

    wb = load_workbook(db.XLSX)
    ws = wb.worksheets[0]
    header = [db.fold(h.value) for h in ws[1]]
    col = {k: header.index(name) for k, name in db.COLUMNS.items() if name in header}
    used = [int(float(r[col['id']])) for r in ws.iter_rows(min_row=2, values_only=True) if db.text(r[col['id']])]
    taken = [int(m.group(1)) for m in map(db.PHOTO_NAME.match, os.listdir(db.PHOTOS)) if m]   # photos without a row too
    n = max(used + taken, default=0) + 1
    source = ' · '.join(x for x in (c.get('fuente'), c.get('nombre') and f"aportada por {c['nombre']}") if x)
    exact = not c.get('radio')

    rows = []
    for i, _ in enumerate(photos):
        row = [None] * len(header)
        values = {'id': n, 'version': 'abcd'[i], 'year': c.get('fecha') or None, 'name': c.get('descripcion') or c['titulo'],
                  'source': source or None, 'place': c['titulo'],
                  'coord': f"{c['lat']:.5f}, {c['lon']:.5f}" if exact and i == 0 else None}
        for k, v in values.items():
            if k in col:
                row[col[k]] = v
        rows.append(row)

    print(f"Caso {n}: {c['titulo']} · {len(photos)} foto/s · "
          + (f"{c['lat']:.5f}, {c['lon']:.5f}" if exact else f"aprox. ±{c['radio']} m"))
    if a.dry_run:
        return
    # appended at the end: row order does not matter to the build, and inserting rows would detach the sheet's hyperlinks
    for row in rows:
        ws.append(row)
    wb.save(db.XLSX)
    for i, p in enumerate(photos):
        shutil.copy2(p, os.path.join(db.PHOTOS, f"{n}-{'abcd'[i]}.jpg"))
    if not exact:
        new = not os.path.exists(db.APPROX_CSV)
        with open(db.APPROX_CSV, 'a', newline='') as f:
            w = csv.writer(f, lineterminator='\n')
            if new:
                w.writerow(['identificador', 'lat', 'lon', 'radio_m', 'lugar'])
            w.writerow([n, f"{c['lat']:.5f}", f"{c['lon']:.5f}", c['radio'], c['titulo']])
    print(f'Añadido. Ahora: python scripts/build_archive.py  y luego  node scripts/propuestas.mjs borrar {c["id"]}')


if __name__ == '__main__':
    main()
