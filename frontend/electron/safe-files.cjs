const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { realpathForContainment, isPathInside } = require("./security.cjs");

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

// Keep the parent descriptor open throughout each mutation. Linux's descriptor
// namespace makes child lookup relative to that directory even if it is renamed.
async function withDirectory(directory, authorize, operation) {
  const canonical = realpathForContainment(directory);
  authorize(canonical);
  const handle = await fsp.open(canonical, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) throw new Error("The destination is not a directory.");
    const verify = async () => {
      if (realpathForContainment(canonical) !== canonical || !sameFile(stat, await fsp.lstat(canonical))) {
        throw new Error("Directory changed during the file operation. Retry the action.");
      }
      authorize(canonical);
      if (process.platform === "linux") {
        const actual = await fsp.realpath(`/proc/self/fd/${handle.fd}`);
        authorize(actual);
        if (actual !== canonical) throw new Error("Directory moved during the file operation.");
      }
    };
    await verify();
    const anchored = process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : canonical;
    return await operation(anchored, verify);
  } finally { await handle.close(); }
}

async function writeFile(target, content, { authorize = () => {}, exclusive = false, expectedHash, digest } = {}) {
  const canonical = realpathForContainment(target);
  authorize(canonical);
  return withDirectory(path.dirname(canonical), authorize, async (parent, verify) => {
    const anchored = path.join(parent, path.basename(canonical));
    let handle;
    let created = false;
    try {
      // Never truncate before checking the descriptor. O_EXCL protects creation
      // against a link appearing after containment was checked.
      try {
        handle = await fsp.open(anchored, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o666);
        created = true;
      } catch (error) {
        if (exclusive || error.code !== "EEXIST") throw error;
        handle = await fsp.open(anchored, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
      }
      const stat = await handle.stat();
      const entry = await fsp.lstat(anchored);
      if (!stat.isFile() || stat.nlink !== 1 || entry.isSymbolicLink() || !sameFile(stat, entry)) {
        throw new Error("Cannot write a linked or replaced file.");
      }
      await verify();
      if (process.platform === "linux") authorize(await fsp.realpath(`/proc/self/fd/${handle.fd}`));
      if (expectedHash && digest(await handle.readFile()) !== expectedHash) throw new Error("File changed since the search. Refresh the results.");
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
        if (!bytesWritten) throw new Error("File write made no progress.");
        offset += bytesWritten;
      }
      await handle.truncate(bytes.length);
    } catch (error) {
      if (created && handle) {
        try {
          await verify();
          const owned = await handle.stat();
          const current = await fsp.lstat(anchored);
          if (!current.isSymbolicLink() && sameFile(owned, current)) await fsp.unlink(anchored);
        } catch { /* A changed path must not redirect cleanup to someone else's file. */ }
      }
      throw error;
    } finally { if (handle) await handle.close(); }
  });
}

async function createDirectory(target, authorize, { mode = 0o777 } = {}) {
  authorize(realpathForContainment(target));
  return withDirectory(path.dirname(target), authorize, async (parent, verify) => {
    await verify();
    await fsp.mkdir(path.join(parent, path.basename(target)), { mode });
  });
}

async function copyPath(source, destination, { authorizeSource, authorizeDestination }) {
  const sourceRoot = realpathForContainment(source);
  authorizeSource(sourceRoot);
  authorizeDestination(realpathForContainment(destination));
  async function copy(currentSource, currentDestination) {
    const stat = await fsp.lstat(currentSource);
    if (stat.isSymbolicLink()) {
      // Preserve internal links, but never install links that escape the grant.
      const link = await fsp.readlink(currentSource);
      const resolved = realpathForContainment(currentSource);
      authorizeSource(resolved);
      const newTarget = path.resolve(path.dirname(currentDestination), link);
      authorizeDestination(realpathForContainment(newTarget));
      await withDirectory(path.dirname(currentDestination), authorizeDestination, async (parent, verify) => {
        await verify();
        await fsp.symlink(link, path.join(parent, path.basename(currentDestination)), process.platform === "win32" && (await fsp.stat(currentSource)).isDirectory() ? "junction" : undefined);
      });
    } else if (stat.isDirectory()) {
      await createDirectory(currentDestination, authorizeDestination, { mode: stat.mode & 0o777 });
      await withDirectory(currentSource, authorizeSource, async (parent, verify) => {
        for (const entry of await fsp.readdir(parent)) {
          await verify();
          await copy(path.join(currentSource, entry), path.join(currentDestination, entry));
        }
      });
    } else if (stat.isFile()) {
      await withDirectory(path.dirname(currentSource), authorizeSource, async (parent, verify) => {
        const handle = await fsp.open(path.join(parent, path.basename(currentSource)), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try {
          await verify();
          if (!sameFile(stat, await handle.stat())) throw new Error("Source changed while copying.");
          // Stream large files using a bounded buffer; destination stays pinned.
          await withDirectory(path.dirname(currentDestination), authorizeDestination, async (destinationParent, verifyDestination) => {
            const output = await fsp.open(path.join(destinationParent, path.basename(currentDestination)), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), stat.mode & 0o777);
            try {
              await verifyDestination();
              const buffer = Buffer.allocUnsafe(64 * 1024);
              for (;;) {
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
                if (!bytesRead) break;
                let offset = 0;
                while (offset < bytesRead) offset += (await output.write(buffer, offset, bytesRead - offset)).bytesWritten;
              }
            } finally { await output.close(); }
          });
        } finally { await handle.close(); }
      });
    } else throw new Error("Only ordinary files and directories can be copied.");
  }
  if (isPathInside(destination, sourceRoot)) throw new Error("Cannot copy a directory into itself.");
  await copy(sourceRoot, destination);
}

async function renamePath(source, destination, authorize) {
  return withDirectory(path.dirname(source), authorize, async (parent, verify) => {
    const sourceEntry = path.join(parent, path.basename(source));
    const destinationEntry = path.join(parent, path.basename(destination));
    const stat = await fsp.lstat(sourceEntry);
    if (stat.isSymbolicLink()) throw new Error("Cannot rename a symbolic link through the editor.");
    try { await fsp.lstat(destinationEntry); throw new Error("Destination already exists."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await verify();
    await fsp.rename(sourceEntry, destinationEntry);
  });
}

module.exports = { copyPath, createDirectory, renamePath, withDirectory, writeFile };
