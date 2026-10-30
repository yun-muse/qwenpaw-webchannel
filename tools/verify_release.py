#!/usr/bin/env python3
"""M38 — production consistency sweep for the public WebChannel deployment.

Read-only release check: it never deploys, never writes into the repo (the ZIP
rebuild happens in a temp directory) and never prints secret values.

What it proves, in one run:

 1. SPA  — /version.json `git` equals this checkout's HEAD, its `build` id is
            the one stamped into the live /sw.js and inlined into the live
            bundle, and (when spa/dist exists) the live index.html, sw.js and
            JS/CSS assets are byte-identical to a build of HEAD once the
            build id + timestamp are normalized.
 2. ZIP  — the plugin-dist archive equals dist/webchannel.zip and a fresh
            deterministic `tools/package_plugin.sh` build of the current
            plugin/ sources (MD5).
 3. Relay— /health answers with the documented shape and /poll stays 501.
 4. Boot — the live index.html still carries the inline M29 watchdog
            (boot-splash / boot-watchdog / webchannel.selfHealAt).
 5. Wire — the live bundle was built WITH VITE_RELAY_WS/VITE_RELAY_HTTP: a
            hosted build folds the local/cloud demo switch away, so the
            string 本地演示节点 must not be there. Without the env the page
            opens fine but dials 127.0.0.1 (docs/m38-report.md §0).

The byte comparison assumes `spa/dist` is the build you just deployed (same
VITE_RELAY_* env). Running it against a demo `spa/dist` is exactly how the
missing-env deployment shows up.

Usage:
    python3 tools/verify_release.py

Env overrides (defaults are the public production targets):
    M38_SPA_BASE     https://qwenpaw-webchannel-spa.pages.dev
    M38_RELAY_BASE   https://qwenpaw-webchannel-relay.yxliwangsheng.workers.dev
    M38_PLUGIN_ZIP   https://qwenpaw-plugin-dist.pages.dev/webchannel.zip
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPA_BASE = os.environ.get("M38_SPA_BASE", "https://qwenpaw-webchannel-spa.pages.dev").rstrip("/")
RELAY_BASE = os.environ.get(
    "M38_RELAY_BASE", "https://qwenpaw-webchannel-relay.yxliwangsheng.workers.dev"
).rstrip("/")
PLUGIN_ZIP = os.environ.get(
    "M38_PLUGIN_ZIP", "https://qwenpaw-plugin-dist.pages.dev/webchannel.zip"
)

TIMEOUT_S = 30


def fetch(url: str) -> bytes:
    """GET with two retries: the proxy in front of this box drops idle TLS now and then."""
    req = urllib.request.Request(url, headers={"User-Agent": "webchannel-m38-sweep"})
    for attempt in (1, 2, 3):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                return resp.read()
        except urllib.error.HTTPError:
            raise
        except Exception:  # noqa: BLE001 - network hiccup, retry
            if attempt == 3:
                raise
            time.sleep(0.4 * attempt)
    raise AssertionError("unreachable")


def md5(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def head_short() -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        )
        return out.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def normalize_build(text: str) -> str:
    """Blank out the per-build id/timestamp so two builds of one commit match.

    `version.json` carries `<git>-<Date.now()>`, the same string is inlined into
    the bundle (`__BUILD_ID__`) and stamped into sw.js, and the ISO build time
    rides along. Those three change on every build; everything else is a pure
    function of the source tree.
    """
    text = re.sub(r"\b[0-9a-f]{7,40}-\d{10,}", "BUILD_ID", text)
    text = re.sub(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z", "BUILD_TIME", text)
    return text


def normalize_asset_names(text: str) -> str:
    """Blank out Vite's content hashes in `/assets/<name>-<hash>.<ext>`.

    The entry bundle's hash changes with the build id, so two builds of one
    commit never share it. Content-addressed assets (css, the lazy KaTeX
    chunk) keep their hash and are compared byte for byte separately.
    """
    return re.sub(
        r"(/assets/[A-Za-z0-9_]+)-[A-Za-z0-9_-]{8}\.(js|css)", r"\1-HASH.\2", text
    )


def asset_paths(html: str) -> list[str]:
    return sorted(set(re.findall(r"/assets/[A-Za-z0-9_.-]+\.(?:js|css)", html)))


def main() -> int:
    results: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        results.append((name, bool(ok), detail))
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))

    head = head_short()

    # ---- 1. SPA build identity ------------------------------------------
    version = json.loads(fetch(f"{SPA_BASE}/version.json"))
    check(
        "version.json git == repo HEAD",
        version.get("git") == head,
        f"live={version.get('git')!r} head={head!r}",
    )
    build = str(version.get("build") or "")
    check(
        "version.json build is <git>-<timestamp>",
        build.startswith(f"{head}-") and build[len(head) + 1 :].isdigit(),
        build,
    )

    sw = fetch(f"{SPA_BASE}/sw.js").decode("utf-8")
    m = re.search(r"const BUILD = '([^']+)'", sw)
    check("sw.js BUILD == version.json build", bool(m and m.group(1) == build), m.group(1) if m else "no BUILD const")
    check("sw.js cache name is build-scoped", "webchannel-static-${BUILD}" in sw, "webchannel-static-${BUILD}")

    index = fetch(f"{SPA_BASE}/").decode("utf-8")
    check("index.html carries the inline boot watchdog", 'id="boot-watchdog"' in index, 'id="boot-watchdog"')
    check("index.html paints the boot splash", 'id="boot-splash"' in index, 'id="boot-splash"')
    check("watchdog keeps the self-heal marker", "webchannel.selfHealAt" in index, "webchannel.selfHealAt")

    assets = asset_paths(index)
    js_assets = [a for a in assets if a.endswith(".js")]
    check("index.html references a JS entry", len(js_assets) == 1, ", ".join(js_assets) or "none")
    live_bundle = fetch(f"{SPA_BASE}{js_assets[0]}").decode("utf-8") if js_assets else ""
    check("live bundle carries the build id", build in live_bundle, build)

    # A hosted build must bake VITE_RELAY_WS/VITE_RELAY_HTTP in: when both are
    # set, `LOGIN_REQUIRED` is a compile-time true, the local/cloud endpoint
    # switch is dead code, and the sidebar label disappears from the bundle.
    # Its presence means the deployment is the local-demo build — the SPA would
    # dial 127.0.0.1 before the user finds the switch (docs/m38-report.md §0).
    relay_wired = bool(live_bundle) and "本地演示节点" not in live_bundle
    check(
        "live bundle is relay-wired (demo endpoint switch compiled out)",
        relay_wired,
        "" if relay_wired else "found 本地演示节点 — built without VITE_RELAY_WS/VITE_RELAY_HTTP",
    )

    dist = ROOT / "spa" / "dist"
    if (dist / "index.html").is_file():
        local_index = (dist / "index.html").read_text(encoding="utf-8")
        local_assets = asset_paths(local_index)
        local_js = [a for a in local_assets if a.endswith(".js")]
        if local_js:
            local_bundle = (dist / local_js[0].lstrip("/")).read_text(encoding="utf-8")
            check(
                "live bundle == fresh HEAD build (build id normalized)",
                normalize_build(local_bundle) == normalize_build(live_bundle),
                f"{len(live_bundle)} vs {len(local_bundle)} chars",
            )
        check(
            "live index.html == fresh HEAD build (asset name normalized)",
            normalize_asset_names(normalize_build(local_index))
            == normalize_asset_names(normalize_build(index)),
            f"{len(index)} vs {len(local_index)} chars",
        )
        local_sw = (dist / "sw.js").read_text(encoding="utf-8")
        check("live sw.js == fresh HEAD build", normalize_build(local_sw) == normalize_build(sw))
        # Content-addressed assets keep their hash across builds, so any asset
        # the live page references by the same name must match byte for byte.
        for asset in assets:
            local_file = dist / asset.lstrip("/")
            if not local_file.is_file():
                continue
            try:
                live = fetch(f"{SPA_BASE}{asset}")
            except Exception as err:  # noqa: BLE001 - report, never crash the sweep
                check(f"asset {asset}", False, str(err))
                continue
            check(f"asset {asset} identical", live == local_file.read_bytes(), f"{len(live)} bytes")
        # Lazy chunks are not in index.html; the entry bundle names them as
        # `./katex-<hash>.js` (relative to /assets/) and `assets/*.css`.
        lazy = sorted(
            set(re.findall(r"(?:\./|/assets/|assets/)([A-Za-z0-9_-]+\.(?:js|css))", live_bundle))
        )
        for name in lazy:
            local_file = dist / "assets" / name
            if not local_file.is_file():
                continue
            try:
                live = fetch(f"{SPA_BASE}/assets/{name}")
            except Exception as err:  # noqa: BLE001
                check(f"lazy asset {name}", False, str(err))
                continue
            check(f"lazy asset {name} identical", live == local_file.read_bytes(), f"{len(live)} bytes")
    else:
        print("SKIP  spa/dist is absent — rebuild with `cd spa && npm run build` for the byte comparison")

    # ---- 2. plugin ZIP ---------------------------------------------------
    live_zip = fetch(PLUGIN_ZIP)
    dist_zip = ROOT / "dist" / "webchannel.zip"
    check("plugin-dist ZIP matches dist/webchannel.zip", dist_zip.is_file() and live_zip == dist_zip.read_bytes(), md5(live_zip))
    if dist_zip.is_file():
        check("dist/webchannel.zip MD5 == live MD5", md5(live_zip) == md5(dist_zip.read_bytes()), md5(live_zip))

    with tempfile.TemporaryDirectory(prefix="m38-pkg-") as tmp:
        tmp_path = Path(tmp)
        (tmp_path / "tools").mkdir()
        shutil.copy2(ROOT / "tools" / "package_plugin.sh", tmp_path / "tools" / "package_plugin.sh")
        os.symlink(ROOT / "plugin", tmp_path / "plugin")
        proc = subprocess.run(
            ["bash", str(tmp_path / "tools" / "package_plugin.sh")],
            capture_output=True,
            text=True,
        )
        rebuilt = tmp_path / "dist" / "webchannel.zip"
        ok = proc.returncode == 0 and rebuilt.is_file()
        rebuilt_md5 = md5(rebuilt.read_bytes()) if ok else ""
        check(
            "package_plugin.sh rebuild of plugin/ == live ZIP",
            ok and rebuilt_md5 == md5(live_zip),
            f"rebuilt={rebuilt_md5 or 'build failed'} live={md5(live_zip)}",
        )

    # ---- 3. relay health -------------------------------------------------
    health = json.loads(fetch(f"{RELAY_BASE}/health"))
    check("relay /health ok", health.get("ok") is True, json.dumps(health, ensure_ascii=False))
    check("relay /health reports agentOnline", isinstance(health.get("agentOnline"), bool), str(health.get("agentOnline")))
    check("relay /health reports clients", isinstance(health.get("clients"), int), str(health.get("clients")))
    check(
        "relay /health agentLastSeen is null or epoch ms",
        health.get("agentLastSeen") is None or isinstance(health.get("agentLastSeen"), int),
        str(health.get("agentLastSeen")),
    )
    try:
        fetch(f"{RELAY_BASE}/poll")
        poll_code = 200
    except urllib.error.HTTPError as err:
        poll_code = err.code
    except Exception as err:  # noqa: BLE001 - transport failure is a FAIL, not a crash
        poll_code = f"error: {err}"
    check("/poll is still 501 (documented deferral)", poll_code == 501, str(poll_code))

    # ---- summary ---------------------------------------------------------
    failed = [r for r in results if not r[1]]
    print(f"\nchecks: {len(results)}, failed: {len(failed)}, head: {head}")
    if failed:
        for name, _, detail in failed:
            print(f"FAILED {name} — {detail}")
        return 1
    print("M38 RELEASE SWEEP PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
