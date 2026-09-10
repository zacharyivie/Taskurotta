"""Commit drafting must not give providers the normal coding permissions."""

from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from gofer.ui import commit_message


def test_commit_commands_restrict_provider_permissions(tmp_path: Path) -> None:
    codex = commit_message.commit_message_command(
        "codex", "cli-default", None, "draft", "/bin/codex", tmp_path
    )
    assert codex[codex.index("--sandbox") + 1] == "read-only"
    assert "features.shell_tool=false" in codex
    assert "--add-dir" not in codex
    claude = commit_message.commit_message_command(
        "claude_code", "cli-default", None, "draft", "/bin/claude", tmp_path
    )
    assert claude[claude.index("--tools") + 1] == ""
    assert "--allowedTools" not in claude
    assert "--strict-mcp-config" in claude
    assert "--add-dir" not in claude


@pytest.mark.asyncio
async def test_generation_uses_temporary_directory_and_validates_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(commit_message, "resolve_provider_executable", lambda _: "/bin/codex")
    run = AsyncMock(
        return_value=(
            0,
            '{"type":"item.completed","item":'
            '{"type":"agent_message","text":"fix: show resolved files"}}',
            "",
        )
    )
    monkeypatch.setattr(commit_message, "run_subprocess", run)
    result = await commit_message.generate_commit_message(
        provider="codex", model="cli-default", diff="+resolved"
    )
    assert result == {"message": "fix: show resolved files"}
    directory = run.call_args.kwargs["cwd"]
    assert not directory.exists()
    assert run.call_args.kwargs["timeout"] == 150
    run.return_value = (
        0,
        '{"type":"item.completed","item":{"type":"agent_message","text":"Here is a message"}}',
        "",
    )
    with pytest.raises(commit_message.ChatProviderError, match="Conventional Commit"):
        await commit_message.generate_commit_message(
            provider="codex", model="cli-default", diff="+resolved"
        )


@pytest.mark.asyncio
async def test_generation_rejects_empty_diff() -> None:
    with pytest.raises(ValueError, match="staged changes"):
        await commit_message.generate_commit_message(provider="codex", model="cli-default", diff="")


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["codex", "claude_code"])
async def test_large_commit_preserves_all_files_and_rem_selection(
    monkeypatch: pytest.MonkeyPatch, provider: str
) -> None:
    diff = "".join(
        f"diff --git a/file-{i}.py b/file-{i}.py\n" + "+change\n" * 1000 for i in range(92)
    )
    validate = AsyncMock()
    monkeypatch.setattr(commit_message, "validate_provider_selection_async", validate)
    monkeypatch.setattr(commit_message, "resolve_provider_executable", lambda _: "/bin/provider")
    run = AsyncMock(return_value=(0, "", ""))
    monkeypatch.setattr(commit_message, "run_subprocess", run)
    monkeypatch.setattr(
        commit_message, "_provider_final_message", lambda *_: "feat: update project"
    )
    await commit_message.generate_commit_message(
        provider=provider, model="selected-model", effort="high", diff=diff
    )
    validate.assert_awaited_once_with(provider, "selected-model", "high")
    command = run.call_args.args[0]
    assert command[command.index("--model") + 1] == "selected-model"
    assert 'model_reasoning_effort="high"' in command if provider == "codex" else "high" in command
    prompt = run.call_args.kwargs["stdin"].decode()
    assert prompt not in command
    assert "patch excerpt omitted" in prompt
    for i in range(92):
        assert f"diff --git a/file-{i}.py b/file-{i}.py" in prompt
    assert len(commit_message.staged_diff_preview(diff)) <= 120000


def test_small_staged_diff_is_not_abbreviated() -> None:
    diff = "diff --git a/file b/file\n-old\n+new\n"
    assert commit_message.staged_diff_preview(diff) == diff
