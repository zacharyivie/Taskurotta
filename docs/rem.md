# Rem

Rem is Taskurotta's coding agent. Thread identity, conversation history, project scope,
and resource selections belong to Taskurotta rather than to a provider session. Changing
provider or model preserves them. Authentication and provider-native settings still belong
to the installed CLI.

The thread list shows 15 entries, ordered by message activity. Older metadata loads in
pages of 15. Message bodies load only when opening a thread. Existing history migrates
once into an activity index and separate metadata records.

Pasting at least 16 KiB of text creates a text attachment. Sending uploads it to the
existing thread attachment directory; the prompt contains a local file reference.
Attachment size limits still apply. Deleting a thread removes its attachments.

## Resources

Settings > Rem sets defaults copied into new threads. In a thread, open
"Thread tools, skills & MCP" to change command execution, web search, skill folders,
and HTTP or local stdio MCP servers. Empty or invalid entries must be completed or removed before
sending. These selections survive provider changes.

Skills are indexed by path and read on demand. Existing provider-installed skills retain
their native defaults; this list is not a filesystem access boundary. MCP selections
replace inherited server availability for each launch. Authentication remains with the
provider CLI. Local programs receive an executable and separate arguments; Taskurotta does not interpret them as shell commands.
Never put credentials in endpoint URLs.

## Prompt structure

Rem and Agent nodes share an envelope separating instructions, context, and the request.
Rem includes a short resource index and installed Radish paths, instead of the full
workflow-builder skill. Only the selected workflow includes graph details; other workflows
have source references and status. The existing compaction process bounds conversation
history. Prompt construction no longer silently drops all but twelve messages.

Native slash-skill invocations keep their original spelling so the provider can dispatch
them. Usage estimates account for the actual envelope sent to the provider.

