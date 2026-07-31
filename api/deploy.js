const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { runVercel } = require('../lib/vercel-cli');
const { fetchTemplateInto } = require('../lib/fetch-template');

function extractUrl(stdout) {
  const matches = stdout.match(/https?:\/\/\S+/g);
  return matches ? matches[matches.length - 1] : null;
}

// The slow half of provisioning, split out from api/run.js so it gets its
// own full time budget instead of competing with link/blob/supabase/env
// for the same 60-second Vercel Function cap. itemlogs-website calls this
// asynchronously (via Cloudflare's ctx.waitUntil, after api/run.js has
// already returned to the tenant's browser) once the project has been
// created and linked.
//
// This is a separate, stateless Vercel Function invocation from the one
// api/run.js ran in — nothing on disk persists between them — so it
// re-links first. That's fast and safe: `vercel link --yes --project
// <name>` finds and reattaches to the already-created project by name
// rather than creating a duplicate.
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

  const { token, teamId, domain } = req.body || {};

  if (!token || !domain) {
    res.status(400).json({ error: 'Missing required fields: token, domain' });
    return;
  }
  if (!/^[a-z0-9-]{3,63}$/.test(domain)) {
    res.status(400).json({ error: 'Invalid domain' });
    return;
  }

  const scopeArgs = teamId ? ['--scope', teamId] : [];
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'itemlogs-'));
  const appDir = path.join(workDir, 'app');

  try {
    await fs.mkdir(appDir, { recursive: true });

    console.log('[link] starting');
    const linkStart = Date.now();
    await runVercel(
      ['link', '--yes', '--project', domain, '--token', token, ...scopeArgs],
      { cwd: appDir, homeDir: workDir, timeoutMs: 40_000 }
    );
    console.log(`[link] done after ${Date.now() - linkStart}ms`);

    console.log('[fetch-template] starting');
    const fetchStart = Date.now();
    await fetchTemplateInto(appDir);
    console.log(`[fetch-template] done after ${Date.now() - fetchStart}ms`);

    console.log('[deploy] starting');
    const deployStart = Date.now();
    const { stdout, stderr } = await runVercel(
      ['deploy', '--token', token, '--yes', '--prod', ...scopeArgs],
      { cwd: appDir, homeDir: workDir, timeoutMs: 50_000 }
    );
    console.log(`[deploy] done after ${Date.now() - deployStart}ms`);
    console.log('[deploy] stdout:', stdout);
    console.log('[deploy] stderr:', stderr);

    const deploymentUrl = extractUrl(stdout);
    res.status(200).json({ ok: true, deploymentUrl });
  } catch (err) {
    console.log('[fatal]', err.message, 'stdout:', err.stdout, 'stderr:', err.stderr);
    res.status(500).json({ error: err.message, stderr: err.stderr, stdout: err.stdout });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
};
