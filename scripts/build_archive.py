"""The archive database: db/casos.xlsx + db/media/ -> web/data/cases.json + web/media/.

The spreadsheet is the source of truth for the archive cases; db/media holds the photos, audio and documents
it refers to. This script validates both and, if everything is in order, writes what the map reads:
  web/data/cases.json   the cases, geolocated, with their items
  web/media/...         the media files the cases use (photos larger than MAX_PX are scaled down)

usage: python scripts/build_archive.py            validate and build
       python scripts/build_archive.py --check    validate only
Exits with status 1 when there are errors; warnings do not stop the build.

Sheet "casos", one row per case:
  id        short unique name: lowercase letters, digits and hyphens (plaza-mayor)
  n         catalogue number (Nº 001). Optional: empty rows get the next free number
  titulo    title shown on the map
  fecha     free text (1933 / hoy)
  lon, lat  WGS84 degrees, inside the map frame
  radio_m   empty for an exact location; for an approximate one, the uncertainty radius in metres
  muestra   "sí" for placeholder cases that are still to be replaced
Sheet "elementos", one row per item, shown in row order:
  caso              id of the case it belongs to
  tipo              par (before/after photos), foto, texto, audio or archivo
  archivo           file in db/media: a path (fotos/x.jpg) or just its name if that is unique.
                    For "par", the "before" photo
  etiqueta          caption. For "par", the caption of the "before" photo
  texto             body of a "texto" item
  archivo_despues   for "par": the "after" photo
  etiqueta_despues  for "par": its caption
"""
import argparse
import json
import os
import re
import shutil
import sys

from openpyxl import load_workbook
from PIL import Image, ImageOps

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # works under python -I too
from frame import inside, proj

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
XLSX = os.path.join(ROOT, 'db', 'casos.xlsx')
MEDIA = os.path.join(ROOT, 'db', 'media')
OUT_JSON = os.path.join(ROOT, 'web', 'data', 'cases.json')
OUT_MEDIA = os.path.join(ROOT, 'web', 'media')
MAX_PX = 2000                         # longest side of a photo on the web

CASE_COLS = ['id', 'n', 'titulo', 'fecha', 'lon', 'lat', 'radio_m', 'muestra']
ITEM_COLS = ['caso', 'tipo', 'archivo', 'etiqueta', 'texto', 'archivo_despues', 'etiqueta_despues']
TYPES = {'par': 'pair', 'foto': 'photo', 'texto': 'text', 'audio': 'audio', 'archivo': 'file'}
IMAGE_EXT = {'.jpg', '.jpeg', '.png', '.webp'}
AUDIO_EXT = {'.wav', '.mp3', '.ogg', '.m4a'}
YES, NO = {'sí', 'si', 's', 'x', 'yes', 'true', '1'}, {'', 'no', 'n', 'false', '0'}
ID_RE = re.compile(r'^[a-z0-9]+(-[a-z0-9]+)*$')
NOTE = ('Archive cases, built from db/casos.xlsx by scripts/build_archive.py: do not edit by hand. '
        'Each case is geolocated: exact (lon/lat) or approximate (lon/lat + r in metres). '
        'Items: pair {before,after}, photo {src,label}, text {body,label}, audio {src,label}, file {src,label}.')


class Report:
    def __init__(self):
        self.errors, self.warnings = [], []

    def error(self, where, msg):
        self.errors.append(f'{where}: {msg}')

    def warn(self, where, msg):
        self.warnings.append(f'{where}: {msg}')


def text(v):
    if v is None:
        return ''
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v).strip()


