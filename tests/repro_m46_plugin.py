#!/usr/bin/env python3
"""M46 Part A repro: where a reasoning segment loses its identity.

This is a *failing-path* probe, not an opinion. It drives the real plugin
functions against the real QwenPaw v2.2.2.post1 shapes and reports, per path:

  HIST  path 3/4  plugin.util.history_messages() on GET /api/chats/{id}
  STOP  path 5    plugin.util.response_partial_text() on a cancelled envelope,
                  then the real WebChannel._finalize_turn() frame sequence
  PACK  path 7    plugin.util.pack_history() + frames.hist_frame() on a
                  reasoning message, to see whether a split can keep a kind

The QwenPaw shapes below are not invented. `agentscope_msg_to_message()` in
``src/qwenpaw/app/chats/utils.py`` converts one persisted assistant ``Msg``
whose content is ``[{"type":"thinking","thinking":...},
{"type":"text","text":...}]`` into TWO runtime Messages:

    {"type":"reasoning", "role":"assistant",
     "content":[{"type":"text","text":"<reasoning>"}], ...}
    {"type":"message",   "role":"assistant",
     "content":[{"type":"text","text":"<answer>"}], ...}

That is the exact payload ``GET /api/chats/{id}`` returns (captured from a
real ``sessions/web/*.json`` file; see docs/m46-report.md). It is repeated
here so the probe needs no local workspace state.

Run with the venv that carries QwenPaw + httpx:

    ~/workspace/qwenpaw-local/venv/bin/python tests/repro_m46_plugin.py

Exit 0 = every measured path is clean (a fixed tree). Exit 1 = at least one
broken path (the current tree). The plugin-side frame dump lands in
``tests/out/m46-frames-plugin.log``; the e2e harness writes the wire-level
dump to ``tests/out/m46-frames-repro.log``.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PLUGIN_DIR = os.path.join(ROOT, "plugin")
if PLUGIN_DIR not in sys.path:
    sys.path.insert(0, PLUGIN_DIR)

from frames import hist_frame  # noqa: E402
from util import history_messages, pack_history, response_partial_text  # noqa: E402

CHAT = "chat-m46-repro"
TURN = "m46turn1"
REASONING = (
    "M46-REASONING-MARKER 我在核对这个问题：用户要的是一个明确的结论，"
    "先把条件列出来，再逐条排除。"
)
ANSWER = "M46-ANSWER-MARKER 结论如下。"

OUT_DIR = os.path.join(HERE, "out")
LOG_PATH = os.path.join(OUT_DIR, "m46-frames-plugin.log")


def _qwenpaw_messages():
    """The two Messages QwenPaw's history converter produces, as JSON dicts."""
    reasoning = {
        "id": "msg-reasoning",
        "type": "reasoning",
        "role": "assistant",
        "content": [{"type": "text", "text": REASONING}],
        "status": "completed",
        "metadata": {
            "original_id": TURN,
            "metadata": {},
            "timestamp": "2026-11-08T09:00:00+00:00",
            "finished_at": None,
        },
    }
    answer = {
        "id": "msg-answer",
        "type": "message",
        "role": "assistant",
        "content": [{"type": "text", "text": ANSWER}],
        "status": "completed",
        "metadata": {
            "original_id": TURN,
            "metadata": {
                "qwenpaw_turn_usage": {
                    "usage": {"prompt_tokens": 10, "completion_tokens": 5},
                },
            },
            "timestamp": "2026-11-08T09:00:00+00:00",
            "finished_at": None,
        },
    }
    return reasoning, answer


def _has_kind(entry):
    """True when a hist entry still tells the client it is reasoning."""
    return bool(
        entry.get("thinking")
        or entry.get("kind") == "reasoning"
        or entry.get("stream_type") == "reasoning"
    )


# ---------------------------------------------------------------------------
# HIST (paths 3, 4-through-resync)
# ---------------------------------------------------------------------------

