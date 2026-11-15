// Near-instant PR updates without spending rate limit: each watched repo's newest-updated PR is fetched with
// If-None-Match. GitHub answers 304 (free: conditional requests don't count against the limit) until something
// on any PR changes — a review, approval, push, merge, new PR — which bumps updated_at and so the ETag.
// The first answer per repo only records its ETag; a later 200 means "changed" and calls onChange once per tick.
// paidGapMs: a key that just cost a 200 rests that long, so a list that changes every tick during CI costs one call per
// gap instead of one per tick; its change is caught on the first tick past the gap.
function createPrWatch({ get, onChange, now = Date.now, paidGapMs = 0 }) {
  const etags = new Map(), restUntil = new Map();
  let busy = false;
  return {
    async tick(repos) {
      if (busy) return; busy = true;
      try {
        let changed = false;
        for (const repo of new Set(repos)) {
          if ((restUntil.get(repo) || 0) > now()) continue;
          const r = await get(repo, etags.get(repo)).catch(() => null);
          if (!r || r.status !== 200 || !r.etag) continue;
          restUntil.set(repo, now() + paidGapMs);
          if (etags.has(repo) && etags.get(repo) !== r.etag) changed = true;
          etags.set(repo, r.etag);
        }
        for (const k of etags.keys()) if (!repos.includes(k)) { etags.delete(k); restUntil.delete(k); }
        if (changed) onChange();
      } finally { busy = false; }
    },
  };
}

module.exports = { createPrWatch };
