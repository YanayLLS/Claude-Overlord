// Near-instant PR updates without spending rate limit: each watched repo's newest-updated PR is fetched with
// If-None-Match. GitHub answers 304 (free: conditional requests don't count against the limit) until something
// on any PR changes — a review, approval, push, merge, new PR — which bumps updated_at and so the ETag.
// The first answer per repo only records its ETag; a later 200 means "changed" and calls onChange once per tick.
function createPrWatch({ get, onChange }) {
  const etags = new Map();
  let busy = false;
  return {
    async tick(repos) {
      if (busy) return; busy = true;
      try {
        let changed = false;
        for (const repo of new Set(repos)) {
          const r = await get(repo, etags.get(repo)).catch(() => null);
          if (!r || r.status !== 200 || !r.etag) continue;
          if (etags.has(repo) && etags.get(repo) !== r.etag) changed = true;
          etags.set(repo, r.etag);
        }
        for (const k of etags.keys()) if (!repos.includes(k)) etags.delete(k);
        if (changed) onChange();
      } finally { busy = false; }
    },
  };
}

module.exports = { createPrWatch };
