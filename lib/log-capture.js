// Every step of provisioning (link, blob, supabase, env, fetch-template,
// deploy) already logs progress via console.log — but that only ever
// reaches Vercel's own function logs, which age out after about an hour.
// That's the exact gap the tenant hit: something went wrong more than an
// hour ago and there was nowhere left to see what actually happened.
//
// createLogger() gives each request its own in-memory line buffer that
// mirrors everything to console.log AND collects it into an array the
// handler can return as `logs` in the JSON response. itemlogs-website then
// appends those lines to the tenant's row in D1 (see deploy-tenant.ts /
// register routes), so they outlive both this function's execution and
// Vercel's hour-long log retention — and the registration wizard can show
// them in a live-updating terminal.

function timestamp() {
  return new Date().toISOString().slice(11, 19); // HH:MM:SS, UTC
}

function createLogger() {
  const lines = [];

  function log(...args) {
    const text = args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    lines.push(`[${timestamp()}] ${text}`);
    console.log(...args);
  }

  // For a multi-line blob (e.g. raw CLI stdout/stderr) — logs each
  // non-empty line separately so the terminal view reads naturally instead
  // of as one giant wrapped line.
  function logBlock(prefix, text) {
    if (!text) return;
    for (const line of String(text).split('\n')) {
      const trimmed = line.trim();
      if (trimmed) log(`${prefix} ${trimmed}`);
    }
  }

  return { log, logBlock, lines };
}

module.exports = { createLogger };