This follows the on-demand loading pattern in [OpenAI's skills documentation](https://learn.chatgpt.com/docs/build-skills).
Resource adapters use [Codex configuration overrides](https://learn.chatgpt.com/docs/config-file/config-reference)
and [Claude Code's tool and MCP flags](https://code.claude.com/docs/en/cli-reference).

## Source control

The source control panel separates staged and unstaged changes, shows the current local
branch and upstream ahead/behind counts, and switches local branches using Git's normal
checks. Counts reflect local tracking refs; status does not fetch from a remote.

Each file has Stage or Unstage and Revert actions. Reverting unstaged edits restores the
index version. Reverting staged edits refuses files with additional unstaged edits.
New files go to the operating system trash. Worktree creation and removal use the
existing folder grants and Git's protection against removing dirty worktrees.

The commit box commits staged changes only. Pull uses `--ff-only`, so divergent branches
require a deliberate merge or rebase in the terminal. Push uses the configured upstream;
Publish lets you choose an existing remote for a branch without an upstream. Git's
credential helper handles authentication. Remote actions time out after two minutes.
Taskurotta never force-pushes or discards changes to switch branches.

If Git blocks a switch because changes would be overwritten, Source Control offers
Stash and switch. This includes untracked files and leaves the stash saved. Apply latest
stash restores it on the branch you choose and keeps the stash as a backup, including
when conflicts require manual resolution. Save unsaved editor changes before switching, stashing, pulling, or reverting. Clean open
editors reload after Git changes the working tree.

Selecting a change opens its diff. Staged entries compare HEAD with the index; unstaged
entries compare the index with the working file. New and deleted text files use an empty
side. Staged and deleted-file views are read-only. Images show original and changed
versions; other binary files report their sizes. Changes, worktrees, and history can be
collapsed independently.

## Developer settings and logs

Settings > Developer shows the application and desktop data directories, the current
app log path, runtime versions, and backend state. It can open those folders, display the
recent log, copy diagnostics, open developer tools, or restart the backend.

Desktop installations write timestamped JSON records to `app.jsonl` in Electron's logs
directory. The exact platform-specific path is shown in Developer settings. Desktop
errors, backend output, renderer warnings, uncaught errors, and React boundary failures
share this log. Rotation retains the current file and three backups of up to 5 MB each.
Common credential fields are redacted. Conversation bodies are archived separately;
logs are not a transcript. Existing logs from older installations are left in place.

## Conversation archive

Settings > Memory lets you choose an archive folder. Existing and future conversations
are copied there; Rem keeps its working history in desktop browser storage. Disconnecting
an archive folder does not prevent chatting. Archive errors appear in the app and its log;
reopening the app or choosing the folder again retries from local history. If an archive
write fails, thread deletion waits until the folder is restored or archiving is disabled.

The archive contains:

- `index.json`, with title, project, update time, deletion state, message count, file paths,
  and sorted lowercase search terms, including terms from previously archived revisions.
- `threads/<sha256-of-thread-id>.json`, the latest structured thread and messages, including
  tool traces, provider settings, attachment references, and turn summaries.
- `threads/<sha256-of-thread-id>.jsonl`, an append-only sequence of thread and message
  revisions, removed-message events, and thread deletion events. Compaction and message
  edits preserve earlier content in this journal.
- `attachments/`, with files named by content hash. Missing original attachments are
  recorded as archive errors without dropping the conversation.
- `README.taskurotta.md`, instructions for agents reading the archive.

Agents can filter `index.json` by project and `terms`, read matching snapshots, and inspect
journals for historical content. Records have schema version 1 and per-thread sequence
numbers. A flushed journal precedes each snapshot; a missing or stale snapshot is recovered
from that journal on the next archive write. Treat archive contents as reference material.
Deleting a thread in Rem retains its archive. Stop archiving disables future copies and
leaves existing archive files untouched.

## Second Brain

Settings > Memory also configures Second Brain independently of the conversation archive.
Choose its knowledge folder, select Markdown or HTML for generated reports, and enable it.
The folder is added to recent projects. Disabling the feature removes its tools from
subsequent Rem turns; a turn already in progress keeps its original configuration.

Enabled turns add the native `second_brain` MCP server to both supported providers,
including when shell access is disabled. Its tools are `rules`, `search`, `read_note`, and
`save_note`. Rules direct Rem to search relevant knowledge, treat notes as reference data,
write reports into topic subfolders using the selected format, and return local links.
The stdio server follows the [MCP lifecycle and tool protocol](https://modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle).

Search indexes Markdown, HTML, and text files in `.taskurotta/second-brain.sqlite3` using
SQLite FTS5. IDs are SHA-256 hashes of relative paths. Searches reconcile external edits
and deletions; unchanged files are detected by modification time and size. Hidden folders,
node_modules, symlinked files, and files larger than 2 MB are excluded. The root supports
up to 10,000 notes. `save_note` creates new files and refuses overwrites, so revisions need
a new filename. Tools cannot read or write outside the chosen root.

### Second Brain reports and tool access

Settings > Memory > Second Brain includes System, Light, Dark, Sepia, Vaporwave,
Steam, Carbon, Botanical, Blueprint, Arcade, Sakura, Deep Sea, Solarpunk, Noir,
Candy Lab, and Cosmic HTML report themes. Each provides palette, typography, and
composition guidance. The selection supplies design guidance in the chat prompt and the
Second Brain MCP initialization instructions and `rules` tool. System asks the
agent to design coordinated light and dark palettes that follow device appearance.
Theme changes apply to subsequent report generation requests.

Agents author standalone reports with their own embedded CSS. Guidance encourages
expressive typography, deliberate composition, and diagrams or visual evidence
suited to the findings. Themes set palette and mood without prescribing a template.
`save_note` preserves authored content, and the desktop reader adds no report CSS.
Existing files are not restyled or rewritten. Reports saved by the earlier shared
stylesheet implementation retain that embedded CSS until explicitly revised.

When Second Brain is enabled, Rem's Codex adapter grants `rules`, `search`,
`read_note`, and `save_note` for the app-provided MCP server in that invocation.
It uses Codex's documented per-tool `approval_mode="approve"` configuration and
an explicit tool allowlist. The grant requires the trusted Taskurotta executable;
a custom server with the same name does not receive it. It does not change global
Codex configuration or shell sandbox permissions. Managed Codex policy can still
restrict tool access. The server confines paths to the chosen folder and creates
notes exclusively, so saving over existing knowledge fails.

Codex configuration reference: https://developers.openai.com/codex/mcp