def read_sheet(wb, name, cols, rep):
    """Rows of a sheet as dicts keyed by the expected columns, with their spreadsheet row number."""
    if name not in wb.sheetnames:
        rep.error(XLSX, f'missing sheet "{name}"')
        return []
    rows = wb[name].iter_rows(values_only=True)
    header = [text(h).lower() for h in next(rows, ())]
    missing = [c for c in cols if c not in header]
    if missing:
        rep.error(f'{name}', f'missing columns: {", ".join(missing)}')
        return []
    out = []
    for i, row in enumerate(rows, start=2):
        rec = {c: row[header.index(c)] if header.index(c) < len(row) else None for c in cols}
        if all(text(v) == '' for v in rec.values()):
            continue                                                   # blank row
        rec['_where'] = f'{name}, row {i}'
        out.append(rec)
    return out


class MediaIndex:
    """Files under db/media, found by relative path or, when unique, by file name alone."""

    def __init__(self, root):
        self.files, self.by_name, self.used = set(), {}, set()
        for d, _, fs in os.walk(root):
            for f in fs:
                if f.startswith('.'):
                    continue
                rel = os.path.relpath(os.path.join(d, f), root).replace(os.sep, '/')
                self.files.add(rel)
                self.by_name.setdefault(f, []).append(rel)

    def resolve(self, ref, exts, where, rep):
        ref = text(ref).replace('\\', '/').strip('/')
        if not ref:
            rep.error(where, 'missing file')
            return None
        if ref in self.files:
            rel = ref
        else:
            hits = self.by_name.get(os.path.basename(ref), []) if '/' not in ref else []
            if len(hits) != 1:
                rep.error(where, f'file "{ref}" not found in db/media' if not hits else
                          f'"{ref}" is ambiguous, write its folder too: {", ".join(hits)}')
                return None
            rel = hits[0]
        if exts and os.path.splitext(rel)[1].lower() not in exts:
            rep.error(where, f'"{rel}" should be one of {", ".join(sorted(exts))}')
            return None
        self.used.add(rel)
        return rel


def parse_cases(rows, rep):
    cases, numbers = {}, set()
    for r in rows:
        w, cid = r['_where'], text(r['id'])
        if not ID_RE.match(cid):
            rep.error(w, f'id "{cid}" must be lowercase letters, digits and hyphens')
            continue
        if cid in cases:
            rep.error(w, f'duplicate id "{cid}"')
            continue
        c = {'id': cid, 'title': text(r['titulo'])}
        if not c['title']:
            rep.error(w, 'missing titulo')
        if text(r['n']):
            try:
                c['n'] = int(text(r['n']))
                if c['n'] < 1 or c['n'] in numbers:
                    raise ValueError
                numbers.add(c['n'])
            except ValueError:
                rep.error(w, f'n "{text(r["n"])}" must be a positive whole number, not used by another case')
        if text(r['fecha']):
            c['date'] = text(r['fecha'])
        try:
            c['lon'], c['lat'] = float(r['lon']), float(r['lat'])
            if not inside(*proj(c['lon'], c['lat'])):
                rep.error(w, f'{c["lat"]}, {c["lon"]} is outside the map frame (did you swap lon and lat?)')
        except (TypeError, ValueError):
            rep.error(w, 'lon and lat must be numbers (decimal degrees)')
        if text(r['radio_m']):
            try:
                c['r'] = int(round(float(text(r['radio_m']))))
                if c['r'] <= 0:
                    raise ValueError
            except ValueError:
                rep.error(w, 'radio_m must be a positive number of metres, or empty for an exact location')
        flag = text(r['muestra']).lower()
        if flag in YES:
            c['sample'] = True
        elif flag not in NO:
            rep.error(w, f'muestra "{flag}" must be "sí" or empty')
        c['items'] = []
        cases[cid] = c
    # number the cases that have no n, after the highest one in use
    nxt = max(numbers, default=0)
    for c in cases.values():
        if 'n' not in c:
            nxt += 1
            c['n'] = nxt
    return cases


