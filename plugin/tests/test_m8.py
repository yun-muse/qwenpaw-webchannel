#!/usr/bin/env python3
"""Standalone tests for M8: skill whitelist patch, server-side chats, and workspace prompts.

Run either way (no pytest required):

    cd plugin && python3 tests/test_m8.py
    cd plugin && python3 -m pytest tests/test_m8.py -q
"""

import asyncio
import os
import sys
import tempfile
import types
from pathlib import Path

_HERE = os.path.dirname(os.path.abspath(__file__))
_PLUGIN_DIR = os.path.dirname(_HERE)
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

# Provide lightweight stub modules when running outside full QwenPaw install
if "qwenpaw" not in sys.modules:
    _qp = types.ModuleType("qwenpaw")
    _qp_app = types.ModuleType("qwenpaw.app")
    _qp_channels = types.ModuleType("qwenpaw.app.channels")
    _qp_base = types.ModuleType("qwenpaw.app.channels.base")

    class _BaseChannel:
        def __init__(self, process, **kwargs):
            self.process = process
            self._workspace = None
            self._enqueue = None

    class _ContentType:
        TEXT = "text"
        FILE = "file"

    class _TextContent:
        def __init__(self, type=None, text=""):
            self.type = type
            self.text = text

    class _FileContent:
        def __init__(self, type=None, filename="", file_url=""):
            self.type = type
            self.filename = filename
            self.file_url = file_url

    _qp_base.BaseChannel = _BaseChannel
    _qp_base.ContentType = _ContentType
    _qp_base.TextContent = _TextContent
    _qp_base.FileContent = _FileContent

    _qp_plugins = types.ModuleType("qwenpaw.plugins")
    _qp_plugins_api = types.ModuleType("qwenpaw.plugins.api")

    class _PluginApi:
        def register_channel(self, **kwargs):
            pass

    _qp_plugins_api.PluginApi = _PluginApi

    sys.modules["qwenpaw"] = _qp
    sys.modules["qwenpaw.app"] = _qp_app
    sys.modules["qwenpaw.app.channels"] = _qp_channels
    sys.modules["qwenpaw.app.channels.base"] = _qp_base
    sys.modules["qwenpaw.plugins"] = _qp_plugins
    sys.modules["qwenpaw.plugins.api"] = _qp_plugins_api

from channel import WebChannel  # noqa: E402
from frames import (  # noqa: E402
    PROMPT_FILES,
    chat_deleted_frame,
    chat_renamed_frame,
    chats_frame,
    extract_skill_items,
    extract_web_chats,
    prompt_saved_frame,
    prompts_frame,
    skills_frame,
)
from plugin import WebChannelPlugin, _patch_skill_whitelist  # noqa: E402


class _FakeRelay:
    def __init__(self):
        self.sent = []

    async def send(self, frame):
        self.sent.append(frame)


class _FakeChatsApp:
    def __init__(self, specs=None, status=200, skills=None, skills_status=200):
        self.specs = list(specs or [])
        self.status = status
        self.skills = skills
        self.skills_status = skills_status
        self.calls = []

    async def __call__(self, method, path, params=None, json_body=None):
        self.calls.append({
            "method": method,
            "path": path,
            "params": params,
            "json": json_body,
        })
        if method == "GET" and path == "/api/chats":
            if self.status != 200:
                return self.status, None
            return 200, list(self.specs)
        if method == "DELETE" and path.startswith("/api/chats/"):
            cid = path.rsplit("/", 1)[-1]
            self.specs = [s for s in self.specs if str(s.get("id")) != cid]
            return 200, {"deleted": cid}
        if method == "GET" and path == "/api/skills":
            if self.skills_status != 200:
                return self.skills_status, None
            return 200, self.skills
        return 404, None


def _make_channel(app=None, ws_dir=None):
    ch = WebChannel(process=None)
    ch._agent_id = lambda: "agent-test"
    if ws_dir is not None:
        ch._workspace = types.SimpleNamespace(
            agent_id="agent-test", workspace_dir=str(ws_dir),
        )
    fake_app = _FakeChatsApp() if app is None else app
    fake_relay = _FakeRelay()
    ch._api_json = fake_app
    ch._relay = fake_relay
    return ch, fake_app, fake_relay


# --------------------------------------------------------------------------
# Task 1: Skill Whitelist Compatibility Patch
# --------------------------------------------------------------------------

