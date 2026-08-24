// Turns a couple of specific, recognizable Vercel CLI failures into
// messages a non-technical tenant can actually act on, instead of a raw
// CLI stack trace. Anything not recognized falls through to the original
// message untouched — this is best-effort pattern matching, not a full
// error taxonomy.

// Vercel's Hobby plan caps how many free Supabase Marketplace projects a
// single account can have connected at once (2, as of this writing). The
// CLI's own wording for this varies, so match loosely on the concepts
// ("limit"/"maximum" + "project"/"instance") rather than one exact string.
function interpretSupabaseError(message) {
  if (!message) return message;
  const lower = message.toLowerCase();
  const mentionsLimit = /(limit|maximum|quota|exceed)/.test(lower);
  const mentionsProject = /(project|instance|database|resource)/.test(lower);
  if (mentionsLimit && mentionsProject) {
    return (
      `Supabase creation failed: your Vercel account has hit its limit of free Supabase ` +
      `projects on the Hobby plan (2). Delete an unused Supabase project from your Vercel ` +
      `dashboard, or upgrade your Vercel plan, then try registering again. ` +
      `(Original error: ${message})`
    );
  }
  return message;
}

module.exports = { interpretSupabaseError };
