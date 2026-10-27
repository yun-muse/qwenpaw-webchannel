#!/usr/bin/env bash
# Build dist/webchannel.zip for QwenPaw's runtime plugin installer.
#
# Install contract, from QwenPaw v2.2.2.post1 src/qwenpaw/app/routers/plugins.py
# (vendored at .ref_tmp/plugins_router.py):
#
#   POST /api/plugins/upload   multipart field "file", filename must end .zip
#                              (?force=true to reinstall a loaded plugin)
#   POST /api/plugins/install  {"source": "<local path>" | "<http(s) zip url>",
#                               "force": false}
#   _find_plugin_dir()         accepts plugin.json at the archive ROOT or in a
#                              SINGLE top-level subdirectory
#   _safe_extract_zip()        rejects absolute / ".." members (Zip Slip)
#
# So the files go at the zip ROOT (no wrapper directory). Only the runtime
# files are packaged: tests/, __pycache__/ and *.pyc never enter the archive
# because membership is an explicit allowlist, not a directory walk.
#
# Usage: bash tools/package_plugin.sh   (from anywhere; repo root is derived)
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
PLUGIN_DIR="$ROOT_DIR/plugin"
DIST_DIR="$ROOT_DIR/dist"
OUT="$DIST_DIR/webchannel.zip"

FILES=(
  plugin.json
  plugin.py
  channel.py
  frames.py
  util.py
  relay_client.py
  filelog.py
  turso_archive.py
  README.md
)

die() { echo "error: $*" >&2; exit 1; }

[ -d "$PLUGIN_DIR" ] || die "plugin directory not found: $PLUGIN_DIR"
for f in "${FILES[@]}"; do
  [ -f "$PLUGIN_DIR/$f" ] || die "missing plugin file: plugin/$f"
done

mkdir -p "$DIST_DIR"
rm -f "$OUT"   # start from scratch so a stale archive can never be shipped

# Preferred builder: python3 zipfile. Fixed timestamps + fixed mode + sorted
# input make the archive byte-identical for identical sources (diffable,
# cache-friendly). Falls back to `zip` on a python3-less box.
if command -v python3 >/dev/null 2>&1; then
  python3 - "$PLUGIN_DIR" "$OUT" "${FILES[@]}" <<'PY'
import json
import os
import sys
import zipfile

plugin_dir, out = sys.argv[1], sys.argv[2]
files = sys.argv[3:]
FIXED_DATE = (1980, 1, 1, 0, 0, 0)

with open(os.path.join(plugin_dir, "plugin.json"), encoding="utf-8") as fh:
    manifest = json.load(fh)

# The loader imports entry.backend from the plugin dir; a manifest pointing at
# a file we did not package fails only after upload, so catch it here.
backend = (manifest.get("entry") or {}).get("backend")
if backend and backend not in files:
    sys.exit(f"error: plugin.json entry.backend {backend!r} is not packaged")

tmp = out + ".tmp"
with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for name in files:
        info = zipfile.ZipInfo(name, date_time=FIXED_DATE)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3          # unix
        info.external_attr = 0o644 << 16
        with open(os.path.join(plugin_dir, name), "rb") as fh:
            zf.writestr(info, fh.read(), compresslevel=9)
os.replace(tmp, out)
print(f"wrote {out} (plugin id {manifest.get('id')!r}, "
      f"version {manifest.get('version')!r})")
PY
elif command -v zip >/dev/null 2>&1; then
  # -X drops extra file attributes so the archive stays reproducible.
  ( cd "$PLUGIN_DIR" && zip -X -q -9 "$OUT" "${FILES[@]}" )
  echo "wrote $OUT (via zip)"
else
  die "neither python3 nor zip is available; install one of them"
fi

# unzip -l equivalent (python3 first so the columns match on every machine).
if command -v python3 >/dev/null 2>&1; then
  python3 - "$OUT" <<'PY'
import os
import sys
import zipfile

path = sys.argv[1]
with zipfile.ZipFile(path) as zf:
    rows = [(i.filename, i.file_size, i.compress_size) for i in zf.infolist()]

names = [r[0] for r in rows]
if "plugin.json" not in names:
    sys.exit("error: plugin.json is not at the archive root")

print(f"Archive:  {path}  ({os.path.getsize(path)} bytes)")
print(f"{'Length':>10}  {'Compressed':>10}  Name")
print(f"{'-' * 10}  {'-' * 10}  {'-' * 4}")
for name, size, csize in rows:
    print(f"{size:>10}  {csize:>10}  {name}")
print(f"{'-' * 10}  {'-' * 10}  {'-' * 4}")
print(f"{sum(r[1] for r in rows):>10}  {sum(r[2] for r in rows):>10}  "
      f"{len(rows)} files")
PY
elif command -v unzip >/dev/null 2>&1; then
  unzip -l "$OUT"
else
  echo "(no python3/unzip; listing skipped)"
fi

echo
echo "Install (hosted, no restart needed):"
echo "  POST /api/plugins/upload   multipart file=@dist/webchannel.zip  (?force=true)"
echo "  POST /api/plugins/install  {\"source\":\"https://<host>/webchannel.zip\"}"
