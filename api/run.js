const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { runVercel } = require('../lib/vercel-cli');
const { fetchTemplateInto } = require('../lib/fetch-template');

function extractUrl(stdout) {
  const matches = stdout.match(/https?:\/\/\S+/g);
  return matches ? matches[matches.length - 1] : null;
}

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
  // lib/vercel-cli.js points HOME at workDir (Vercel Functions' real $HOME
  // isn't writable). If the deployed source also lived directly in workDir,
  // cwd would equal $HOME, and the CLI's "You are deploying your home
  // directory. Do you want to continue? (y/N)" guard kicks in — a raw
  // stdin prompt that `--yes` doesn't silence and that hangs forever since
  // we never pipe an answer, eventually timing out. Deploying from a
  // subdirectory of workDir keeps cwd and HOME distinct so that guard never
  // fires, while .vercel/project.json (written relative to cwd) still lives
  // alongside app source consistently across every step in this sequence.
  const appDir = path.join(workDir, 'app');
  const warnings = [];

  try {
    await fs.mkdir(appDir, { recursive: true });
    await fetchTemplateInto(appDir);

    // Explicitly create + link the project first. The old approach relied
    // on `vercel deploy --name <domain>` to implicitly create a project as
    // a side effect, but `--name` is a deprecated no-op in current CLI
    // versions (Vercel's own docs confirm this) — it deployed successfully
    // without throwing, but never actually created or linked a named
    // project, which is why nothing showed up on the dashboard and every
    // later step failed with "Your codebase isn't linked to a project."
    // `vercel link --yes --project <name>` is the documented, non-deprecated
    // way to create/link a project by name non-interactively.
    // Every internal timeoutMs below is deliberately kept well under the
    // Vercel Function's own hard maxDuration: 60s cap. They used to be set
    // at or above 60s (60s, 60s, 120s, 180s) — which meant our own timeout
    // could never fire first, so a hang always ended in a silent platform
    // kill with zero diagnostic output (exactly what happened: `link` hung
    // and we got nothing but a bare "Task timed out after 60 seconds" with
    // no idea which step it was on or what the CLI printed). Now every step
    // gets its own clean, informative timeout error with whatever partial
    // stdout/stderr it captured, well before Vercel's kill.
    console.log('[link] starting');
    const linkStart = Date.now();
    await runVercel(
      ['link', '--yes', '--project', domain, '--token', token, ...scopeArgs],
      { cwd: appDir, homeDir: workDir, timeoutMs: 40_000 }
    );
    console.log(`[link] done after ${Date.now() - linkStart}ms`);

    // No separate "first deploy" here anymore. It used to exist only to
    // implicitly create the project (back when we relied on `--name`), but
    // `vercel link` above already creates/links the project explicitly, so
    // that first build was pure dead weight — a whole redundant Next.js
    // build+deploy cycle that did nothing but eat time. Given the runner's
    // own Vercel Function is capped at maxDuration: 60s (Hobby plan's max),
    // and this whole sequence was measured taking 55-60+ seconds and
    // getting killed mid-flight, cutting one of the two full builds is the
    // single biggest lever we have on total duration without upgrading to
    // Pro. Blob/Supabase/env below now run against the freshly-linked
    // project before the one real deploy at the end.

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
    try {
      console.log('[supabase] starting');
      const supabaseStart = Date.now();
      await runVercel(
        ['integration', 'add', 'supabase', '--token', token, ...scopeArgs],
        { cwd: appDir, homeDir: workDir, timeoutMs: 40_000 }
      );
      console.log(`[supabase] done after ${Date.now() - supabaseStart}ms`);
    } catch (err) {
      console.log('[supabase] failed:', err.message);
      const acceptTermsUrl = extractAcceptTermsUrl(`${err.stdout || ''}\n${err.stderr || ''}`);
      if (acceptTermsUrl) {
        warnings.push(
          `Supabase needs a one-time approval on your Vercel account: visit ${acceptTermsUrl}, accept the terms, then contact support to finish attaching your database.`
        );
      } else {
        warnings.push(`Supabase provisioning failed: ${err.message}`);
      }
    }

    // AUTH_SECRET is the one value we generate ourselves rather than
    // depending on a Marketplace resource, so set it directly.
    try {
      console.log('[env] starting');
      const envStart = Date.now();
      await runVercel(
        ['env', 'add', 'AUTH_SECRET', 'production', '--token', token, '--force'],
        { cwd: appDir, homeDir: workDir, input: authSecret, timeoutMs: 30_000 }
      );
      console.log(`[env] done after ${Date.now() - envStart}ms`);
    } catch (err) {
      console.log('[env] failed:', err.message);
      warnings.push(`Setting AUTH_SECRET failed: ${err.message}`);
    }

    // Final production deploy, now that Blob/Supabase/env vars are (best
    // effort) attached — this is the build the tenant actually sees.
    // 50s, not 180s: the platform hard-kills at 60s regardless of what we
    // set here, so 180s was never actually reachable — it just meant we'd
    // always get a silent platform kill instead of our own clear timeout
    // error. 50s leaves a 10s buffer under the real cap.
    console.log('[deploy] starting');
    const deployStart = Date.now();
    const { stdout, stderr } = await runVercel(
      ['deploy', '--token', token, '--yes', '--prod', ...scopeArgs],
      { cwd: appDir, homeDir: workDir, timeoutMs: 50_000 }
    );
    console.log(`[deploy] done after ${Date.now() - deployStart}ms`);

    const deploymentUrl = extractUrl(stdout);

    // TEMPORARY: production deployments aren't showing up on tenants'
    // dashboards despite this call exiting 0, and we have no visibility
    // into why. Log + return the raw CLI output so we can see exactly what
    // Vercel said instead of guessing again. Remove once root-caused.
    console.log('[final deploy] stdout:', stdout);
    console.log('[final deploy] stderr:', stderr);

    res.status(200).json({ deploymentUrl, warnings, debugFinalDeploy: { stdout, stderr } });
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
