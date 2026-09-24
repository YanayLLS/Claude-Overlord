// Pure check for the warm-spare terminal: a pre-booted `claude` a new agent can adopt.
// `key` captures every launch flag that could differ between warm-up and adoption.
function spareFits(spare, cwd, key) {
  return !!spare && !spare.exited && spare.cwd === cwd && spare.key === key;
}

module.exports = { spareFits };
