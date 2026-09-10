from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from gofer.core.prompt_envelope import AgentResources, resource_cli_args, resource_index
from gofer.ui.chat import build_chat_prompt


def test_resource_selection_maps_to_both_providers_without_inlining_skills(tmp_path: Path) -> None:
    skill = tmp_path / "large-skill"
    skill.mkdir()
    (skill / "SKILL.md").write_text("PRIVATE IMPLEMENTATION" * 1000)
    resources = AgentResources.model_validate(
        {
            "shell": False,
            "web": True,
            "skills": [{"path": str(skill)}],
            "mcpServers": [{"name": "docs", "url": "https://example.com/mcp"}],
        }
    )
    index = resource_index(resources)
    assert str(skill / "SKILL.md") in index
    assert "PRIVATE IMPLEMENTATION" not in index
    assert "https://" not in index
    codex = resource_cli_args("codex", resources)
    claude = resource_cli_args("claude_code", resources)
    assert "features.shell_tool=false" in codex
    assert 'web_search="live"' in codex
    assert any(arg.startswith("mcp_servers.docs={enabled=true,") for arg in codex)
    assert "Bash" not in claude[claude.index("--tools") + 1]
    assert "WebSearch" in claude[claude.index("--tools") + 1]
    assert "--strict-mcp-config" in claude
    assert json.loads(claude[-1])["mcpServers"]["docs"]["url"] == "https://example.com/mcp"


def test_codex_thread_disables_inherited_mcp_servers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    (tmp_path / "config.toml").write_text('[mcp_servers.ambient]\nurl="https://example.com/mcp"\n')
    args = resource_cli_args("codex", AgentResources(), tmp_path)
    assert 'mcp_servers."ambient".enabled=false' in args


def test_rem_keeps_early_messages_and_persona_when_switching_provider() -> None:
    messages = [{"role": "user", "body": f"turn {index}"} for index in range(20)]
    for provider in ("codex", "claude_code"):
        prompt = build_chat_prompt(provider, "cli-default", messages, None)
        envelope = json.loads("{" + prompt.split("\n\n{", 1)[1])
        assert "USER: turn 0\n" in envelope["request"]
        assert "USER: turn 19" in envelope["request"]
        assert prompt.startswith("You are Rem, the coding agent for Taskurotta.")
        assert "<gofer_flow_skill>" not in prompt


def test_mcp_endpoint_rejects_embedded_credentials() -> None:
    with pytest.raises(ValidationError, match="without credentials"):
        AgentResources.model_validate(
            {
                "mcpServers": [
                    {
                        "name": "docs",
                        "url": "https://user:password@example.com/mcp",
                    }
                ]
            }
        )


def test_stdio_resources_pass_separate_arguments_to_both_providers() -> None:
    import tomllib

    resources = AgentResources.model_validate(
        {
            "mcpServers": [
                {
                    "name": "local",
                    "type": "stdio",
                    "command": "/program with spaces/mcp",
                    "args": ["--root", "/project with spaces", "literal; argument"],
                }
            ]
        }
    )
    codex = resource_cli_args("codex", resources)
    entry = next(item for item in codex if item.startswith("mcp_servers.local="))
    configured = tomllib.loads(entry)["mcp_servers"]["local"]
    assert configured["command"] == "/program with spaces/mcp"
    assert configured["args"] == resources.mcpServers[0].args
    claude = resource_cli_args("claude_code", resources)
    assert json.loads(claude[-1])["mcpServers"]["local"]["args"] == configured["args"]
