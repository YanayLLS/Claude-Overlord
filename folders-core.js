// Folders inside a project group: pure helpers shared by the renderer (index.html) and the node self-check.
// A project's folders are [{ id, name, agents: [agentName, ...] }]. `agents` is membership only;
// the order of agents inside a folder follows the project's normal drag order.

function newFolder(list, name) {
  const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  return { list: [...(list || []), { id, name, agents: [] }], id };
}

function folderOf(list, agentName) {
  return (list || []).find(f => f.agents.includes(agentName)) || null;
}

// Put an agent in folder `id`, or take it out of every folder when id is null.
function setFolder(list, agentName, id) {
  return (list || []).map(f => {
    const agents = f.agents.filter(n => n !== agentName);
    if (f.id === id) agents.push(agentName);
    return { ...f, agents };
  });
}

function renameFolder(list, id, name) {
  return (list || []).map(f => f.id === id ? { ...f, name } : f);
}

// Deleting a folder keeps its agents: they go back to the project's loose list.
function removeFolder(list, id) {
  return (list || []).filter(f => f.id !== id);
}

// Move folder `id` before/after folder `targetId`.
function moveFolder(list, id, targetId, after) {
  const src = (list || []).find(f => f.id === id);
  if (!src || id === targetId) return list;
  const rest = list.filter(f => f.id !== id);
  let i = rest.findIndex(f => f.id === targetId);
  if (i < 0) return list;
  if (after) i++;
  rest.splice(i, 0, src);
  return rest;
}

// Split a project's already-ordered [id, agent] rows into folders (in folder order) and loose rows.
function splitByFolder(list, rows, keyOf = a => a.agentName) {
  const byName = new Map();
  for (const f of list || []) for (const n of f.agents) byName.set(n, f.id);
  const folders = (list || []).map(f => ({ folder: f, rows: [] }));
  const idx = new Map(folders.map((g, i) => [g.folder.id, i]));
  const loose = [];
  for (const row of rows) {
    const fid = byName.get(keyOf(row[1]));
    if (fid != null) folders[idx.get(fid)].rows.push(row); else loose.push(row);
  }
  return { folders, loose };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { newFolder, folderOf, setFolder, renameFolder, removeFolder, moveFolder, splitByFolder };
}
