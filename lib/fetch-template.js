const zlib = require('zlib');
const fs = require('fs/promises');
const path = require('path');
const { parseTar } = require('./tar');

const TEMPLATE_TARBALL_URL =
  'https://codeload.github.com/ShiningVision/itemlogs/tar.gz/refs/heads/main';

// Fetches the itemlogs template's source from GitHub and writes it out into
// destDir as real files, so `vercel deploy` can run against a normal
// directory. (This service runs on a real Node/Vercel Function runtime, not
// Cloudflare Workers, so there's no per-file subrequest cap to work around
// here — unlike itemlogs-website's own deploy pipeline, which has to inline
// everything into one request for that reason.)
//
// TEMPORARY: timing instrumentation. A registration attempt hit
// FUNCTION_INVOCATION_TIMEOUT (60s) with the GitHub tarball fetch as the
// *only* external call logged — it never even reached `vercel link`. The
// repo itself is tiny (1.1MB, 193 files), so something in this function is
// stalling, not legitimately slow. These checkpoints will show which
// sub-step (fetch, gunzip, tar parse, or the file-write loop) is actually
// eating the time. Remove once root-caused.
async function fetchTemplateInto(destDir) {
  const t0 = Date.now();
  console.log('[fetch-template] starting fetch:', TEMPLATE_TARBALL_URL);

  const res = await fetch(TEMPLATE_TARBALL_URL);
  const t1 = Date.now();
  console.log(`[fetch-template] fetch() resolved after ${t1 - t0}ms, status=${res.status}, content-length=${res.headers.get('content-length')}`);

  if (!res.ok) {
    throw new Error(`Failed to fetch template tarball: ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const t2 = Date.now();
  console.log(`[fetch-template] body read after ${t2 - t1}ms, bytes=${arrayBuffer.byteLength}`);

  const compressed = Buffer.from(arrayBuffer);
  const buffer = zlib.gunzipSync(compressed);
  const t3 = Date.now();
  console.log(`[fetch-template] gunzip done after ${t3 - t2}ms, decompressed bytes=${buffer.length}`);

  const entries = parseTar(buffer);
  const t4 = Date.now();
  console.log(`[fetch-template] tar parse done after ${t4 - t3}ms, entries=${entries.length}`);

  for (const entry of entries) {
    const slashIndex = entry.name.indexOf('/');
    const relPath = slashIndex >= 0 ? entry.name.slice(slashIndex + 1) : entry.name;
    if (!relPath) continue;

    const fullPath = path.join(destDir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, entry.content);
  }

  const t5 = Date.now();
  console.log(`[fetch-template] file writes done after ${t5 - t4}ms. Total: ${t5 - t0}ms`);
}

module.exports = { fetchTemplateInto };
