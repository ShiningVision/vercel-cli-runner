// Minimal USTAR/GNU tar reader — a plain-JS port of the parser already used
// in itemlogs-website's own app/lib/tar.ts. Duplicated here (rather than
// shared) because this service is a separate, standalone Vercel project with
// its own package.json/build, not part of the Next.js app bundle.
//
// Format reference: a tar archive is a sequence of 512-byte header blocks,
// each followed by the file's content padded up to the next 512-byte
// boundary, terminated by (at least) two all-zero blocks.

const BLOCK_SIZE = 512;

function readString(buf, offset, length) {
  let end = offset;
  const limit = offset + length;
  while (end < limit && buf[end] !== 0) end++;
  return buf.toString('utf8', offset, end);
}

function readOctal(buf, offset, length) {
  const str = readString(buf, offset, length).trim();
  return str.length ? parseInt(str, 8) : 0;
}

/**
 * @param {Buffer} buffer
 * @returns {{ name: string, size: number, typeflag: string, content: Buffer }[]}
 */
function parseTar(buffer) {
  const entries = [];
  let offset = 0;

  while (offset + BLOCK_SIZE <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK_SIZE);

    if (header.every((b) => b === 0)) break;

    const nameField = readString(header, 0, 100);
    const prefixField = readString(header, 345, 155);
    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] || 0);
    const name = prefixField ? `${prefixField}/${nameField}` : nameField;

    offset += BLOCK_SIZE;

    const content = buffer.subarray(offset, offset + size);
    if (typeflag === '0' || typeflag === '\0') {
      entries.push({ name, size, typeflag, content: Buffer.from(content) });
    }

    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }

  return entries;
}

module.exports = { parseTar };
