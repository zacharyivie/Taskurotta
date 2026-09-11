const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const childProcess = require("node:child_process");

test("Git status reuses repository locations and still detects external branch changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskurotta-git-cache-"));
  const calls = [];
  const module = { exports: {} };
  const localRequire = (name) => name === "node:child_process" ? {
    execFile(...args) { calls.push(args[1]); return childProcess.execFile(...args); },
  } : require(name);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "git-status.cjs"), "utf8"), { require: localRequire, module, process, Buffer });
  const { readGitStatus } = module.exports;
  try {
    childProcess.execFileSync("git", ["init", "-b", "main", root]);
    fs.writeFileSync(path.join(root, "new.txt"), "fixture");
    const first = await readGitStatus(root);
    assert.equal(first.branch, "main");
    assert.equal(first.entries[0].path, "new.txt");
    assert.equal(calls.length, 8);
    calls.length = 0;
    childProcess.execFileSync("git", ["-C", root, "checkout", "-b", "external"]);
    const second = await readGitStatus(root);
    assert.equal(second.branch, "external");
    assert.equal(calls.length, 6);
    assert.ok(calls.every((args) => !args.includes("rev-parse")));
    assert.deepEqual(JSON.parse(JSON.stringify(first.entries)), JSON.parse(JSON.stringify(second.entries)));
    calls.length = 0;
    fs.writeFileSync(path.join(root, '.git', 'MERGE_HEAD'), 'external-operation');
    const idle = await readGitStatus(root);
    assert.equal(idle.operation, 'merge');
    assert.equal(calls.length, 3);
    assert.ok(calls.every(args => ['status', 'branch', 'rev-list'].includes(args[2])));
    await module.exports.runGit(['-C', root, 'remote', 'add', 'origin', 'https://example.invalid/repo']);
    calls.length = 0;
    assert.deepEqual(Array.from((await readGitStatus(root)).remotes), ['origin']);
    assert.equal(calls.length, 6);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("idle status keeps files fresh while refreshing metadata every 15 seconds", async () => {
  const { readGitStatus } = require('./git-status.cjs');
  let now = 0;
  let branch = 'main', status = '', stashes = '';
  const calls = [];
  const runGit = async (args) => {
    calls.push(args);
    if (args[2] === 'rev-parse') return args.includes('--show-toplevel') ? '/repo' : '';
    if (args[2] === 'branch') return branch;
    if (args[2] === 'status') return status;
    if (args[2] === 'for-each-ref') return `main\n${branch}`;
    if (args[2] === 'rev-list') return '0 0';
    if (args[2] === 'stash') return stashes;
    return '';
  };
  const options = { runGit, now: () => now };
  await readGitStatus('/repo', options);
  stashes = 'stash@{0}';
  status = 'UU conflict.txt\0M  staged.txt\0';
  for (now = 2000; now < 15000; now += 2000) {
    const result = await readGitStatus('/repo', options);
    assert.equal(result.entries[0].status, '!');
    assert.equal(result.entries[1].staged, true);
    assert.equal(result.stashCount, 0);
  }
  assert.equal(calls.filter(args => args[2] === 'status').length, 8);
  for (const command of ['for-each-ref', 'remote', 'stash']) assert.equal(calls.filter(args => args[2] === command).length, 1);
  assert.equal((await readGitStatus('/repo', options)).stashCount, 1);
  branch = 'external';
  assert.equal((await readGitStatus('/repo', options)).branch, 'external');
  assert.equal(calls.filter(args => args[2] === 'stash').length, 3);
});

test('worktree reads share pending enumeration, never prune, and see external changes', async () => {
  const { readGitWorktrees } = require('./git-status.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskurotta-worktrees-'));
  const linked = path.join(root, 'linked');
  fs.mkdirSync(linked);
  let output = `worktree ${root}\nbranch refs/heads/main\n\nworktree ${linked}\nlocked reason\n\nworktree ${root}/missing\nprunable gone\n`;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const runGit = async args => {
    calls.push(args);
    if (args[2] === 'rev-parse') return root;
    await gate;
    return output;
  };
  try {
    const first = readGitWorktrees(root, { runGit });
    const second = readGitWorktrees(root, { runGit });
    await new Promise(resolve => setImmediate(resolve));
    release();
    const results = await Promise.all([first, second]);
    assert.equal(calls.filter(args => args[2] === 'worktree').length, 1);
    assert.equal(results[0].worktrees.length, 2);
    assert.equal(results[0].worktrees[1].locked, true);
    fs.rmSync(linked, { recursive: true });
    assert.equal((await readGitWorktrees(root, { runGit })).worktrees.length, 1);
    fs.mkdirSync(linked);
    output += `\nworktree ${linked}\nbranch refs/heads/new\n`;
    assert.equal((await readGitWorktrees(root, { runGit })).worktrees.at(-1).branch, 'new');
    assert.ok(calls.every(args => !args.includes('prune')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('adding a worktree cannot reuse a listing begun before the mutation', async () => {
  const { readGitWorktrees, addGitWorktree } = require('./git-status.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskurotta-worktree-race-'));
  const linked = path.join(root, 'linked');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let lists = 0;
  let mutated = false;
  const runGit = async args => {
    if (args[2] === 'rev-parse') return root;
    if (args[2] === 'worktree' && args[3] === 'add') {
      fs.mkdirSync(linked);
      mutated = true;
    }
    if (args[2] !== 'worktree' || args[3] !== 'list') return '';
    lists += 1;
    const snapshot = `worktree ${root}\n\n${mutated ? `worktree ${linked}\n` : ''}`;
    if (lists === 1) await gate;
    return snapshot;
  };
  try {
    const stale = readGitWorktrees(root, { runGit });
    await new Promise(resolve => setImmediate(resolve));
    const added = await addGitWorktree(root, linked, 'feature', { runGit });
    assert.equal(added.worktrees.length, 2);
    assert.equal(lists, 2);
    release();
    assert.equal((await stale).worktrees.length, 1);
  } finally {
    release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("branch deletion preserves checked-out and unmerged branches and refreshes the list", async () => {
  const { gitRepositoryAction, readGitStatus } = require('./git-status.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskurotta-branches-'));
  const git = (...args) => childProcess.execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' });
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
    git('commit', '--allow-empty', '-m', 'initial');
    git('branch', 'merged');
    git('switch', '-c', 'unmerged'); git('commit', '--allow-empty', '-m', 'unique'); git('switch', 'main');
    git('worktree', 'add', '-b', 'occupied', path.join(root, 'linked'));
    await readGitStatus(root);
    for (const branch of ['main', 'occupied', 'unmerged', '--all', 'missing']) {
      await assert.rejects(gitRepositoryAction(root, 'branch-delete', branch));
    }
    const result = await gitRepositoryAction(root, 'branch-delete', 'merged');
    assert.equal(result.branch, 'main');
    assert.deepEqual(result.branches, ['main', 'occupied', 'unmerged']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
