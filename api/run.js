const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { runVercel } = require('../lib/vercel-cli');
const { fetchTemplateInto } = require('../lib/fetch-template');

function extractUrl(stdout) {
  const matches = stdout.match(/https?:\/\/\S+/g);
  return matches ? matches[matches.length - 1] : null;
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

  const { token, teamId, domain, authSecret } = req.body || {};

  if (!token || !domain || !authSecret) {
    res.status(400).json({ error: 'Missing required fields: token, domain, authSecret' });
    return;
  }

  // Same charset itemlogs-website's own domain validator enforces — belt
  // and suspenders, since this value flows into CLI args.
  if (!/^[a-z0-9-]{3,63}$/.test(domain)) {
    res.status(400).json({ error: 'Invalid domain' });
    return;
  }

  const scopeArgs = teamId ? ['--scope', teamId] : [];
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'itemlogs-'));
  const warnings = [];

  try {
    await fetchTemplateInto(workDir);

    // First deploy: creates the project (a PAT carries the user's real
    // Owner/Member permissions, unlike an OAuth Integration token, so this
    // works where our earlier OAuth-based attempts got a 403). No env vars
    // are attached yet, so this build will likely fail at runtime — that's
    // expected and fixed by the redeploy at the end of this sequence.
    await runVercel(
      ['deploy', '--token', token, '--yes', '--name', domain, ...scopeArgs],
      { cwd: workDir, timeoutMs: 180_000 }
    );

    // Blob store — auto-connects to the project this directory is now
    // linked to (linking happens automatically as a side effect of deploy).
    try {
      await runVercel(
        ['blob', 'create-store', `${domain}-images`, '--access', 'public', '--yes', '--token', token],
        { cwd: workDir, timeoutMs: 60_000 }
      );
    } catch (err) {
      warnings.push(`Blob store creation failed: ${err.message}`);
    }

    // Supabase Marketplace resource — Vercel-native, billed through Vercel,
    // no separate Supabase account needed. Also auto-connects to the linked
    // project by default.
    try {
      await runVercel(
        ['integration', 'add', 'supabase', '--token', token, ...scopeArgs],
        { cwd: workDir, timeoutMs: 120_000 }
      );
    } catch (err) {
      warnings.push(`Supabase provisioning failed: ${err.message}`);
    }

    // AUTH_SECRET is the one value we generate ourselves rather than
    // depending on a Marketplace resource, so set it directly.
    try {
      await runVercel(
        ['env', 'add', 'AUTH_SECRET', 'production', '--token', token, '--force'],
        { cwd: workDir, input: authSecret, timeoutMs: 30_000 }
      );
    } catch (err) {
      warnings.push(`Setting AUTH_SECRET failed: ${err.message}`);
    }

    // Final production deploy, now that Blob/Supabase/env vars are (best
    // effort) attached — this is the build the tenant actually sees.
    const { stdout } = await runVercel(
      ['deploy', '--token', token, '--yes', '--prod', ...scopeArgs],
      { cwd: workDir, timeoutMs: 180_000 }
    );

    const deploymentUrl = extractUrl(stdout);

    res.status(200).json({ deploymentUrl, warnings });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      stderr: err.stderr,
      warnings,
    });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
};
