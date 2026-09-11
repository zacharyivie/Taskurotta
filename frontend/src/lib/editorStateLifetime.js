// Each mount gets its own token, so a closed editor cannot publish retained text
// or affect a newly opened editor at the same path.
export function reconcileEditorLifetimes(lifetimes, openPaths) {
  const open = new Set(openPaths);
  for (const path of lifetimes.keys()) if (!open.has(path)) lifetimes.delete(path);
  for (const path of open) if (!lifetimes.has(path)) lifetimes.set(path, { active: true });
}

export function closeEditorLifetimes(lifetimes, paths) {
  for (const path of paths) {
    const lifetime = lifetimes.get(path);
    if (lifetime) lifetime.active = false;
  }
}

export function acceptsEditorState(lifetimes, path, lifetime) {
  return lifetime?.active && lifetimes.get(path) === lifetime;
}

export function retainOpenEditorStates(states, paths) {
  const open = new Set(paths);
  const entries = Object.entries(states).filter(([path]) => open.has(path));
  return entries.length === Object.keys(states).length ? states : Object.fromEntries(entries);
}
