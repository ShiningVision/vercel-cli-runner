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
function runVercel(args, opts) {
  const { cwd, input, timeoutMs = 60_000 } = opts;

  return new Promise((resolve, reject) => {
    const child = spawn(VERCEL_BIN, args, {
      cwd,
      env: { ...process.env, CI: '1' }, // CI=1 nudges the CLI's own non-interactive detection
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
