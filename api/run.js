const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { runVercel } = require('../lib/vercel-cli');

// Pulls the one-time Marketplace terms-acceptance link out of `vercel
// integration add`'s output, when this is the first time this Vercel
// account/team is installing a given integration. Accepting Marketplace
// terms is a real legal-consent action tied to the human account, not
// something any CLI flag can skip — so the best we can do is hand the
// tenant the exact URL to click, once, per account.
function extractAcceptTermsUrl(text) {
  const match = text.match(/https:\/\/vercel\.com\/\S*accept-terms\S*/);
  return match ? match[0] : null;
}

// `vercel integration add` never prints the accept-terms URL as text — it
// shells out straight to `xdg-open <url>` to launch a browser, and in this
// headless runner that binary doesn't exist, so the CLI crashes with
// `spawn xdg-open ENOENT` before the URL ever reaches stdout/stderr for
// extractAcceptTermsUrl() to find. Standing in a fake `xdg-open` ahead of it
// on PATH lets the CLI "succeed" at opening the browser (our stub just
// records the argument and exits 0) so we get the real URL directly instead
// of guessing at it from crash text.
async function withOpenUrlCapture(workDir) {
  const binDir = path.join(workDir, 'bin');
  const capturedUrlFile = path.join(workDir, 'accept-terms-url.txt');
  await fs.mkdir(binDir, { recursive: true });
  const stubPath = path.join(binDir, 'xdg-open');
  await fs.writeFile(stubPath, `#!/bin/sh\necho "$1" > "${capturedUrlFile}"\nexit 0\n`);
  await fs.chmod(stubPath, 0o755);
  return {
    extraPath: binDir,
    capturedUrlFile,
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

// This endpoint does the fast half of provisioning: create/link the
// project, attach Blob + Supabase, and set AUTH_SECRET. Measured at
// roughly 14 seconds total (link ~2s, blob ~3s, the expected first-time
// Supabase terms failure ~7s, env ~2s), comfortably inside one request.
//
// The actual app deploy — a real Next.js production build, the genuinely
// slow part — used to run here too, but a full sequence of link + deploy +
// blob + supabase + env + a second deploy reliably took 55-60+ seconds and
// got killed by Vercel's own maxDuration: 60s cap (Hobby plan's max) with
// no clean error, just a silent platform kill. It's been split out to
// api/deploy.js, called separately and asynchronously by itemlogs-website
// (via Cloudflare's ctx.waitUntil) after this endpoint returns, so the
// tenant's browser isn't stuck waiting on one long request and the deploy
// step gets its own full time budget instead of competing with everything
// else for the same 60 seconds.
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

  // Same charset itemlogs-website's own domain validator enforces — belt
  // and suspenders, since this value flows into CLI args.
  if (!/^[a-z0-9-]{3,63}$/.test(domain)) {
    res.status(400).json({ error: 'Invalid domain' });
    return;
  }

  const scopeArgs = teamId ? ['--scope', teamId] : [];
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'itemlogs-'));
  // lib/vercel-cli.js points HOME at a directory distinct from the deploy
  // cwd on purpose — if they're the same directory, the CLI's "You are
  // deploying your home directory. Do you want to continue? (y/N)" guard
  // fires (not silenced by --yes) and hangs forever.
  const appDir = path.join(workDir, 'app');
  const warnings = [];

  try {
    await fs.mkdir(appDir, { recursive: true });

    // Explicitly create + link the project. `vercel link --yes --project
    // <name>` creates it if it doesn't exist yet, or reattaches to it by
    // name if it does (which is what api/deploy.js relies on afterward,
    // since that's a separate, stateless invocation with nothing shared on
    // disk from this one).
    console.log('[link] starting');
    const linkStart = Date.now();
    await runVercel(
      ['link', '--yes', '--project', domain, '--token', token, ...scopeArgs],
      { cwd: appDir, homeDir: workDir, timeoutMs: 40_000 }
    );
    console.log(`[link] done after ${Date.now() - linkStart}ms`);

    // Blob store — auto-connects to the linked project.
    try {
      console.log('[blob] starting');
      const blobStart = Date.now();
      await runVercel(
        ['blob', 'create-store', `${domain}-images`, '--access', 'public', '--yes', '--token', token],
        { cwd: appDir, homeDir: workDir, timeoutMs: 40_000 }
      );
      console.log(`[blob] done after ${Date.now() - blobStart}ms`);
    } catch (err) {
      console.log('[blob] failed:', err.message);
      warnings.push(`Blob store creation failed: ${err.message}`);
    }

    // Supabase Marketplace resource — Vercel-native, billed through Vercel,
    // no separate Supabase account needed. Also auto-connects to the linked
    // project by default.
    //
    // The very first time a given Vercel account/team installs ANY
    // Marketplace integration, Vercel requires a one-time, human
    // terms-acceptance click through a browser — there's no CLI flag to
    // skip this, it's a real consent step tied to the account, not
    // something we can script around. In this headless environment that
    // browser-open attempt itself throws (no browser to open), so we catch
    // it, pull the exact accept-terms URL out of the CLI's output, and
    // surface it as an actionable warning instead of a raw stack trace.
    let needsSupabaseConfirmation = false;
    let acceptTermsUrl = null;
    try {
      console.log('[supabase] starting');
      const supabaseStart = Date.now();
      const { extraPath, capturedUrlFile, readCapturedUrl } = await withOpenUrlCapture(workDir);
      try {
        const result = await runVercel(
          ['integration', 'add', 'supabase', '--token', token, ...scopeArgs],
          { cwd: appDir, homeDir: workDir, timeoutMs: 40_000, extraPath, watchFile: capturedUrlFile }
        );
        if (result.watchedFileContent) {
          // The CLI reached the "open a browser" call — our stub caught it
          // and we killed the CLI immediately rather than riding out the
          // full 40s timeout waiting for a human that isn't here.
          needsSupabaseConfirmation = true;
          acceptTermsUrl = result.watchedFileContent;
          console.log(
            `[supabase] captured accept-terms url after ${Date.now() - supabaseStart}ms:`,
            acceptTermsUrl
          );
          warnings.push(
            `Supabase needs a one-time approval on your Vercel account before your database can attach.`
          );
        } else {
          console.log(`[supabase] done after ${Date.now() - supabaseStart}ms`);
        }
      } catch (err) {
        console.log('[supabase] failed:', err.message);
        const capturedUrl = await readCapturedUrl();
        const foundUrl =
          capturedUrl || extractAcceptTermsUrl(`${err.stdout || ''}\n${err.stderr || ''}`);
        if (foundUrl) {
          needsSupabaseConfirmation = true;
          acceptTermsUrl = foundUrl;
          console.log('[supabase] captured accept-terms url:', foundUrl);
          warnings.push(
            `Supabase needs a one-time approval on your Vercel account before your database can attach.`
          );
        } else {
          warnings.push(`Supabase provisioning failed: ${err.message}`);
        }
      }
    } catch (err) {
      console.log('[supabase] setup error:', err.message);
      warnings.push(`Supabase provisioning failed: ${err.message}`);
    }

    // AUTH_SECRET is the one value we generate ourselves rather than
    // depending on a Marketplace resource, so set it directly.
    try {
      console.log('[env] starting');
      const envStart = Date.now();
      await runVercel(
        ['env', 'add', 'AUTH_SECRET', 'production', '--token', token, '--force'],
        { cwd: appDir, homeDir: workDir, input: req.body.authSecret, timeoutMs: 30_000 }
      );
      console.log(`[env] done after ${Date.now() - envStart}ms`);
    } catch (err) {
      console.log('[env] failed:', err.message);
      warnings.push(`Setting AUTH_SECRET failed: ${err.message}`);
    }

    res.status(200).json({ ok: true, warnings, needsSupabaseConfirmation, acceptTermsUrl });
  } catch (err) {
    // Log to the runner's own Vercel logs too, not just the JSON response —
    // if the Cloudflare Worker side times out first, it never sees this
    // response body at all, so the logs are the only place this shows up.
    console.log('[fatal]', err.message, 'stdout:', err.stdout, 'stderr:', err.stderr);
    res.status(500).json({
      error: err.message,
      stderr: err.stderr,
      stdout: err.stdout,
      warnings,
    });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
};
