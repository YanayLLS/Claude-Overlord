// GraphQL points (5000/h) are shared with every gh tool on the account — agents included — and GraphQL can't be
// revalidated for free like REST. So Overlord spends them by budget (g = /rate_limit's graphql block, which is free):
//   floor:     under FLOOR left, nothing GraphQL runs until the reset (the panel says "paused until")
//   regular:   the interval PR poll; under SLOW left it stretches to one per SLOW_EVERY_MS
//   triggered: a change-triggered PR poll; only while over TRIGGER_SHARE is left, at most TRIGGER_PER_HOUR an hour
//   other:     the rest (release board, sign ping) — stops only at the floor
// ponytail: fixed tiers, not a burn-rate model; tune the constants if a heavy team still hits the floor.
const FLOOR = 400, SLOW = 1500, SLOW_EVERY_MS = 5 * 60e3, TRIGGER_SHARE = 0.7, TRIGGER_PER_HOUR = 30;

function gqlAllow(kind, g, { now = Date.now(), lastRegular = 0, triggeredAt = [] } = {}) {
  if (!g) return { ok: kind !== 'triggered' };
  const resetMs = g.reset * 1000;
  if (resetMs > now && g.remaining < FLOOR) return { ok: false, pausedUntil: resetMs };
  if (kind === 'regular') return { ok: g.remaining >= SLOW || now - lastRegular >= SLOW_EVERY_MS };
  if (kind === 'triggered') {
    const lastHour = triggeredAt.filter(t => now - t < 3600e3).length;
    return { ok: g.remaining >= g.limit * TRIGGER_SHARE && lastHour < TRIGGER_PER_HOUR };
  }
  return { ok: true };
}

module.exports = { gqlAllow, FLOOR };