def parse_items(rows, cases, media, rep):
    for r in rows:
        w, cid, kind = r['_where'], text(r['caso']), text(r['tipo']).lower()
        if cid not in cases:
            rep.error(w, f'caso "{cid}" is not an id in the "casos" sheet')
            continue
        if kind not in TYPES:
            rep.error(w, f'tipo "{kind}" must be one of {", ".join(TYPES)}')
            continue
        t, label = TYPES[kind], text(r['etiqueta'])
        if t == 'pair':
            before = media.resolve(r['archivo'], IMAGE_EXT, w + ' (archivo)', rep)
            after = media.resolve(r['archivo_despues'], IMAGE_EXT, w + ' (archivo_despues)', rep)
            if not label or not text(r['etiqueta_despues']):
                rep.error(w, 'a "par" needs both etiqueta and etiqueta_despues (e.g. 1933 / hoy)')
            item = {'type': t, 'before': {'src': before, 'label': label},
                    'after': {'src': after, 'label': text(r['etiqueta_despues'])}}
        elif t == 'text':
            body = text(r['texto'])
            if not body:
                rep.error(w, 'a "texto" needs its texto')
            item = {'type': t, 'label': label, 'body': body}
        else:
            exts = IMAGE_EXT if t == 'photo' else AUDIO_EXT if t == 'audio' else None
            item = {'type': t, 'src': media.resolve(r['archivo'], exts, w, rep), 'label': label}
        if t != 'pair' and text(r['archivo_despues']):
            rep.warn(w, f'archivo_despues is only used by "par"; ignored for "{kind}"')
        cases[cid]['items'].append(item)
    for c in cases.values():
        if not c['items']:
            rep.error(f'casos, id {c["id"]}', 'has no elementos; every case needs at least one')


def copy_media(rel):
    """db/media/rel -> web/media/rel, scaling photos down to MAX_PX."""
    src, dst = os.path.join(MEDIA, rel), os.path.join(OUT_MEDIA, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.splitext(rel)[1].lower() in IMAGE_EXT:
        with Image.open(src) as im:
            if max(im.size) > MAX_PX:
                im = ImageOps.exif_transpose(im)
                im.thumbnail((MAX_PX, MAX_PX), Image.LANCZOS)
                im.save(dst, quality=85, optimize=True)
                return
    shutil.copy2(src, dst)


def web_src(rel):
    return 'media/' + rel


def to_web(cases):
    out = []
    for c in sorted(cases.values(), key=lambda c: c['n']):
        items = []
        for it in c['items']:
            it = json.loads(json.dumps(it))
            for part in (it, it.get('before'), it.get('after')):
                if part and part.get('src'):
                    part['src'] = web_src(part['src'])
            items.append(it)
        out.append({**c, 'items': items})
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--check', action='store_true', help='validate only, write nothing')
    a = ap.parse_args()

    rep = Report()
    wb = load_workbook(XLSX, read_only=True, data_only=True)
    media = MediaIndex(MEDIA)
    cases = parse_cases(read_sheet(wb, 'casos', CASE_COLS, rep), rep)
    parse_items(read_sheet(wb, 'elementos', ITEM_COLS, rep), cases, media, rep)
    for rel in sorted(media.files - media.used):
        rep.warn('db/media', f'{rel} is not used by any case')

    for w in rep.warnings:
        print('warning:', w)
    for e in rep.errors:
        print('ERROR:  ', e)
    n_items = sum(len(c['items']) for c in cases.values())
    sys.stdout.flush()
    if rep.errors:
        sys.exit(f'{len(rep.errors)} error(s): nothing written. Fix db/casos.xlsx and run again.')
    print(f'ok: {len(cases)} cases, {n_items} items, {len(media.used)} media files')
    if a.check:
        return

    shutil.rmtree(OUT_MEDIA, ignore_errors=True)
    for rel in sorted(media.used):
        copy_media(rel)
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, 'w') as f:
        json.dump({'note': NOTE, 'cases': to_web(cases)}, f, ensure_ascii=False, indent=1)
    print(f'wrote {os.path.relpath(OUT_JSON, ROOT)} and {os.path.relpath(OUT_MEDIA, ROOT)}/')


if __name__ == '__main__':
    main()
