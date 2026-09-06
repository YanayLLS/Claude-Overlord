// Pure helpers for the ClickUp raid feed: no I/O, so they can be tested without a token.
// main.js polls the ClickUp v2 API for tasks in the watched boards (lists) whose status
// matches the filter (default "failed qa"); each such task is a raid on the base whose
// platform it names. The world turns raids into enemies.

const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

// Status names in ClickUp carry emoji and stray spaces ("failed qa 🐞"), and each list
// may define its own copy. Compare on the letters and digits only, by prefix, so the
// filter "failed qa" matches all of them and a status "failed in last sprint" does not
// match "failed".
function statusKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function statusMatches(status, filters) {
  const k = statusKey(status); if (!k) return false;
  for (const f of Array.isArray(filters) ? filters : [filters]) { const fk = statusKey(f); if (fk && (k === fk || k.startsWith(fk + ' '))) return true; }
  return false;
}
// "failed qa, waiting for merge" -> ['failed qa', 'waiting for merge']
function parseStatusFilter(text) { return [...new Set(String(text || '').split(/[,\n;]+/).map(s => s.trim()).filter(Boolean))]; }

// Custom field value -> list of option labels. Labels fields hold an array of option ids;
// drop-downs hold one option id or its orderindex; text fields hold the text.
function fieldLabels(f) {
  if (!f || f.value == null || f.value === '') return [];
  const opts = (f.type_config && f.type_config.options) || [];
  const name = o => o && (o.label || o.name) || '';
  const one = v => { const o = opts.find(o => o.id === v) || opts.find(o => o.orderindex === v) || (typeof v === 'number' ? opts[v] : null); return o ? name(o) : (typeof v === 'string' ? v : ''); };
  const vals = Array.isArray(f.value) ? f.value : [f.value];
  return vals.map(one).map(s => String(s).trim()).filter(Boolean);
}

// A raid: the task facts the world needs, and nothing that changes every poll (no
// date_updated), so a snapshot signature stays stable while the ticket sits there.
function normalizeTask(t, opts = {}) {
  if (!t || !t.id) return null;
  const platformField = opts.platformField || 'platform';
  const fields = Array.isArray(t.custom_fields) ? t.custom_fields : [];
  const pf = fields.find(f => f && (f.id === platformField || statusKey(f.name) === statusKey(platformField)));
  const pr = t.priority && (t.priority.priority || t.priority.name);
  const priority = PRIORITIES.includes(String(pr || '').toLowerCase()) ? String(pr).toLowerCase() : 'none';
  const alist = Array.isArray(t.assignees) ? t.assignees : [];
  const assignees = alist.map(a => a && (a.username || a.email) || '').filter(Boolean);
  const assigneeIds = alist.map(a => a && a.id != null ? String(a.id) : '').filter(Boolean);
  return {
    id: String(t.id),
    name: String(t.name || '').trim(),
    url: typeof t.url === 'string' ? t.url : 'https://app.clickup.com/t/' + t.id,
    status: (t.status && t.status.status) || '',
    priority,
    platforms: fieldLabels(pf),
    list: { id: t.list ? String(t.list.id || '') : '', name: (t.list && t.list.name) || '' },
    assignees, assigneeIds,
    tags: (Array.isArray(t.tags) ? t.tags : []).map(x => x && x.name).filter(Boolean),
    created: Number(t.date_created) || 0,
  };
}

// The poll's memory: first-seen time per task id, so "besieging for 3 days" costs no extra
// calls. Returns the new memory plus what appeared and what went away since last time.
// The first poll after enabling seeds silently (nothing counts as newly spawned).
function diffRaids(tasks, seen, now, seeded) {
  const prev = seen && typeof seen === 'object' ? seen : {};
  const next = {}, spawned = [], slain = [];
  for (const t of tasks) { next[t.id] = prev[t.id] || now; if (seeded && !prev[t.id]) spawned.push(t); }
  for (const id of Object.keys(prev)) if (!next[id]) slain.push(id);
  return { seen: next, spawned, slain };
}

// Only the signed-in user's tickets raid the island. The API filters by assignee too, but
// the check is repeated here so a stale or shared cache can never smuggle in others' work.
function assignedTo(task, userId) { return !!(task && userId != null && (task.assigneeIds || []).includes(String(userId))); }

// Query for one page of the team-wide task endpoint, filtered to the watched lists and,
// when a user id is given, to that assignee. Statuses are filtered client-side
// (statusMatches) because the API wants exact names and every list spells its own.
function taskQuery(teamId, listIds, page, assigneeId) {
  const q = new URLSearchParams();
  for (const id of listIds) q.append('list_ids[]', String(id));
  if (assigneeId != null && assigneeId !== '') q.append('assignees[]', String(assigneeId));
  q.set('include_closed', 'false'); q.set('subtasks', 'true'); q.set('page', String(page || 0));
  return `/team/${encodeURIComponent(String(teamId))}/task?${q.toString()}`;
}

// Spaces, folders and lists into one tree for the board picker; folderless lists sit
// directly under their space. Every list carries its path for display and for settings.
function buildTree(spaces, foldersBySpace, listsByFolder, listsBySpace) {
  const out = [];
  for (const sp of spaces || []) {
    if (!sp || !sp.id || sp.archived) continue;
    const node = { id: String(sp.id), name: sp.name || '', folders: [], lists: [] };
    for (const fo of (foldersBySpace && foldersBySpace[sp.id]) || []) {
      if (!fo || !fo.id || fo.archived) continue;
      const lists = ((listsByFolder && listsByFolder[fo.id]) || (fo.lists || [])).filter(l => l && l.id && !l.archived)
        .map(l => ({ id: String(l.id), name: l.name || '', path: `${node.name} / ${fo.name || ''} / ${l.name || ''}` }));
      node.folders.push({ id: String(fo.id), name: fo.name || '', lists });
    }
    node.lists = ((listsBySpace && listsBySpace[sp.id]) || []).filter(l => l && l.id && !l.archived)
      .map(l => ({ id: String(l.id), name: l.name || '', path: `${node.name} / ${l.name || ''}` }));
    out.push(node);
  }
  return out;
}
function flattenTree(tree) { const out = []; for (const sp of tree || []) { for (const fo of sp.folders || []) out.push(...(fo.lists || [])); out.push(...(sp.lists || [])); } return out; }

// Settings as stored: only ids and names, validated.
function sanitizeLists(lists) {
  const seen = new Set(), out = [];
  for (const l of Array.isArray(lists) ? lists : []) {
    const id = l && String(l.id || '').trim(); if (!id || !/^\d+$/.test(id) || seen.has(id)) continue; seen.add(id);
    out.push({ id, name: String((l && l.name) || '').slice(0, 200), path: String((l && l.path) || '').slice(0, 400) });
  }
  return out;
}

if (typeof module !== 'undefined') module.exports = { PRIORITIES, statusKey, statusMatches, parseStatusFilter, fieldLabels, normalizeTask, assignedTo, diffRaids, taskQuery, buildTree, flattenTree, sanitizeLists };
