// A source filename supplies the directory for relative Markdown destinations.
export function isLocalFileLink(value) {
  const href = String(value ?? "");
  if (!href || href.startsWith("#") || href.startsWith("//")) return false;
  if (/^file:/i.test(href) || /^[a-z]:[\\/]/i.test(href) || href.startsWith("\\\\")) return true;
  const path = href.split(/[?#]/, 1)[0].replace(/(\.[^:/?#]+):[1-9]\d*(?::[1-9]\d*)?$/, "$1");
  return !/^[a-z][a-z\d+.-]*:/i.test(path);
}

export function resolveMarkdownLinkPath(sourcePath, href) {
  if (/^file:/i.test(String(href ?? ""))) {
    return filePathFromMarkdownUrl(href, sourcePath);
  }
  const rawTarget = String(href ?? "").split(/[?#]/, 1)[0];
  if (!rawTarget || !isLocalFileLink(href)) return "";
  let target;
  try {
    target = decodeURIComponent(rawTarget).replaceAll("\\", "/");
  } catch {
    target = rawTarget.replaceAll("\\", "/");
  }
  const source = String(sourcePath ?? "").replaceAll("\\", "/");
  const separator = String(sourcePath).includes("\\") && !String(sourcePath).includes("/")
    ? "\\"
    : "/";
  const absolute = target.startsWith("/") || /^[a-z]:\//i.test(target);
  const parts = absolute
    ? []
    : source.split("/").slice(0, -1).filter(Boolean);
  const prefix = target.startsWith("//") || (!absolute && source.startsWith("//"))
    ? "//"
    : target.startsWith("/") || (!absolute && source.startsWith("/")) ? "/" : "";

  for (const segment of target.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length && !/^[a-z]:$/i.test(parts.at(-1))) parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `${prefix}${parts.join("/")}`.replaceAll("/", separator);
}

export function markdownFileLinkTarget(sourcePath, href) {
  const resolvedPath = resolveMarkdownLinkPath(sourcePath, href);
  if (!resolvedPath) return null;
  const location = resolvedPath.match(/:([1-9]\d*)(?::([1-9]\d*))?$/);
  if (!location) return { column: 1, lineNumber: null, path: resolvedPath };
  return {
    column: location[2] ? Number(location[2]) : 1,
    lineNumber: Number(location[1]),
    path: resolvedPath.slice(0, -location[0].length),
  };
}

export function filePathFromMarkdownUrl(href, sourcePath = "") {
  try {
    const url = new URL(String(href ?? ""));
    if (url.protocol !== "file:") return "";
    const hostname = url.hostname && url.hostname !== "localhost" ? url.hostname : "";
    let targetPath = decodeURIComponent(url.pathname);
    if (hostname) targetPath = `//${hostname}${targetPath}`;
    if (/^\/[a-z]:\//i.test(targetPath)) targetPath = targetPath.slice(1);
    const windowsPath = /^[a-z]:\//i.test(targetPath)
      || (String(sourcePath).includes("\\") && !String(sourcePath).includes("/"));
    return windowsPath ? targetPath.replaceAll("/", "\\") : targetPath;
  } catch {
    return "";
  }
}

export async function resolveMarkdownFileLinkTarget(sourcePath, href, getPathInfo) {
  const target = markdownFileLinkTarget(sourcePath, href);
  if (!target) return null;
  if (!getPathInfo) return target;
  const info = await getPathInfo(target.path);
  if (!info?.isFile) throw new Error(`The link does not point to a file: ${target.path}`);
  return { ...target, path: info.path || target.path };
}

export async function resolveMarkdownFileTarget(sourcePath, href, getPathInfo) {
  return (await resolveMarkdownFileLinkTarget(sourcePath, href, getPathInfo))?.path ?? "";
}