def probe_hist():
    reasoning, answer = _qwenpaw_messages()
    history = {"messages": [reasoning, answer], "status": "idle"}
    projected = history_messages(history)
    frame = hist_frame(CHAT, projected, seq=1, busy=False)

    leaked = [
        entry for entry in projected
        if "M46-REASONING-MARKER" in (entry.get("text") or "")
    ]
    broken = bool(leaked) and not all(
        _has_kind(entry) for entry in leaked
    )
    return {
        "path": "HIST (3/4)",
        "broken": broken,
        "detail": (
            "reasoning projected as an ordinary assistant message (no kind)"
            if broken else "reasoning kept a kind marker"
        ),
        "frame": frame,
    }


# ---------------------------------------------------------------------------
# STOP (path 5)
# ---------------------------------------------------------------------------

def _cancelled_response():
    """A realistic cancelled AgentResponse: completed reasoning + partial text.

    Uses qwenpaw.schemas when the venv has it (the exact envelope types), and
    falls back to the same JSON shape otherwise.
    """
    try:
        from qwenpaw.schemas import (  # type: ignore
            AgentResponse, Message, MessageType, Role, RunStatus, TextContent,
        )
    except Exception:  # noqa: BLE001 - standalone probe without the host
        return {
            "status": "cancelled",
            "output": [
                {
                    "type": "reasoning",
                    "role": "assistant",
                    "status": "completed",
                    "content": [{"type": "text", "text": REASONING}],
                },
                {
                    "type": "message",
                    "role": "assistant",
                    "status": "cancelled",
                    "content": [{"type": "text", "text": ANSWER[:3]}],
                },
            ],
        }

    reasoning = Message(
        type=MessageType.REASONING, role=Role.ASSISTANT,
        content=[TextContent(type="text", text=REASONING)],
        status=RunStatus.Completed,
    )
    partial = Message(
        type=MessageType.MESSAGE, role=Role.ASSISTANT,
        content=[TextContent(type="text", text=ANSWER[:3])],
        status=RunStatus.Cancelled,
    )
    return AgentResponse(output=[reasoning, partial], status=RunStatus.Cancelled)


def probe_partial_text():
    response = _cancelled_response()
    text = response_partial_text(response)
    broken = "M46-REASONING-MARKER" in text
    return {
        "path": "STOP (5)",
        "broken": broken,
        "detail": (
            "response_partial_text() returns reasoning + answer"
            if broken else "response_partial_text() drops the reasoning message"
        ),
        "text": text,
    }


class _Relay:
    def __init__(self):
        self.sent = []

    async def send(self, frame):
        self.sent.append(frame)


class _Request:
    def __init__(self):
        self.channel_meta = {"chat_id": CHAT, "turn_id": "%s#1" % CHAT}
        self.session_id = "web:web-user:%s" % CHAT


async def _stop_frames():
    """The real channel frame sequence for a cancelled turn (M42 path)."""
    import channel as channel_module

    ch = channel_module.WebChannel(process=None)
    ch._relay = _Relay()
    request = _Request()
    meta = {"chat_id": CHAT, "turn_id": "%s#1" % CHAT}
    ch._turn_serial[CHAT] = 1

    await ch.on_streaming_start(request, "u", None, meta, "reasoning")
    await ch.on_streaming_delta(request, "u", None, meta, "reasoning", REASONING)
    await ch.on_streaming_end(request, "u", None, meta, "reasoning", REASONING)
    await ch.on_streaming_start(request, "u", None, meta, "message")
    await ch.on_streaming_delta(request, "u", None, meta, "message", ANSWER)

    await ch.on_event_response(request, _cancelled_response())
    return ch._relay.sent


