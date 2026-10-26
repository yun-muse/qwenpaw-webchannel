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
    while time.time() < deadline:
        time.sleep(5)
        cur = req("GET", f"/api/session/{sid}")
        d = cur.get("data", cur)
        outcome = d.get("outcome")
        idle = d.get("time", {}).get("idle")
        state = (outcome, idle)
        if state != last:
            print("state:", state, flush=True); last = state
        if outcome in ("succeeded", "failed", "error") or (idle and outcome):
            break
        # sessions that finish set outcome; also break if idle long after start
        if idle and time.time() > deadline - a.timeout + 120 and outcome is None:
            pass
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
    sys.exit(0 if d.get("outcome") == "succeeded" else 2)

if __name__ == "__main__":
    main()
