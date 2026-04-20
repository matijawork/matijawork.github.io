#!/usr/bin/env bash
# cleanup.sh — briše stare arhive i rotira log.json
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 1. Brisanje archive/PLAN-*.md starijih od 30 dana
if [[ -d archive ]]; then
  find archive -type f -name 'PLAN-*.md' -mtime +30 -print -delete 2>/dev/null || true
fi

# 2. Rotacija log.json — keep zadnjih 500 unosa
if [[ -f log.json ]]; then
  python3 - <<'PYEOF'
import json, sys
try:
    data = json.load(open('log.json'))
except Exception as e:
    print(f"ERR log.json: {e}", file=sys.stderr); sys.exit(1)
KEEP = 500
changed = False
for key in ('checks', 'issues_resolved'):
    if isinstance(data.get(key), list) and len(data[key]) > KEEP:
        data[key] = data[key][-KEEP:]
        changed = True
if changed:
    json.dump(data, open('log.json','w'), indent=2, ensure_ascii=False)
    print("rotated")
else:
    print("no rotation needed")
PYEOF
fi
