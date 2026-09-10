export const PROVIDER_PERMISSIONS = {
  codex: [
    ["read-only", "Read only", "Read files without changing them."],
    ["workspace-write", "Workspace write", "Edit files in the workspace and permitted folders."],
    ["danger-full-access", "Full access", "Run commands without the Codex sandbox."],
  ],
  claude_code: [
    ["default", "CLI default", "Use Claude Code's configured permissions."],
    ["manual", "Manual", "Use Claude Code's manual permission checks."],
    ["acceptEdits", "Accept edits", "Automatically approve file edits."],
    ["auto", "Auto", "Let Claude Code review tool permissions automatically."],
    ["dontAsk", "Don't ask", "Run allowed tools and deny tools that need approval."],
    ["plan", "Plan", "Explore and plan before making changes."],
    ["bypassPermissions", "Bypass permissions", "Skip Claude Code permission checks."],
  ],
};

export function defaultPermissionMode(provider) {
  return provider === "claude_code" ? "dontAsk" : "workspace-write";
}
