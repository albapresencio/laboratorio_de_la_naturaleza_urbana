# Laboratorio de la Naturaleza Urbana

A map of Madrid's urban nature: Catastro buildings, the 2026 municipal tree inventory, parks and water, the 1956 and
current orthophotos, and an archive of geolocated cases (photos, before/after pairs, texts, audio, documents).

## Layout

```
db/                    the archive database: edit this
  casos.xlsx           cases and their items (sheets "casos", "elementos"; "léeme" explains every column)
  media/               the photos, audio and documents the spreadsheet refers to
web/                   the site (static, no build step): index.html, app.js, app.css
  data/                map data: buildings.json, trees.json, osm.json (+ cases.json, generated)
  media/               generated from db/media
  tiles/1956/          1956 orthophoto tile pyramid
scripts/               data pipeline (Python)
palettes/              palette lab: the same map crop drawn in candidate palettes
```

## Setup

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Editing the archive

1. Put new photos, audio or documents in `db/media/` (any subfolder).
2. Add or edit rows in `db/casos.xlsx`: one row per case in `casos`, one row per item in `elementos`.
3. Validate and build:

```sh
.venv/bin/python scripts/build_archive.py --check   # validate only
.venv/bin/python scripts/build_archive.py           # validate, then write web/data/cases.json and web/media/
```

The script checks ids, coordinates (inside the map frame, lon/lat not swapped), radii, item types, captions, that every
file exists with the right extension and that every case has at least one item. On any error it writes nothing.
Photos larger than 2000 px are scaled down for the web. Unused files in `db/media` are reported as warnings.

## Running the site

The page loads its data with `fetch`, so serve it rather than opening the file:

```sh
.venv/bin/python scripts/build_archive.py
cd web && python3 -m http.server 8000      # http://localhost:8000
```

## Rebuilding the map data

The base layers are committed; rebuild them only when the sources change. All share the frame in `scripts/frame.py`.

| Script | Source | Output |
| --- | --- | --- |
| `buildings.py <gml>` | Catastro INSPIRE Buildings, `A.ES.SDGC.BU.28900.building.gml` | `web/data/buildings.json` |
| `trees.py <dir>` | Ayuntamiento de Madrid, `ARBOLADO_MADRID_7_7_26` shapefile (datos.madrid.es) | `web/data/trees.json` |
| `osm.py <out> <overpass.json...>` | Overpass API responses (parks, water) | `web/data/osm.json` |
| `ortho1956.py` | IGN WMS, Vuelo Americano Serie B 1956–57 (slow, resumable) | `web/tiles/1956/` |
| `palette_lab.py [--bundle]` | `web/data` | `palettes/data/crop.json` (+ `palettes/dist/index.html`) |
| `vegetation.py <images>` | street photos; needs `requirements-vegetation.txt` | `vegetation_out/` (Green View Index report) |

Sources: © Dirección General del Catastro; Ayuntamiento de Madrid; © OpenStreetMap contributors (ODbL);
orthophotos © Instituto Geográfico Nacional, CC BY 4.0.
