const postgres = require('postgres');
const { getPostgresUrl } = require('../lib/tenant-db');
const { migrations } = require('../lib/migrations');

// Applies lib/migrations.js to ONE tenant's database, using that tenant's own
// Vercel token to read its POSTGRES_URL (see lib/tenant-db.js).
//
// Modes:
//   status - read-only: which migrations are applied / pending.
//   apply  - run every pending migration in order, each in its own
//            transaction together with its schema_migrations record, then
//            tell PostgREST to reload its schema cache. Stops at the first
//            failure (later migrations may depend on earlier ones).
//
// Tracking lives in the tenant's own `schema_migrations` table, created on
// first use.

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
  if (mode !== 'status' && mode !== 'apply') {
    res.status(400).json({ error: 'mode must be "status" or "apply"' });
    return;
  }

  let sql;
  try {
    const { url } = await getPostgresUrl(domain, token, teamId);
    sql = postgres(url, { ssl: 'require', max: 1, connect_timeout: 15, idle_timeout: 5 });

    // A tenant whose setup never completed has no schema to migrate yet.
    const [{ exists: hasSettings }] = await sql`
      SELECT to_regclass('public.settings') IS NOT NULL AS exists
    `;
    if (!hasSettings) {
      res.status(200).json({ ok: true, mode, skipped: 'Tenant has no settings table yet (setup not completed).' });
      return;
    }

    let applied = [];
    const [{ exists: hasTracking }] = await sql`
      SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists
    `;
    if (hasTracking) {
      applied = (await sql`SELECT id FROM schema_migrations`).map((r) => r.id);
    }

    const pending = migrations.filter((m) => !applied.includes(m.id));

    if (mode === 'status') {
      res.status(200).json({
        ok: true,
        mode,
        applied,
        pending: pending.map((m) => m.id),
      });
      return;
    }

    if (!hasTracking) {
      await sql`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY`;
    }

    const ran = [];
    for (const m of pending) {
      try {
        await sql.begin(async (tx) => {
          // Statements come only from lib/migrations.js (our own code).
          for (const stmt of m.statements) await tx.unsafe(stmt);
          await tx`INSERT INTO schema_migrations (id) VALUES (${m.id}) ON CONFLICT (id) DO NOTHING`;
        });
        ran.push(m.id);
      } catch (err) {
        res.status(500).json({
          ok: false,
          mode,
          ran,
          failed: m.id,
          error: err.message,
        });
        return;
      }
    }

    if (ran.length > 0) {
      // PostgREST caches the schema; without this new columns can be
      // invisible to the app's Supabase client for a while.
      await sql`NOTIFY pgrst, 'reload schema'`;
    }

    res.status(200).json({ ok: true, mode, ran, alreadyApplied: applied });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    if (sql) await sql.end({ timeout: 5 }).catch(() => {});
  }
};
