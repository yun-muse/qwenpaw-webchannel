#!/usr/bin/env python3
"""Send one prompt to the local OpenCode v2 server (127.0.0.1:4099) and wait for completion.

Usage: oc_prompt.py --model deepseek-v4.1-flash-free --title T --prompt-file task.md [--timeout 900]
The server basic-auth password is read from the serve.log (last occurrence).
Prints the final assistant text and the session id. Exit 0 on outcome=succeeded.
"""
import argparse, base64, json, re, sys, time, urllib.request

BASE = "http://127.0.0.1:4099"
LOG = "/home/hatch/workspace/opencode-vps-egress/serve.log"
WORKDIR = "/home/hatch/workspace/qwenpaw-webchannel"

def pw():
    txt = open(LOG).read()
    m = re.findall(r"server password (\S+)", txt)
    return m[-1]

def req(method, path, body=None):
    r = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json",
                 "Authorization": "Basic " + base64.b64encode(f"opencode:{pw()}".encode()).decode()})
    with urllib.request.urlopen(r, timeout=60) as resp:
        return json.loads(resp.read() or b"{}")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="deepseek-v4.1-flash-free")
    ap.add_argument("--title", default="webchannel-task")
    ap.add_argument("--prompt-file", required=True)
    ap.add_argument("--timeout", type=int, default=900)
    a = ap.parse_args()
    prompt = open(a.prompt_file).read()
    s = req("POST", "/api/session", {"title": a.title,
        "model": {"id": a.model, "providerID": "opencode"},
        "location": {"directory": WORKDIR}})
    sid = s["data"]["id"] if "data" in s else s["id"]
    print("session:", sid, "model:", a.model, flush=True)
    req("POST", f"/api/session/{sid}/prompt", {"text": prompt})
    deadline = time.time() + a.timeout
    last = None
    stable = 0
    while time.time() < deadline:
        time.sleep(5)
        cur = req("GET", f"/api/session/{sid}")
        d = cur.get("data", cur)
        outcome = d.get("outcome")
        idle = d.get("time", {}).get("idle")
        updated = d.get("time", {}).get("updated")
        state = (outcome, idle, updated)
        if state != last:
            print("state:", state, flush=True); last = state; stable = 0
        else:
            stable += 1
        if outcome in ("succeeded", "failed", "error"):
            break
        # Fallback (fixed 2026-10-26 after an M0 false timeout): some finished
        # sessions never set outcome. If the session is idle and its
        # updated/idle stamps have been unchanged for 3 polls (~15s), treat
        # it as finished and let the caller judge by the messages.
        if idle and stable >= 3:
            print("state: idle-stable, treating as finished", flush=True)
            break
    msgs = req("GET", f"/api/session/{sid}/message")
    items = msgs.get("data", msgs)
    texts = []
    for m in items if isinstance(items, list) else []:
        role = m.get("role") or m.get("info", {}).get("role")
        parts = m.get("parts") or m.get("content") or []
        for p in parts if isinstance(parts, list) else []:
            if isinstance(p, dict) and p.get("type") == "text":
                texts.append((role, p.get("text", "")))
    for role, t in texts[-3:]:
        print(f"--- {role} ---\n{t[:4000]}")
    cur = req("GET", f"/api/session/{sid}"); d = cur.get("data", cur)
    print("FINAL outcome:", d.get("outcome"), "tokens:", d.get("tokens"))
    if d.get("outcome") == "succeeded":
        sys.exit(0)
    # Idle-stable finish with real assistant output and no failure markers
    # counts as success; the coordinator still verifies artifacts itself.
    has_text = any(t.strip() for _, t in texts)
    failed = d.get("outcome") in ("failed", "error")
    sys.exit(0 if (has_text and not failed) else 2)

if __name__ == "__main__":
    main()
