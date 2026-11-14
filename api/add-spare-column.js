const postgres = require('postgres');

// EXPERIMENT: can a tenant's Vercel Personal Access Token be used to alter
// that tenant's database schema? The token can read the project's env vars,
// POSTGRES_URL (set by the Supabase Marketplace integration) is one of them,
// and with it we can open a normal Postgres connection and run DDL.
//
// This only works if Vercel will hand back POSTGRES_URL's decrypted value.
// If the variable was stored as type "sensitive" it never can be read back
// through the API, and this endpoint reports exactly that instead of
// guessing.
//
// Modes:
//   list - read-only: reports the settings table's spare_toggle_N columns.
//   add  - ADD COLUMN IF NOT EXISTS spare_toggle_<max+1> BOOLEAN NOT NULL
//          DEFAULT false, then asks PostgREST to reload its schema cache so
//          the app's Supabase client can see the new column right away.
//
// Stateless like the other functions here: nothing persists between calls.

const VERCEL_API = 'https://api.vercel.com';

async function vercelGet(path, token, teamId, extraParams = {}) {
  const url = new URL(`${VERCEL_API}${path}`);
  if (teamId) url.searchParams.set('teamId', teamId);
  for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    throw new Error(`Vercel API ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return json;
}

async function getPostgresUrl(domain, token, teamId) {
  const list = await vercelGet(`/v9/projects/${encodeURIComponent(domain)}/env`, token, teamId, {
    decrypt: 'true',
  });
  const candidates = (list.envs || []).filter((e) => e.key === 'POSTGRES_URL');
  if (candidates.length === 0) {
    throw new Error('Project has no POSTGRES_URL environment variable.');
  }
  // Prefer the production-targeted one if there are several.
  const chosen = candidates.find((e) => (e.target || []).includes('production')) || candidates[0];

  if (chosen.value && !chosen.value.startsWith('eyJ')) {
    return { url: chosen.value, type: chosen.type };
  }
  // The list endpoint didn't return a usable plaintext value — ask for this
  // one variable directly.
  try {
    const one = await vercelGet(
      `/v1/projects/${encodeURIComponent(domain)}/env/${encodeURIComponent(chosen.id)}`,
      token,
      teamId
    );
    if (one && typeof one.value === 'string' && one.value.startsWith('postgres')) {
      return { url: one.value, type: chosen.type };
    }
  } catch {}

  throw new Error(
    `Vercel would not return POSTGRES_URL's value (variable type: "${chosen.type}"). ` +
      'Sensitive environment variables cannot be read back through the API, so this approach ' +
      'cannot reach this tenant\'s database.'
  );
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const authHeader = req.headers['authorization'] || '';
  const expected = `Bearer ${process.env.INTERNAL_SHARED_SECRET}`;
  if (!process.env.INTERNAL_SHARED_SECRET || authHeader !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { token, teamId, domain, mode } = req.body || {};
  if (!token || !domain) {
    res.status(400).json({ error: 'Missing required fields: token, domain' });
    return;
  }
  if (!/^[a-z0-9-]{3,63}$/.test(domain)) {
    res.status(400).json({ error: 'Invalid domain' });
    return;
  }
  if (mode !== 'list' && mode !== 'add') {
    res.status(400).json({ error: 'mode must be "list" or "add"' });
    return;
  }

  let sql;
  try {
    const { url, type } = await getPostgresUrl(domain, token, teamId);
    sql = postgres(url, { ssl: 'require', max: 1, connect_timeout: 15, idle_timeout: 5 });

    async function listToggleColumns() {
      const rows = await sql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'settings'
          AND column_name ~ '^spare_toggle_[0-9]+$'
      `;
      return rows
        .map((r) => r.column_name)
        .sort((a, b) => Number(a.split('_').pop()) - Number(b.split('_').pop()));
    }

    const before = await listToggleColumns();
    if (mode === 'list') {
      res.status(200).json({ ok: true, mode, envVarType: type, columns: before });
      return;
    }

    const highest = before.reduce((max, c) => Math.max(max, Number(c.split('_').pop())), 0);
    const next = highest + 1;
    if (!Number.isInteger(next) || next < 1 || next > 1000) {
      throw new Error(`Refusing to add column number ${next}.`);
    }
    const column = `spare_toggle_${next}`;

    // `column` is built only from a validated integer above.
    await sql.unsafe(
      `ALTER TABLE settings ADD COLUMN IF NOT EXISTS ${column} BOOLEAN NOT NULL DEFAULT false`
    );
    // PostgREST caches the schema; without this the new column can be
    // invisible to the app's Supabase client for a while.
    await sql`NOTIFY pgrst, 'reload schema'`;

    const after = await listToggleColumns();
    res.status(200).json({ ok: true, mode, envVarType: type, added: column, before, after });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    if (sql) await sql.end({ timeout: 5 }).catch(() => {});
  }
};
