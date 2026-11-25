/* The queue of proposed cases (sent from the map's "Añadir al archivo" form, stored in Vercel Blob).

   usage: node scripts/propuestas.mjs                  list pending proposals
          node scripts/propuestas.mjs importar <id>    download one into db/propuestas/<id>/ (caso.json + photos)
          node scripts/propuestas.mjs borrar <id>      remove it from the queue (after importing, or to reject it)
   then:  python scripts/importar_propuesta.py db/propuestas/<id>   adds it to the spreadsheet and db/fotografias

   Needs the project's Blob credentials: `npx vercel env pull .env.local` (again when they expire), then run with
   `node --env-file=.env.local ...`. The store is private, so files are read through the SDK, not by URL. */
import { list, del, get } from '@vercel/blob';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const [cmd, id] = process.argv.slice(2);

async function all(prefix) {
  const out = []; let cursor;
  do { const r = await list({ prefix, cursor, limit: 1000 }); out.push(...r.blobs); cursor = r.hasMore ? r.cursor : null; } while (cursor);
  return out;
}
async function read(pathname) {
  const r = await get(pathname, { access: 'private', useCache: false });
  if (!r || r.statusCode !== 200) throw new Error(`No se pudo leer ${pathname}`);
  return Buffer.from(await new Response(r.stream).arrayBuffer());
}
const readJSON = async pathname => JSON.parse((await read(pathname)).toString('utf8'));

if (!process.env.BLOB_READ_WRITE_TOKEN && !(process.env.VERCEL_OIDC_TOKEN && process.env.BLOB_STORE_ID)) {
  console.error('Faltan las credenciales del almacén: ejecuta `npx vercel env pull .env.local` y usa `node --env-file=.env.local ...`');
  process.exit(1);
}

if (!cmd) {
  const blobs = await all('propuestas/');
  const cases = blobs.filter(b => b.pathname.endsWith('/caso.json'));
  if (!cases.length) console.log('No hay propuestas pendientes.');
  for (const b of cases.sort((a, b) => a.pathname.localeCompare(b.pathname))) {
    const c = await readJSON(b.pathname);
    console.log(`${c.id}  ${c.titulo}  (${c.fecha || 's/f'}; ${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}${c.radio ? ' ±' + c.radio + ' m' : ''}; ${c.fotos.length} foto/s${c.nombre ? '; ' + c.nombre : ''})`);
  }
} else if (cmd === 'importar' && id) {
  const blobs = await all(`propuestas/${id}/`);
  const meta = blobs.find(b => b.pathname.endsWith('/caso.json'));
  if (!meta) { console.error(`No existe la propuesta ${id}.`); process.exit(1); }
  const c = await readJSON(meta.pathname), dir = path.join(ROOT, 'db', 'propuestas', id);
  await mkdir(dir, { recursive: true });
  c.archivos = [];
  for (const [i, pathname] of c.fotos.entries()) {
    const name = 'abcd'[i] + '.jpg';
    await writeFile(path.join(dir, name), await read(pathname));
    c.archivos.push(name);
  }
  await writeFile(path.join(dir, 'caso.json'), JSON.stringify(c, null, 1));
  console.log(`Descargada en db/propuestas/${id}/. Siguiente: python scripts/importar_propuesta.py db/propuestas/${id}`);
} else if (cmd === 'borrar' && id) {
  const blobs = await all(`propuestas/${id}/`);
  if (!blobs.length) { console.error(`No existe la propuesta ${id}.`); process.exit(1); }
  await del(blobs.map(b => b.url));
  console.log(`Borrada ${id} (${blobs.length} archivos).`);
} else {
  console.error('uso: node scripts/propuestas.mjs [importar <id> | borrar <id>]'); process.exit(1);
}
