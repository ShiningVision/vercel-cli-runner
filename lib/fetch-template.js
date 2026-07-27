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
async function fetchTemplateInto(destDir) {
  const res = await fetch(TEMPLATE_TARBALL_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch template tarball: ${res.status}`);
  }
  const compressed = Buffer.from(await res.arrayBuffer());
  const buffer = zlib.gunzipSync(compressed);
  const entries = parseTar(buffer);

  for (const entry of entries) {
    const slashIndex = entry.name.indexOf('/');
    const relPath = slashIndex >= 0 ? entry.name.slice(slashIndex + 1) : entry.name;
    if (!relPath) continue;

    const fullPath = path.join(destDir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, entry.content);
  }
}

module.exports = { fetchTemplateInto };
