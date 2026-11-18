// Shared by api/add-spare-column.js (the experiment) and api/migrate.js:
// uses a tenant's own Vercel Personal Access Token to read that project's
// POSTGRES_URL environment variable, so we can open a direct Postgres
// connection to the tenant's database.
//
// Only works while Vercel will hand back the variable's value — a variable
// stored as type "sensitive" can never be read back through the API, and
// this throws a clear error saying so instead of guessing.

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

  if (chosen.value && chosen.value.startsWith('postgres')) {
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
      "Sensitive environment variables cannot be read back through the API, so this approach " +
      "cannot reach this tenant's database."
  );
}

module.exports = { vercelGet, getPostgresUrl };