def test_patch_skill_whitelist():
    seen = []

    def fake_resolve(workspace_dir, channel_name="console", *args, **kwargs):
        seen.append((workspace_dir, channel_name))
        return ["skill-a"] if channel_name == "console" else []

    agents_mod = types.ModuleType("qwenpaw.agents")
    ss_mod = types.ModuleType("qwenpaw.agents.skill_system")
    reg_mod = types.ModuleType("qwenpaw.agents.skill_system.registry")
    reg_mod.resolve_effective_skills = fake_resolve

    sys.modules["qwenpaw.agents"] = agents_mod
    sys.modules["qwenpaw.agents.skill_system"] = ss_mod
    sys.modules["qwenpaw.agents.skill_system.registry"] = reg_mod

    _patch_skill_whitelist()
    assert getattr(reg_mod, "_webchannel_patched", False) is True
    assert reg_mod.resolve_effective_skills("/ws", "web") == ["skill-a"]
    assert seen[-1] == ("/ws", "console")
    assert reg_mod.resolve_effective_skills("/ws", "feishu") == []
    assert seen[-1] == ("/ws", "feishu")

    # Idempotent on repeated calls
    wrapped_once = reg_mod.resolve_effective_skills
    _patch_skill_whitelist()
    assert reg_mod.resolve_effective_skills is wrapped_once


# --------------------------------------------------------------------------
# Task 2: Server-Side Chat List, Delete & Rename
# --------------------------------------------------------------------------

def test_frame_builders_chats_and_prompts():
    assert chats_frame([{"chat": "c1", "title": "Hi", "updated_at": "t1"}]) == {
        "t": "chats",
        "items": [{"chat": "c1", "title": "Hi", "updated_at": "t1"}],
    }
    assert chat_deleted_frame("c1") == {"t": "chat_deleted", "chat": "c1"}
    assert chat_renamed_frame("c1", "New Title") == {
        "t": "chat_renamed",
        "chat": "c1",
        "title": "New Title",
    }
    assert prompts_frame({"SOUL.md": "# Soul"}) == {
        "t": "prompts",
        "files": {"SOUL.md": "# Soul"},
    }
    assert prompt_saved_frame("SOUL.md") == {
        "t": "prompt_saved",
        "file": "SOUL.md",
    }


def test_extract_web_chats():
    specs = [
        {
            "id": "uuid-1",
            "channel": "web",
            "session_id": "web:web-user:chat-alpha",
            "name": "  Alpha Chat  ",
            "updated_at": "2026-10-27T10:00:00Z",
        },
        {
            "id": "uuid-2",
            "channel": "web",
            "session_id": "web:web-user:chat-beta",
            "title": "Beta",
            "created_at": "2026-10-26T09:00:00Z",
        },
        {
            "id": "uuid-3",
            "channel": "console",
            "session_id": "console:default:main",
            "name": "Console Chat",
        },
        {
            "id": "uuid-4",
            "channel": "web",
            "session_id": "web:other-user:chat-gamma",
            "name": "Other User",
        },
        "not-a-dict",
    ]
    items = extract_web_chats(specs)
    assert items == [
        {
            "chat": "chat-alpha",
            "title": "Alpha Chat",
            "updated_at": "2026-10-27T10:00:00Z",
        },
        {
            "chat": "chat-beta",
            "title": "Beta",
            "updated_at": "2026-10-26T09:00:00Z",
        },
    ]
    assert extract_web_chats(None) == []
    assert extract_web_chats("bad") == []


def test_chats_del_and_rename_handlers():
    async def scenario():
        specs = [
            {
                "id": "id-100",
                "channel": "web",
                "session_id": "web:web-user:c-100",
                "name": "First",
                "updated_at": "2026-10-27T12:00:00Z",
            },
        ]
        app = _FakeChatsApp(specs=specs)
        ch, app, relay = _make_channel(app=app)

        # 1. List chats
        await ch._on_relay_frame({"t": "chats"})
        assert relay.sent[-1] == {
            "t": "chats",
            "items": [{
                "chat": "c-100",
                "title": "First",
                "updated_at": "2026-10-27T12:00:00Z",
            }],
        }
        assert ch._chat_ids.get("c-100") == "id-100"
        assert "seq" not in relay.sent[-1]

        # 2. Rename chat
        await ch._on_relay_frame(
            {"t": "rename_chat", "chat": "c-100", "title": "  Renamed  "},
        )
        assert relay.sent[-1] == {
            "t": "chat_renamed",
            "chat": "c-100",
            "title": "Renamed",
        }

        # 3. Delete chat
        await ch._on_relay_frame({"t": "del_chat", "chat": "c-100"})
        assert relay.sent[-1] == {"t": "chat_deleted", "chat": "c-100"}
        assert "c-100" not in ch._chat_ids
        del_calls = [c for c in app.calls if c["method"] == "DELETE"]
        assert len(del_calls) == 1
        assert del_calls[0]["path"] == "/api/chats/id-100"

        # 4. Failing API on chats returns empty list rather than hanging
        app.status = 500
        await ch._on_relay_frame({"t": "chats"})
        assert relay.sent[-1] == {"t": "chats", "items": []}

    asyncio.run(scenario())


