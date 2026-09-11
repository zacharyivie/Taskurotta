// Batch metadata and message updates before crossing the Electron bridge. The
// latest pending snapshot wins; deletion remains an ordered, acknowledged job.
export function createConversationArchiveScheduler({ reportError = () => {}, schedule = queueMicrotask } = {}) {
  const threads = new Map();
  function flush(threadId, state) {
    if (state.active || state.scheduled) return;
    state.scheduled = true;
    schedule(async () => {
      state.scheduled = false;
      const job = state.jobs.shift();
      if (!job) { threads.delete(threadId); return; }
      state.active = true;
      let saved = false;
      try {
        const result = await job.run();
        if (result?.warnings?.length) reportError(new Error(result.warnings.join("; ")));
        saved = true;
      } catch (error) { reportError(error); }
      for (const resolve of job.waiters) resolve(saved);
      state.active = false;
      if (state.jobs.length) flush(threadId, state);
      else threads.delete(threadId);
    });
  }
  return function enqueue(threadId, run, { deleted = false } = {}) {
    let state = threads.get(threadId);
    if (!state) { state = { active: false, scheduled: false, jobs: [] }; threads.set(threadId, state); }
    return new Promise((resolve) => {
      const last = state.jobs.at(-1);
      if (last && !last.deleted && !deleted) {
        last.run = run;
        last.waiters.push(resolve);
      } else state.jobs.push({ run, deleted, waiters: [resolve] });
      flush(threadId, state);
    });
  };
}
