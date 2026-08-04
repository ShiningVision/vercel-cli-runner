// Thin wrapper around Vercel's REST API (not the CLI) for project settings
// that the CLI itself has no flag for.
//
// `vercel link --yes --project <name>` runs against a brand-new, empty temp
// directory — the actual template source (package.json, next.config, etc.)
// only gets fetched later, in the separate api/deploy.js invocation. With
// nothing to detect a framework from at link time, Vercel creates the new
// project with Framework Preset "Other" instead of "Next.js". The later
// `vercel deploy` call has real source and builds it successfully — Next.js
// compiles, every route generates — but because the *project* itself isn't
// configured as a Next.js project, Vercel doesn't wire that build output
// into its routing table, so every single path (including API routes)
// serves a platform-level 404: NOT_FOUND. The build reports "Ready"; the
// site is completely dead. Confirmed live via itemlogs32: Framework Preset
// showed "Other" in Project Settings, and forcing it to "Next.js" is the
// fix.

async function setProjectFramework(domain, token, teamId) {
  const url = new URL(`https://api.vercel.com/v9/projects/${encodeURIComponent(domain)}`);
  if (teamId) url.searchParams.set('teamId', teamId);

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ framework: 'nextjs' }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Vercel API framework update failed (${res.status}): ${text}`);
  }
}

module.exports = { setProjectFramework };