# --------------------------------------------------------------------------
# Task 3: Workspace Prompt Files Read/Write
# --------------------------------------------------------------------------

def test_prompts_read_and_write_handlers():
    async def scenario():
        with tempfile.TemporaryDirectory(prefix="wc-m8-prompts-") as tmp:
            ws = Path(tmp)
            (ws / "SOUL.md").write_text("Be helpful.", encoding="utf-8")
            ch, _app, relay = _make_channel(ws_dir=ws)

            # Read prompts
            await ch._on_relay_frame({"t": "get_prompts"})
            frame = relay.sent[-1]
            assert frame["t"] == "prompts"
            assert set(frame["files"].keys()) == set(PROMPT_FILES)
            assert frame["files"]["SOUL.md"] == "Be helpful."
            assert frame["files"]["AGENTS.md"] == ""
            assert "seq" not in frame

            # Save a valid prompt file
            await ch._on_relay_frame({
                "t": "set_prompt",
                "file": "MEMORY.md",
                "content": "# Memory\nUser likes Python.",
            })
            assert relay.sent[-1] == {
                "t": "prompt_saved",
                "file": "MEMORY.md",
            }
            assert (ws / "MEMORY.md").read_text(encoding="utf-8") == (
                "# Memory\nUser likes Python."
            )

            # Reject path traversal / unknown filename
            await ch._on_relay_frame({
                "t": "set_prompt",
                "file": "../secret.txt",
                "content": "nope",
            })
            assert relay.sent[-1]["t"] == "error"
            assert relay.sent[-1]["code"] == "E_PROMPT"

            # Reject oversized content (> 64 KB)
            await ch._on_relay_frame({
                "t": "set_prompt",
                "file": "SOUL.md",
                "content": "x" * 70000,
            })
            assert relay.sent[-1]["t"] == "error"
            assert relay.sent[-1]["code"] == "E_PROMPT"

    asyncio.run(scenario())


# --------------------------------------------------------------------------
# Task 4: Skills Discovery Control Frame
# --------------------------------------------------------------------------

def test_extract_skill_items_and_frame():
    assert skills_frame([{"id": "s1", "name": "S1", "description": "d"}]) == {
        "t": "skills",
        "items": [{"id": "s1", "name": "S1", "description": "d"}],
    }
    payload_list = [
        {"id": "web_search", "name": "Web Search", "description": "Search web"},
        {"name": "code_run", "desc": "Run code", "enabled": True},
        {"id": "disabled_one", "name": "Off", "enabled": False},
        {"id": "web_search", "name": "Duplicate"},
        "plain_skill",
    ]
    assert extract_skill_items(payload_list) == [
        {"id": "web_search", "name": "Web Search", "description": "Search web"},
        {"id": "code_run", "name": "code_run", "description": "Run code"},
        {"id": "plain_skill", "name": "plain_skill", "description": ""},
    ]
    assert extract_skill_items({"skills": [{"id": "a", "label": "Alpha"}]}) == [
        {"id": "a", "name": "Alpha", "description": ""},
    ]
    assert extract_skill_items(None) == []


def test_skills_handler():
    async def scenario():
        app = _FakeChatsApp(
            skills=[
                {
                    "id": "browser",
                    "name": "Browser",
                    "description": "Browse pages",
                },
            ],
        )
        ch, app, relay = _make_channel(app=app)
        await ch._on_relay_frame({"t": "skills"})
        assert relay.sent[-1] == {
            "t": "skills",
            "items": [{
                "id": "browser",
                "name": "Browser",
                "description": "Browse pages",
            }],
        }
        assert "seq" not in relay.sent[-1]

        # Fallback when /api/skills fails
        app.skills_status = 404
        with tempfile.TemporaryDirectory(prefix="wc-m8-skills-") as tmp:
            ws = Path(tmp)
            (ws / "agent.json").write_text(
                '{"skills": [{"id": "local_skill", "name": "Local Skill"}]}',
                encoding="utf-8",
            )
            ch2, _app2, relay2 = _make_channel(app=app, ws_dir=ws)
            # Clear registry fallback so agent.json fallback is exercised
            sys.modules.pop("qwenpaw.agents.skill_system.registry", None)
            await ch2._on_relay_frame({"t": "skills"})
            assert relay2.sent[-1] == {
                "t": "skills",
                "items": [{
                    "id": "local_skill",
                    "name": "Local Skill",
                    "description": "",
                }],
            }

    asyncio.run(scenario())


def main():
    tests = [
        (name, obj)
        for name, obj in sorted(globals().items())
        if name.startswith("test_") and callable(obj)
    ]
    failures = 0
    for name, test in tests:
        try:
            test()
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print("FAIL %s: %s: %s" % (name, type(exc).__name__, exc))
        else:
            print("ok   %s" % name)
    if failures:
        print("%d test(s) failed" % failures)
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
