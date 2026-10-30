#!/usr/bin/env python3
"""M38 — code-level lockstep check for the two relay implementations.

`relay-cf` (production Durable Object) and `relay-node` (local dev) must agree
on the two rules that used to break the channel silently:

  * M7.3 heartbeat — `hb` is acked by the relay process itself, only for the
    socket that owns the agent slot, never forwarded, and costs no rate-limit
    token. A parked/superseded socket gets no ack on purpose.
  * M7.1 slot generations — the slot changes hands at `hello` time by
    `started`; an older hello is closed with 4000 and never evicts the holder,
    and nothing evicts at WebSocket-upgrade time.

The two files are different languages in different shapes, so this is not a
textual diff: each rule is a normalized-snippet assertion that must match both
files. Plain Python, no dependencies, read-only.

Usage: python3 tools/relay_lockstep.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CF = ROOT / "relay-cf" / "src" / "index.ts"
NODE = ROOT / "relay-node" / "server.js"


def normalize(source: str) -> str:
    """Strip the noise that only reflects each implementation's shape."""
    text = source
    text = text.replace("this.", "")
    text = text.replace("await ", "")
    text = text.replace("agentMeta?.started ?? 0", "agentMeta.started")
    text = text.replace("(agentMeta.started)", "agentMeta.started")
    text = re.sub(r"\s+", " ", text)
    return text


def find(pattern: str, text: str) -> str | None:
    m = re.search(pattern, text)
    return m.group(0) if m else None


def main() -> int:
    cf = normalize(CF.read_text(encoding="utf-8"))
    node = normalize(NODE.read_text(encoding="utf-8"))
    results: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        results.append((name, ok, detail))
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))

    # ---- M7.3 heartbeat --------------------------------------------------
    hb = (
        r"if \(frame\.t === 'hb'\) \{ if \(ws !== agent\) return; "
        r"sendJson\(ws, typeof frame\.id === 'string' \? \{ t: 'hb_ack', id: frame\.id \} "
        r": \{ t: 'hb_ack' \}\); return; \}"
    )
    cf_hb, node_hb = find(hb, cf), find(hb, node)
    check("hb: ack only the slot holder, never forwarded", bool(cf_hb and node_hb), (cf_hb or "no match")[:90])

    bucket = cf.find("takeToken()")
    check(
        "cf: hb is handled before the rate-limit bucket",
        bucket != -1 and cf.find("if (frame.t === 'hb')") != -1 and cf.find("if (frame.t === 'hb')") < bucket,
        f"hb@{cf.find(chr(105) + 'f (frame.t')}, bucket@{bucket}",
    )
    check(
        "node: hb never reaches a client (client path drops it)",
        bool(find(r"if \(frame\.t === 'hb'\) return;", node.split("function handleClient(ws)")[-1])),
    )
    check(
        "cf: hb from a client socket is dropped too",
        # the hb block runs before the role split, and a client is never `agent`
        cf.find("if (frame.t === 'hb')") < cf.find("if (role === 'agent')"),
        "hb block precedes the role branch",
    )

    # ---- M7.1 slot generations ------------------------------------------
    gen = r"if \(agent && agent !== ws && started < agentMeta\.started\) \{"
    check("generations: an older hello never evicts the holder", bool(find(gen, cf) and find(gen, node)))

    check(
        "generations: no eviction at WebSocket-upgrade time",
        "close(REPLACED_CODE" not in cf[cf.find("upgradeAgent") : cf.find("handleAgentHello")]
        and "close(REPLACED_CODE" not in node[node.find("function handleAgent(ws)") : node.find("if (frame.t === 'hello')")],
        "cf upgradeAgent / node pre-hello path",
    )

    code = r"const REPLACED_CODE = 4000;"
    check("both close a superseded agent with 4000", bool(find(code, cf) and find(code, node)))

    # ---- hello win order -------------------------------------------------
    # cf awaits flushOutbox() between peer and ready; normalization removed the
    # `await`, so both must now read exactly `peer; flushOutbox(); ready;`.
    win_order = (
        r"sendJson\(ws, \{ t: 'peer',[^;]*\); flushOutbox\(\); "
        r"sendJson\(ws, \{ t: 'ready', agentOnline: true \}\);"
    )
    cf_order = find(win_order, cf)
    node_order = find(win_order, node)
    check("hello win order is peer -> flushOutbox -> ready", bool(cf_order and node_order), (cf_order or "no match")[:90])

    failed = [r for r in results if not r[1]]
    print(f"\nchecks: {len(results)}, failed: {len(failed)}")
    if failed:
        return 1
    print("RELAY LOCKSTEP PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
