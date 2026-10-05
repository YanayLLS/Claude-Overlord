// ghJson with free repeats: a plain `gh api` GET is sent as a fetch with If-None-Match, and GitHub's 304 (which
// doesn't count against the rate limit) is answered from the cached body. Everything else — writes, --jq, --paginate,
// unknown flags, any non-200/304 answer — runs `gh` exactly as before, so callers see the same { data } | { error }.
// Once GitHub says the limit is hit (403/429 with remaining 0 or Retry-After), every REST call through here waits
// until the reset instead of hammering it; blockedUntil() lets other callers (the PR watch) honour the same pause.
const MAX_ENTRIES = 600; // ponytail: LRU by insertion, plenty for the board's per-repo/per-sha URLs

function parseGet(args) {
  if (args[0] !== 'api' || typeof args[1] !== 'string') return null;
  let path = null, method = null; const q = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '-X' || a === '--method') { method = String(args[++i] || '').toUpperCase(); continue; }
    if (a === '-f' || a === '-F' || a === '--raw-field' || a === '--field') {
      const kv = String(args[++i] || ''); const eq = kv.indexOf('=');
      if (eq < 1 || (a !== '-f' && a !== '--raw-field' && kv[eq + 1] === '@')) return null; // @file reads a file
      q.push([kv.slice(0, eq), kv.slice(eq + 1)]); continue;
    }
    if (a.startsWith('-')) return null;
    if (path !== null) return null;
    path = a;
  }
  if (!path || (method ? method !== 'GET' : q.length > 0)) return null; // gh turns fields into a POST body without -X GET
  const url = new URL(path.replace(/^\//, ''), 'https://api.github.com/');
  for (const [k, v] of q) url.searchParams.append(k, v);
  return url.toString();
}

function createGhCache({ run, fetch, token, now = Date.now }) {
  const cache = new Map();
  let blocked = 0;
  const limitedUntil = (r) => {
    if (r.status !== 403 && r.status !== 429) return 0;
    const retry = Number(r.headers.get('retry-after')), reset = Number(r.headers.get('x-ratelimit-reset'));
    if (retry > 0) return now() + retry * 1000;
    if (r.headers.get('x-ratelimit-remaining') === '0' && reset > 0) return reset * 1000;
    return 0;
  };
  const pausedError = () => ({ error: `GitHub rate limit reached — paused until ${new Date(blocked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, errorCode: 'ratelimit' });
  return {
    blockedUntil: () => blocked > now() ? blocked : 0,
    // Responses that say "limit hit" from elsewhere (the PR watch's own fetches) pause this too.
    noteResponse(r) { const u = limitedUntil(r); if (u > blocked) blocked = u; },
    async ghJson(args, timeout) {
      if (blocked > now()) return pausedError();
      const url = parseGet(args);
      if (!url) return run(args, timeout);
      try {
        const hit = cache.get(url);
        const r = await fetch(url, {
          headers: { Authorization: `Bearer ${await token()}`, Accept: 'application/vnd.github+json', ...(hit ? { 'If-None-Match': hit.etag } : {}) },
          signal: AbortSignal.timeout(timeout || 20000),
        });
        if (r.status === 304 && hit) { cache.delete(url); cache.set(url, hit); return { data: hit.data }; }
        const until = limitedUntil(r);
        if (until) { if (until > blocked) blocked = until; return pausedError(); }
        if (r.status === 200) {
          const data = await r.json(), etag = r.headers.get('etag');
          if (etag) { cache.delete(url); cache.set(url, { etag, data }); if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value); }
          return { data };
        }
      } catch {}
      return run(args, timeout); // errors, redirects, 404s…: gh's own handling, as before
    },
  };
}

module.exports = { createGhCache, parseGet };
