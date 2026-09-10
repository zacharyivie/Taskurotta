const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const GIT_OUTPUT_LIMIT = 16 * 1024 * 1024;

function runGit(args, options = {}) {
  const execFileImpl = options.execFileImpl || execFile;
  return new Promise((resolve, reject) => {
    execFileImpl(
      "git",
      args,
      {
        cwd: options.cwd,
        encoding: options.encoding || "utf8",
        maxBuffer: GIT_OUTPUT_LIMIT,
        windowsHide: true,
        timeout: 120000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function sourceControlStatus(xy) {
  if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(xy)) return "!";
  if (xy === "??") return "U";
  if (xy === "!!") return "";
  if (xy.includes("D")) return "D";
  if (/[ARC]/.test(xy)) return "A";
  return "M";
}

function parseGitStatus(output = "") {
  const records = String(output).split("\0");
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const xy = record.slice(0, 2);
    const relativePath = record.slice(3);
    const status = sourceControlStatus(xy);
    const originalPath = /[RC]/.test(xy) ? records[index + 1] : undefined;
    if (status && relativePath) entries.push({ path: relativePath, status,
      indexStatus: xy[0], worktreeStatus: xy[1],
      staged: status !== "!" && xy[0] !== " " && xy !== "??",
      unstaged: status === "!" || xy[1] !== " ",
      ...(originalPath ? { originalPath } : {}),
    });
    if (/[RC]/.test(xy)) index += 1;
  }
  return entries;
}

async function readGitStatus(projectRoot, options = {}) {
  const runner = options.runGit || runGit;
  try {
    const root = String(await runner(["-C", projectRoot, "rev-parse", "--show-toplevel"]))
      .trim();
    const output = await runner([
      "-C",
      projectRoot,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      ".",
    ]);
    const projectPrefix = path.relative(root, projectRoot).replaceAll("\\", "/");
    const entries = parseGitStatus(output).flatMap((entry) => {
      if (!projectPrefix) return [entry];
      const prefix = `${projectPrefix}/`;
      return entry.path.startsWith(prefix)
        ? [{ ...entry, path: entry.path.slice(prefix.length), ...(entry.originalPath ? { originalPath: path.relative(projectRoot, path.join(root, entry.originalPath)) } : {}) }]
        : [];
    });
    let branch = "";
    let branches = [];
    let ahead = null;
    let behind = null;
    try {
      branch = String(await runner(["-C", projectRoot, "branch", "--show-current"])).trim();
      branches = String(await runner(["-C", projectRoot, "for-each-ref", "--format=%(refname:short)", "refs/heads/"])).trim().split("\n").filter(Boolean);
      const counts = String(await runner(["-C", projectRoot, "rev-list", "--left-right", "--count", "HEAD...@{upstream}"])).trim().split(/\s+/).map(Number);
      if (counts.length === 2 && counts.every(Number.isFinite)) [ahead, behind] = counts;
    } catch { /* Unborn branches and branches without an upstream have no counts. */ }
    let remotes = [];
    let stashCount = 0;
    try { remotes = String(await runner(["-C", projectRoot, "remote"])).trim().split("\n").filter(Boolean); } catch { /* Optional remote metadata. */ }
    try { stashCount = String(await runner(["-C", projectRoot, "stash", "list", "--format=%gd"])).trim().split("\n").filter(Boolean).length; } catch { /* Unborn repository. */ }
    let operation;
    for (const [marker, kind] of [["rebase-merge", "rebase"], ["rebase-apply", "rebase"], ["MERGE_HEAD", "merge"]]) {
      try {
        const markerPath = String(await runner(["-C", projectRoot, "rev-parse", "--git-path", marker])).trim();
        if (markerPath && fs.existsSync(path.resolve(projectRoot, markerPath))) { operation = kind; break; }
      } catch { /* Optional operation metadata. */ }
    }
    return { active: true, entries, root, branch, branches, ahead, behind, remotes, stashCount, ...(operation ? { operation } : {}) };
  } catch {
    return { active: false, entries: [], root: "" };
  }
}

// Only literal paths from a fresh status snapshot may be mutated.
async function changeGitFile(projectRoot, relativePath, action, options = {}) {
  const runner = options.runGit || runGit;
  if (!["stage", "unstage", "revert", "revert-staged"].includes(action)) throw new Error("Unknown Git action.");
  const snapshot = await readGitStatus(projectRoot, options);
  const entry = snapshot.entries.find((item) => item.path === relativePath);
  if (!entry) throw new Error("This change is no longer present. Refresh source control.");
  const paths = [entry.path, ...(entry.originalPath && action !== "revert" ? [entry.originalPath] : [])];
  if (paths.some((name) => { const target = path.resolve(projectRoot, name); return !target.startsWith(path.resolve(projectRoot) + path.sep); })) throw new Error("This rename crosses the project boundary. Open the repository root to change it.");
  const literalPaths = paths.map((name) => `:(literal)${name}`);
  const git = (...args) => runner(["-C", projectRoot, ...args]);
  if (entry.status === "!" && action !== "stage") throw new Error("Resolve this conflict and stage the result, or abort the merge or rebase.");
  if (action === "stage") {
    if (entry.status === "!" && fs.existsSync(path.resolve(projectRoot, entry.path))) {
      const content = await fs.promises.readFile(path.resolve(projectRoot, entry.path), "utf8");
      if (/^(<{7}|={7}|>{7})(?: |$)/m.test(content)) throw new Error("Remove the conflict markers before marking this file resolved.");
    }
    await git("add", "--", ...literalPaths);
  }
  if (action === "unstage") {
    let hasHead = true;
    try { await git("rev-parse", "--verify", "HEAD"); } catch { hasHead = false; }
    if (hasHead) await git("restore", "--staged", "--", ...literalPaths);
    else await git("rm", "--cached", "--", ...literalPaths);
  }
  if (action === "revert" || action === "revert-staged") {
    if (action === "revert-staged" && entry.unstaged) throw new Error("This file also has unstaged edits. Unstage it first to preserve those edits, or discard the unstaged edits before reverting the staged change.");
    if (entry.indexStatus === "?" || (action === "revert-staged" && entry.indexStatus === "A")) {
      if (!options.trashItem) throw new Error("Trash is unavailable for this file.");
      // New files have no HEAD version. Unstage first, then use recoverable OS trash.
      if (entry.staged) await git("rm", "--cached", "--", ...literalPaths);
      const target = path.resolve(projectRoot, entry.path);
      if (!target.startsWith(path.resolve(projectRoot) + path.sep)) throw new Error("Invalid Git path.");
      await options.trashItem(target);
    } else if (action === "revert") {
      await git("restore", "--worktree", "--", ...literalPaths);
    } else {
      await git("restore", "--source=HEAD", "--staged", "--worktree", "--", ...literalPaths);
    }
  }
  return readGitStatus(projectRoot, options);
}

async function switchGitBranch(projectRoot, branch, options = {}) {
  const runner = options.runGit || runGit;
  const snapshot = await readGitStatus(projectRoot, options);
  if (!snapshot.branches?.includes(branch) || branch.startsWith("-")) throw new Error("Choose an existing local branch.");
  try {
    await runner(["-C", projectRoot, "switch", "--no-guess", branch]);
  } catch (error) {
    if (/overwritten|local changes|untracked working tree/i.test(error.message)) {
      return { ...snapshot, switchBlocked: true, requestedBranch: branch,
        notice: "Commit your changes, or stash them before switching branches." };
    }
    throw error;
  }
  return readGitStatus(projectRoot, options);
}

async function gitRepositoryAction(projectRoot, action, value = "", options = {}) {
  if (/^(merge-|rebase-|stash-(list|preview|drop|clear|apply-selected)$)/.test(action)) {
    return require("./git-integration.cjs").integrationAction(projectRoot, action, value, options);
  }
  const runner = options.runGit || runGit;
  const git = (...args) => runner(["-C", projectRoot, ...args]);
  if (["staged-diff", "reset-soft", "reset-hard", "detach-commit", "branch-commit"].includes(action)) {
    const root = String(await git("rev-parse", "--show-toplevel")).trim();
    if (path.resolve(root) !== path.resolve(projectRoot)) throw new Error("Open the repository root to review all affected changes first.");
  }
  if (action === "staged-diff") {
    const conflicts = String(await git("diff", "--name-only", "--diff-filter=U"));
    if (conflicts.trim()) throw new Error("Resolve and stage conflicts before generating a commit message.");
    const tree = String(await git("write-tree")).trim();
    const diff = String(await git("diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color"));
    if (!diff.trim()) throw new Error("Stage changes before generating a commit message.");
    return { diff, tree };
  } else if (["reset-soft", "reset-hard", "detach-commit", "branch-commit"].includes(action)) {
    if (!value || !/^[0-9a-f]{40,64}$/.test(value.hash)) throw new Error("Choose a valid commit.");
    await git("rev-parse", "--verify", `${value.hash}^{commit}`);
    const snapshot = await readGitStatus(projectRoot, options);
    if (snapshot.operation || snapshot.entries.some(entry => entry.status === "!")) throw new Error("Finish or abort the current operation first.");
    if (action.startsWith("reset-")) await git("reset", action === "reset-soft" ? "--soft" : "--hard", value.hash);
    else if (action === "detach-commit") await git("switch", "--detach", value.hash);
    else {
      if (typeof value.branch !== "string" || value.branch.startsWith("-")) throw new Error("Enter a valid branch name.");
      await git("check-ref-format", "--branch", value.branch);
      await git("switch", "-c", value.branch, value.hash);
    }
  } else if (action === "commit") {
    if (typeof value !== "string" || !value.trim() || value.length > 72000) throw new Error("Enter a commit message.");
    const repositoryRoot = String(await git("rev-parse", "--show-toplevel")).trim();
    if (path.resolve(repositoryRoot) !== path.resolve(projectRoot)) throw new Error("Open the repository root to review and commit all staged changes.");
    const staged = String(await git("diff", "--cached", "--name-only"));
    if (!staged.trim()) throw new Error("Stage changes before committing.");
    await git("commit", "-m", value);
  } else if (action === "pull") {
    await git("pull", "--ff-only");
  } else if (action === "push") {
    await git("push");
  } else if (action === "publish") {
    const snapshot = await readGitStatus(projectRoot, options);
    if (!snapshot.branch) throw new Error("Switch to a branch before publishing.");
    const remotes = String(await git("remote")).trim().split("\n").filter(Boolean);
    if (!remotes.includes(value)) throw new Error("Choose an existing remote.");
    await git("push", "--set-upstream", value, snapshot.branch);
  } else if (action === "stash-switch") {
    const snapshot = await readGitStatus(projectRoot, options);
    if (!snapshot.branches?.includes(value) || value.startsWith("-")) throw new Error("Choose an existing local branch.");
    // Leave the stash intact even if switching fails. Never pop onto another branch automatically.
    await git("stash", "push", "--include-untracked", "-m", `Taskurotta: before switching from ${snapshot.branch} to ${value}`);
    const result = await switchGitBranch(projectRoot, value, options);
    return { ...result, notice: result.switchBlocked ? result.notice : "Branch switched. Your changes are saved in the stash." };
  } else if (action === "stash-apply") {
    await git("stash", "apply", "--index", "stash@{0}");
  } else throw new Error("Unknown repository action.");
  return readGitStatus(projectRoot, options);
}

function parseGitHistory(output = "") {
  return String(output)
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const normalizedRecord = record.replace(/^\n+/, "");
      const [hash = "", shortHash = "", author = "", authoredAt = "", subject = "", message = "", refsAndStats = ""] = normalizedRecord.split("\x1f");
      const [refs = "", ...statLines] = refsAndStats.split("\n");
      let insertions = 0;
      let deletions = 0;
      for (const line of statLines) {
        const [added, deleted] = line.split("\t");
        if (/^\d+$/.test(added)) insertions += Number(added);
        if (/^\d+$/.test(deleted)) deletions += Number(deleted);
      }
      return {
        author,
        authoredAt,
        deletions,
        hash,
        insertions,
        message: message.trimEnd(),
        refs,
        shortHash,
        subject,
      };
    })
    .filter((entry) => entry.hash);
}

async function readGitHistory(projectRoot, options = {}) {
  const runner = options.runGit || runGit;
  try {
    const root = String(await runner(["-C", projectRoot, "rev-parse", "--show-toplevel"])).trim();
    const output = await runner([
      "-C", projectRoot, "log", "--max-count=100", "--date=iso-strict", "--numstat",
      "--pretty=format:%x00%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%B%x1f%D",
    ]);
    return { active: true, commits: parseGitHistory(output), root };
  } catch {
    return { active: false, commits: [], root: "" };
  }
}

function parseGitWorktrees(output = "") {
  const worktrees = [];
  let current = null;
  for (const line of String(output).split("\n")) {
    if (!line) {
      if (current?.path) worktrees.push(current);
      current = null;
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") current = { bare: false, branch: "", detached: false, head: "", locked: false, path: value, prunable: false };
    else if (!current) continue;
    else if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "bare") current.bare = true;
    else if (key === "detached") current.detached = true;
    else if (key === "locked") current.locked = true;
    else if (key === "prunable") current.prunable = true;
  }
  if (current?.path) worktrees.push(current);
  return worktrees;
}

async function readGitWorktrees(projectRoot, options = {}) {
  const runner = options.runGit || runGit;
  try {
    const root = String(await runner(["-C", projectRoot, "rev-parse", "--show-toplevel"])).trim();
    try {
      await runner(["-C", root, "worktree", "prune", "--expire", "now"]);
    } catch {
      // Listing remains useful when Git metadata is read-only.
    }
    const output = await runner(["-C", projectRoot, "worktree", "list", "--porcelain"]);
    return {
      active: true,
      root,
      worktrees: parseGitWorktrees(output).filter((worktree) => fs.existsSync(worktree.path)),
    };
  } catch {
    return { active: false, root: "", worktrees: [] };
  }
}

async function addGitWorktree(projectRoot, targetPath, branch, options = {}) {
  const runner = options.runGit || runGit;
  const args = ["-C", projectRoot, "worktree", "add"];
  if (typeof branch !== "string" || branch.startsWith("-")) throw new Error("Invalid branch name.");
  await runner(["check-ref-format", "--branch", branch]);
  if (options.startPoint) {
    if (!/^[0-9a-f]{40,64}$/.test(options.startPoint) || !options.createBranch) throw new Error("Choose a commit and a new branch for the worktree.");
    await runner(["-C", projectRoot, "rev-parse", "--verify", `${options.startPoint}^{commit}`]);
  }
  if (options.createBranch === true) args.push("-b", branch);
  args.push(targetPath);
  if (options.startPoint) args.push(options.startPoint);
  if (options.createBranch !== true && branch) args.push(branch);
  await runner(args);
  return readGitWorktrees(projectRoot, options);
}

async function removeGitWorktree(projectRoot, targetPath, options = {}) {
  const runner = options.runGit || runGit;
  if (fs.existsSync(targetPath)) {
    const args = ["-C", projectRoot, "worktree", "remove"];
    if (options.force === true) args.push("--force");
    try {
      await runner([...args, targetPath]);
    } catch (error) {
      if (options.force !== true && /contains modified or untracked files/i.test(String(error.stderr || error.message))) {
        return { requiresForce: true };
      }
      throw error;
    }
  } else {
    await runner(["-C", projectRoot, "worktree", "prune", "--expire", "now"]);
  }
  return readGitWorktrees(projectRoot, options);
}

function parseGitDiffHunks(output = "") {
  const hunks = [];
  for (const line of String(output).split("\n")) {
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    const startLine = Number(match[1]);
    const lineCount = match[2] == null ? 1 : Number(match[2]);
    hunks.push({
      endLine: lineCount > 0 ? startLine + lineCount - 1 : Math.max(1, startLine),
      startLine: Math.max(1, startLine),
    });
  }
  return hunks;
}

async function readGitFileBaseline(targetPath, options = {}) {
  const runner = options.runGit || runGit;
  // Deleted folders may no longer exist; locate the nearest existing ancestor.
  let directory = path.dirname(targetPath);
  while (!fs.existsSync(directory) && path.dirname(directory) !== directory) directory = path.dirname(directory);
  try {
    const root = String(await runner(["-C", directory, "rev-parse", "--show-toplevel"])).trim();
    const relativePath = path.relative(root, targetPath).replaceAll("\\", "/");
    if (!relativePath || relativePath.startsWith("../")) return { changed: false, content: "", hunks: [], tracked: false };
    const git = (...args) => runner(["-C", root, ...args]);
    const status = parseGitStatus(await git("status", "--porcelain=v1", "-z", "--untracked-files=all"));
    const entry = status.find((item) => item.path === relativePath);
    const group = options.group;
    const original = entry?.status === "!" ? `:2:${relativePath}` : group === "unstaged" ? `:${relativePath}` : `HEAD:${entry?.originalPath || relativePath}`;
    const readVersion = async (spec) => {
      try { const output = await runner(["-C", root, "show", spec], { encoding: "buffer" }); return Buffer.isBuffer(output) ? output : Buffer.from(String(output)); }
      catch { return Buffer.alloc(0); }
    };
    const originalBytes = await readVersion(original);
    const incomingBytes = entry?.status === "!" ? await readVersion(`:3:${relativePath}`) : null;
    const content = originalBytes.toString("utf8");
    const deleted = !fs.existsSync(targetPath);
    let modifiedBytes = Buffer.alloc(0);
    if (group === "staged") {
      modifiedBytes = await readVersion(`:${relativePath}`);
    } else if (!deleted) {
      const stat = await fs.promises.stat(targetPath);
      if (stat.size > GIT_OUTPUT_LIMIT) throw new Error("File is too large to compare.");
      modifiedBytes = await fs.promises.readFile(targetPath);
    }
    const modifiedContent = modifiedBytes.toString("utf8");
    const binary = originalBytes.includes(0) || modifiedBytes.includes(0) || /\.(avif|png|jpe?g|gif|webp|ico|bmp|pdf)$/i.test(relativePath);
    let diff = "";
    try {
      diff = String(await git("diff", ...(group === "staged" ? ["--cached"] : group === "unstaged" ? [] : ["HEAD"]), "--no-color", "--no-ext-diff", "--unified=0", "--", `:(literal)${relativePath}`));
    } catch { /* New repository. */ }
    return { ...(entry?.status === "!" ? { conflict: true, incomingContent: incomingBytes.toString("utf8") } : {}), changed: Boolean(entry && (group ? entry[group] : true)) || !originalBytes.equals(modifiedBytes), content: binary ? "" : content, modifiedContent: binary ? "" : modifiedContent, deleted, hunks: parseGitDiffHunks(diff), tracked: Boolean(entry) || content.length > 0,
      ...(binary ? { binary: true, originalBytes: originalBytes.length, modifiedBytes: modifiedBytes.length,
        originalData: originalBytes.toString("base64"), modifiedData: modifiedBytes.toString("base64") } : {}) };
  } catch {
    return { changed: false, content: "", hunks: [], tracked: false };
  }
}

module.exports = {
  gitRepositoryAction,
  changeGitFile,
  switchGitBranch,
  parseGitStatus,
  parseGitDiffHunks,
  parseGitHistory,
  readGitFileBaseline,
  parseGitWorktrees,
  readGitHistory,
  readGitStatus,
  readGitWorktrees,
  addGitWorktree,
  removeGitWorktree,
  runGit,
  sourceControlStatus,
};
