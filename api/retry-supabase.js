const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { runVercel } = require('../lib/vercel-cli');

function extractAcceptTermsUrl(text) {
  const match = text.match(/https:\/\/vercel\.com\/\S*accept-terms\S*/);
  return match ? match[0] : null;
}

async function withOpenUrlCapture(workDir) {
  const binDir = path.join(workDir, 'bin');
  const capturedUrlFile = path.join(workDir, 'accept-terms-url.txt');
  await fs.mkdir(binDir, { recursive: true });
  const stubPath = path.join(binDir, 'xdg-open');
  await fs.writeFile(stubPath, `#!/bin/sh\necho "$1" > "${capturedUrlFile}"\nexit 0\n`);
  await fs.chmod(stubPath, 0o755);
  return {
    extraPath: binDir,
    async readCapturedUrl() {
      try {
        const contents = (await fs.readFile(capturedUrlFile, 'utf8')).trim();
        return contents || null;
      } catch {
        return null;
      }
    },
  };
}

// Called once a tenant has clicked through the one-time Supabase Marketplace
// terms-acceptance page that api/run.js's needsSupabaseConfirmation flow
// surfaced. This is a separate, stateless invocation from api/run.js — like
// api/deploy.js, nothing on disk persists between them — so it re-links to
// the already-created project by name before retrying the integration.
// Blob and AUTH_SECRET were already handled during the original api/run.js
// call regardless of how the Supabase step went, so this only redoes
// Supabase.
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

    const { extraPath, readCapturedUrl } = await withOpenUrlCapture(workDir);

    console.log('[supabase] retry starting');
    const supabaseStart = Date.now();
    try {
      await runVercel(
        ['integration', 'add', 'supabase', '--token', token, ...scopeArgs],
        { cwd: appDir, homeDir: workDir, timeoutMs: 40_000, extraPath }
      );
      console.log(`[supabase] retry done after ${Date.now() - supabaseStart}ms`);
      res.status(200).json({ ok: true });
    } catch (err) {
      console.log('[supabase] retry failed:', err.message);
      const capturedUrl = await readCapturedUrl();
      const foundUrl =
        capturedUrl || extractAcceptTermsUrl(`${err.stdout || ''}\n${err.stderr || ''}`);
      if (foundUrl) {
        // Terms still weren't accepted (wrong tab, different account, etc.)
        // — ask again instead of silently giving up.
        res.status(200).json({ ok: false, needsSupabaseConfirmation: true, acceptTermsUrl: foundUrl });
      } else {
        res.status(500).json({ error: err.message, stderr: err.stderr, stdout: err.stdout });
      }
    }
  } catch (err) {
    console.log('[fatal]', err.message, 'stdout:', err.stdout, 'stderr:', err.stderr);
    res.status(500).json({ error: err.message, stderr: err.stderr, stdout: err.stdout });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
};
