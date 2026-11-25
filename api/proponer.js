/* POST /api/proponer: a visitor proposes a case. It is queued in Vercel Blob under propuestas/<id>/ (caso.json and the
   photos) until the team reviews it with scripts/propuestas.mjs and adds it to db/ with scripts/importar_propuesta.py.

   Body (JSON, under Vercel's 4.5 MB limit: the page shrinks photos before sending):
     {titulo, fecha?, descripcion, fuente?, nombre?, lat, lon, radio (m, 0 = exact), fotos: [data:image/jpeg;base64,...] (1-4),
      web (honeypot: must stay empty)}
   Needs BLOB_READ_WRITE_TOKEN, which Vercel sets when a Blob store is connected to the project.
   Blobs are public but stored under random, unguessable names; no contact details are collected. */
import { put } from '@vercel/blob';
import { randomUUID } from 'node:crypto';

const FRAME = { lat: [40.33, 40.51], lon: [-3.79, -3.59] };   // Madrid, map frame plus a margin
const MAX_PHOTOS = 4, MAX_PHOTO_BYTES = 1.2e6;
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Solo POST' });
  const b = req.body || {};
  if (b.web) return res.status(200).json({ ok: true });          // a bot filled the hidden field: drop silently

  const caso = {
    titulo: clean(b.titulo, 140), fecha: clean(b.fecha, 40), descripcion: clean(b.descripcion, 2000),
    fuente: clean(b.fuente, 200), nombre: clean(b.nombre, 80),
    lat: Number(b.lat), lon: Number(b.lon), radio: Math.max(0, Math.min(3000, Math.round(Number(b.radio) || 0))),
  };
  const fotos = Array.isArray(b.fotos) ? b.fotos.slice(0, MAX_PHOTOS) : [];
  const errors = [];
  if (!caso.titulo) errors.push('Falta el título.');
  if (!caso.descripcion) errors.push('Falta la descripción.');
  if (!(caso.lat > FRAME.lat[0] && caso.lat < FRAME.lat[1] && caso.lon > FRAME.lon[0] && caso.lon < FRAME.lon[1]))
    errors.push('La ubicación está fuera del mapa.');
  if (!fotos.length) errors.push('Añade al menos una foto.');
  const images = [];
  for (const f of fotos) {
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(f));
    const buf = m && Buffer.from(m[1], 'base64');
    if (!buf || buf.length > MAX_PHOTO_BYTES || buf[0] !== 0xff || buf[1] !== 0xd8) { errors.push('Alguna foto no es válida.'); break; }
    images.push(buf);
  }
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });

  const id = new Date().toISOString().slice(0, 10) + '-' + randomUUID().slice(0, 8);
  try {
    caso.fotos = [];
    for (const [i, buf] of images.entries()) {
      const blob = await put(`propuestas/${id}/${'abcd'[i]}.jpg`, buf, { access: 'public', addRandomSuffix: true, contentType: 'image/jpeg' });
      caso.fotos.push(blob.url);
    }
    caso.id = id; caso.recibido = new Date().toISOString();
    await put(`propuestas/${id}/caso.json`, JSON.stringify(caso, null, 1), { access: 'public', addRandomSuffix: true, contentType: 'application/json' });
  } catch (e) {
    console.error('proponer:', e);
    return res.status(500).json({ error: 'No se pudo guardar la propuesta. Inténtalo más tarde.' });
  }
  return res.status(200).json({ ok: true, id });
}