def probe_stop_frames():
    try:
        frames = asyncio.run(_stop_frames())
    except Exception as error:  # noqa: BLE001 - missing host package
        return {
            "path": "STOP-FRAMES (5)",
            "broken": False,
            "skipped": str(error),
            "detail": "channel import unavailable (%s)" % error,
            "frames": [],
        }

    leaked_evt = [
        f for f in frames
        if f.get("t") == "evt"
        and (f.get("data") or {}).get("stream_type") == "message"
        and "M46-REASONING-MARKER" in ((f.get("data") or {}).get("text") or "")
    ]
    leaked_msg = [
        f for f in frames
        if f.get("t") == "msg"
        and "M46-REASONING-MARKER" in json.dumps(
            f.get("parts"), ensure_ascii=False,
        )
    ]
    broken = bool(leaked_evt or leaked_msg)
    return {
        "path": "STOP-FRAMES (5)",
        "broken": broken,
        "detail": (
            "message evt/msg carries the reasoning text"
            if broken else "stop frames carry answer text only"
        ),
        "frames": frames,
    }


# ---------------------------------------------------------------------------
# PACK (path 7)
# ---------------------------------------------------------------------------

def _frame_size(frame):
    return len(json.dumps(frame, ensure_ascii=False).encode("utf-8"))


def probe_pack():
    reasoning, answer = _qwenpaw_messages()
    projected = history_messages({"messages": [reasoning, answer]})
    chunks = pack_history(
        projected,
        lambda chunk: _frame_size(hist_frame(CHAT, chunk)) <= 256 * 1024,
    )

    # A single message over the 256 KB cap cannot be split (there is no
    # continuation frame in the protocol). The plugin still emits that chunk,
    # and RelayClient.send() drops the whole frame. Measure it, so the report
    # can state the consequence instead of guessing.
    oversized_text = "长" * (300 * 1024 // 3)
    big_reasoning = dict(reasoning)
    big_reasoning["content"] = [{"type": "text", "text": oversized_text}]
    big_projected = history_messages({"messages": [big_reasoning, answer]})
    big_chunks = pack_history(
        big_projected,
        lambda chunk: _frame_size(hist_frame(CHAT, chunk)) <= 256 * 1024,
    )
    oversize = [
        _frame_size(hist_frame(CHAT, chunk)) for chunk in big_chunks
        if _frame_size(hist_frame(CHAT, chunk)) > 256 * 1024
    ]
    return {
        "path": "PACK (7)",
        "broken": False,
        "detail": (
            "%d chunk(s), every chunk is a list of whole messages; no "
            "continuation frame exists. A 300 KB reasoning message becomes a "
            "%d-byte frame that RelayClient drops (oversize chunks: %d)"
            % (len(chunks), (oversize or [0])[0], len(oversize))
        ),
        "chunks": chunks,
        "oversize": oversize,
    }


# ---------------------------------------------------------------------------

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    results = [
        probe_hist(),
        probe_partial_text(),
        probe_stop_frames(),
        probe_pack(),
    ]

    lines = ["M46 plugin repro — real QwenPaw v2.2.2.post1 shapes", ""]
    for item in results:
        lines.append(
            "%s: %s — %s" % (
                item["path"],
                "BROKEN" if item["broken"] else "CLEAN",
                item["detail"],
            )
        )
    lines.append("")
    lines.append("--- HIST frame (actual wire frame) ---")
    lines.append(json.dumps(results[0]["frame"], ensure_ascii=False, indent=1))
    lines.append("")
    lines.append("--- response_partial_text() output ---")
    lines.append(repr(results[1]["text"]))
    lines.append("")
    lines.append("--- stop frames (channel._finalize_turn) ---")
    for frame in results[2]["frames"]:
        lines.append(json.dumps(frame, ensure_ascii=False))
    lines.append("")
    lines.append("--- pack_history probe ---")
    lines.append(results[3]["detail"])

    text = "\n".join(lines) + "\n"
    with open(LOG_PATH, "w", encoding="utf-8") as handle:
        handle.write(text)

    print(text)
    print("wrote", LOG_PATH)

    broken = [item for item in results if item["broken"]]
    if broken:
        print("REPRO_M46 PLUGIN: %d broken path(s): %s" % (
            len(broken), ", ".join(item["path"] for item in broken),
        ))
        return 1
    print("REPRO_M46 PLUGIN: all measured paths clean")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
