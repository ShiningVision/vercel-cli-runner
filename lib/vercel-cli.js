// Thin wrapper for running the real `vercel` CLI as a subprocess. Using the
// actual CLI (not hand-rolled HTTP calls) matters here specifically because
// Vercel's OAuth Integration tokens are structurally blocked from creating
// new projects, Blob stores, or Marketplace resources (confirmed via
// repeated 403s and cross-checked against Vercel's public OpenAPI spec,
// which doesn't expose those operations at all) — but a real user token
// (Personal Access Token) driving the CLI inherits the user's actual
// Owner/Member permissions and can do all of it. The CLI's non-interactive
// mode is explicitly documented as CI-safe, which is the contract we're
// relying on rather than reverse-engineering private endpoints ourselves.

const { spawn } = require('child_process');
const path = require('path');

const VERCEL_BIN = path.join(__dirname, '..', 'node_modules', '.bin', 'vercel');

/**
 * @param {string[]} args
 * @param {{ cwd: string, input?: string, timeoutMs?: number }} opts
 */
// Vercel auto-injects VERCEL_* system env vars (VERCEL_PROJECT_ID,
// VERCEL_URL, VERCEL_ENV, VERCEL_DEPLOYMENT_ID, VERCEL_GIT_*, etc.) into this
// runner's OWN function runtime when "Enable access to System Environment
// Variables" is on for its Vercel project. Left in process.env, they leak
// into the spawned `vercel` CLI child process and get misread as the target
// project's identity — e.g. VERCEL_PROJECT_ID (this runner's own project)
// shows up with no matching VERCEL_ORG_ID, which is exactly the
// "you specified VERCEL_PROJECT_ID but forgot VERCEL_ORG_ID" error the CLI
// throws. Strip anything VERCEL_*-prefixed so the CLI relies solely on
// --token/--scope and the .vercel/project.json we create via `vercel deploy`
// in each tenant's own temp cwd.
function cleanEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== 'VERCEL' && !key.startsWith('VERCEL_')
    )
  );
}

function runVercel(args, opts) {
  const { cwd, homeDir = cwd, input, timeoutMs = 60_000 } = opts;

  return new Promise((resolve, reject) => {
    const child = spawn(VERCEL_BIN, args, {
      cwd,
      env: {
        ...cleanEnv(),
        CI: '1', // nudges the CLI's own non-interactive detection
        // Vercel Functions set HOME to a sandbox path (e.g. /home/sbx_userNNNN)
        // that doesn't exist and can't be created, but the CLI still tries to
        // write its global config under $HOME/.local/share/com.vercel.cli.
        // Point HOME (and XDG_* for good measure) at a writable dir — this
        // also isolates concurrent invocations for different tenants from
        // each other. IMPORTANT: homeDir must differ from cwd, or the CLI's
        // "You are deploying your home directory. Do you want to continue?
        // (y/N)" interactive guard fires (not silenced by --yes) and hangs
        // forever since nothing ever answers it.
        HOME: homeDir,
        XDG_CONFIG_HOME: path.join(homeDir, '.config'),
        XDG_DATA_HOME: path.join(homeDir, '.local', 'share'),
        XDG_CACHE_HOME: path.join(homeDir, '.cache'),
      },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`Timed out after ${timeoutMs}ms: vercel ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      } else {
        const err = new Error(
          `vercel ${args[0]} exited with code ${code}: ${stderr.trim() || stdout.trim()}`
        );
        err.stdout = stdout;
        err.stderr = stderr;
        err.code = code;
        reject(err);
      }
    });

    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

module.exports = { runVercel };
