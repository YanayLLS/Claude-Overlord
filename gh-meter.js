// GitHub calls per feature, for "who is eating my rate limit": every gh call counts itself under the function that
// asked for it (read off the stack, past the gh wrappers), and every 10 minutes one log line names the top callers.
// kind: 'rest' | 'graphql' | 'free' (a 304 answered from the cache, costs nothing).
const SKIP = new Set(['ghJson', 'ghJsonRaw', 'ghGraphql', 'ghGraphqlRaw', 'ghText', 'ghDownload', 'api', 'run', 'fetch', 'metered', 'meteredFetch', 'meter',
  'Promise', 'new Promise', 'Array.map', 'Promise.all', 'Object.ghJson', 'Object.ghGraphql']);
const FRAME = /at (?:async )?(?:([^\s(]+) )?\(?(?:.*[\\/])?([\w.-]+\.js):\d+/;

function callerOf(stack) {
  for (const line of String(stack || '').split('\n').slice(1)) {
    const m = line.match(FRAME);
    if (!m || m[2] === 'gh-meter.js' || m[2] === 'gh-cache.js') continue;
    const fn = (m[1] || '').replace(/^(Object|Timeout|Immediate)\./, '');
    if (SKIP.has(fn)) continue;
    return `${m[2].replace(/\.js$/, '')}:${fn || '(anonymous)'}`;
  }
  return 'unknown';
}

function createGhMeter() {
  let counts = new Map();
  function meter(kind, stack) {
    const k = `${kind} ${callerOf(stack)}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  // the line for the log, then start over; null when nothing called GitHub
  function report(minutes = 10, top = 8) {
    if (!counts.size) return null;
    const by = { rest: 0, graphql: 0, free: 0 };
    for (const [k, n] of counts) by[k.split(' ')[0]] = (by[k.split(' ')[0]] || 0) + n;
    const list = [...counts].filter(([k]) => !k.startsWith('free ')).sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, n]) => `${k} ${n}`).join(', ');
    counts = new Map();
    return `gh calls, last ${minutes} min: ${by.rest} rest, ${by.graphql} graphql, ${by.free} free (304) · top: ${list || 'none'}`;
  }
  return { meter, report };
}

module.exports = { createGhMeter, callerOf };
