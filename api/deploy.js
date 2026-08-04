const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { runVercel } = require('../lib/vercel-cli');
const { fetchTemplateInto } = require('../lib/fetch-template');

function extractUrl(stdout) {
  const matches = stdout.match(/https?:\/\/\S+/g);
  return matches ? matches[matches.length - 1] : null;
}

// A brand-new Vercel project's default `<project>.vercel.app` domain gets
// aliased to the latest READY production deployment automatically, entirely
// server-side, once the remote build finishes — no further CLI involvement
// needed. That makes it the right stable URL to hand back to the tenant,
// as opposed to the hashed per-deployment preview URL (e.g.
// itemlogs34-ksbz3a4id-betatester1.vercel.app) that `vercel deploy` prints,
// which is real but not what ends up being the long-term address.
function canonicalUrl(domain) {
  return `${domain}.vercel.app`;
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

    // --no-wait: don't block on the actual remote build. A real Next.js
    // production build here (native bcrypt/sharp compile + a from-scratch
    // pnpm install + `next build`) has been observed taking longer than the
    // 52s budget this step used to get, well within this single Vercel
    // Function's own 60s maxDuration cap — the CLI process would get killed
    // by our own timeout before the build finished, even though the
    // deployment was succeeding fine on Vercel's side the whole time
    // (confirmed live: the runner reported a timeout/failure, but the site
    // came up a bit later regardless). With --no-wait the CLI returns as
    // soon as the deployment is created and the source is uploaded —
    // seconds, not a minute — and the remote build simply continues after
    // we've already responded. Vercel serves its own "still building" splash
    // on the domain until it flips over automatically.
    console.log('[deploy] starting');
    const deployStart = Date.now();
    const { stdout, stderr } = await runVercel(
      ['deploy', '--token', token, '--yes', '--prod', '--no-wait', ...scopeArgs],
      { cwd: appDir, homeDir: workDir, timeoutMs: 30_000 }
    );
    console.log(`[deploy] done after ${Date.now() - deployStart}ms`);
    console.log('[deploy] stdout:', stdout);
    console.log('[deploy] stderr:', stderr);

    const deploymentUrl = canonicalUrl(domain);
    res.status(200).json({ ok: true, deploymentUrl, previewUrl: extractUrl(stdout) });
  } catch (err) {
    console.log('[fatal]', err.message, 'stdout:', err.stdout, 'stderr:', err.stderr);
    // Even a genuine timeout/error here doesn't necessarily mean the
    // deployment itself failed to kick off — `vercel deploy` had already
    // uploaded and queued the build by the time the CLI process printed
    // anything resembling a deployment URL. If we can see one in whatever
    // stdout was captured before the failure, the deploy is very likely
    // still proceeding on Vercel's side, so report success with the
    // canonical URL rather than a false "failed" that leaves the tenant
    // stuck despite the site coming up fine a bit later.
    const salvaged = extractUrl(`${err.stdout || ''}\n${err.stderr || ''}`);
    if (salvaged) {
      console.log('[deploy] salvaged url after error, treating as success:', salvaged);
      res.status(200).json({ ok: true, deploymentUrl: canonicalUrl(domain), previewUrl: salvaged });
      return;
    }
    res.status(500).json({ error: err.message, stderr: err.stderr, stdout: err.stdout });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
};
