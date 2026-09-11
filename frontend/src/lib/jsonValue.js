// These helpers intentionally accept the JSON-only values used by workflow/settings data.
export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function equalJson(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every(
    (key) => Object.hasOwn(right, key) && equalJson(left[key], right[key]),
  );
}
