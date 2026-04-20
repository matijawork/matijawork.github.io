#!/usr/bin/env bash
# scrape_tsrb.sh — TSRB dnevne izmjene scraper za razred 3.B
# Usage: ./scrape_tsrb.sh YYYY-MM-DD
# Exit codes: 0=nema promjena, 1=promjene pronađene, 2=fetch/parse fail
set -euo pipefail

TARGET_DATE="${1:-}"
CLASS="3.B"
DOCS_URL="https://docs.google.com/document/d/e/2PACX-1vSy4jAOFM_AjuE8BAryWhcEc48Jqriq0yt4k342BV5SvQbyEO67GpMvfOQglVPkkrUxRJxmeNvwXpOH/pub"
FALLBACK_URL="https://www.tsrb.hr/a-smjena/"

if [[ -z "$TARGET_DATE" ]]; then
  echo "ERR: missing YYYY-MM-DD arg" >&2
  exit 2
fi
if ! [[ "$TARGET_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "ERR: bad date format, expected YYYY-MM-DD" >&2
  exit 2
fi

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

fetch() {
  curl -sfL --max-time 10 -A "Mozilla/5.0" "$1" -o "$TMP" 2>/dev/null
}

SOURCE=""
if fetch "$DOCS_URL" && [[ -s "$TMP" ]] && grep -q "IZMJENE U RASPOREDU" "$TMP"; then
  SOURCE="docs"
elif fetch "$FALLBACK_URL" && [[ -s "$TMP" ]]; then
  SOURCE="tsrb"
else
  echo "ERR: both sources failed" >&2
  exit 2
fi

python3 - "$TARGET_DATE" "$CLASS" "$SOURCE" "$TMP" <<'PYEOF'
import sys, re
from datetime import date

target, cls, source, path = sys.argv[1:5]

MONTHS = ['siječnja','veljače','ožujka','travnja','svibnja','lipnja',
          'srpnja','kolovoza','rujna','listopada','studenoga','prosinca']
DAYS = ['PONEDJELJAK','UTORAK','SRIJEDA','ČETVRTAK','PETAK','SUBOTA','NEDJELJA']

y, m, d = map(int, target.split('-'))
dt = date(y, m, d)
dayname = DAYS[dt.weekday()]
monthname = MONTHS[m-1].upper()
target_pat = rf"{dayname},\s*{d}\.\s*{monthname}\s*{y}"

try:
    html = open(path, encoding='utf-8').read()
except Exception as e:
    print(f"ERR: read {e}", file=sys.stderr); sys.exit(2)

body_m = re.search(r'<body[^>]*>(.*?)</body>', html, re.DOTALL)
if not body_m:
    print("ERR: no body", file=sys.stderr); sys.exit(2)
body = body_m.group(1)
body = re.sub(r'<style[^>]*>.*?</style>', '', body, flags=re.DOTALL)
body = re.sub(r'<script[^>]*>.*?</script>', '', body, flags=re.DOTALL)

sections = re.split(r'IZMJENE U RASPOREDU\s*[-–—]?\s*([A-ZČŠŽĐĆ]+,\s*\d+\.\s*[A-ZČŠŽĐĆ]+\s*\d{4})', body)
found = None
matched_hdr = None
for i in range(1, len(sections), 2):
    hdr = sections[i]
    if re.search(target_pat, hdr, re.IGNORECASE):
        found = sections[i+1] if i+1 < len(sections) else ""
        matched_hdr = hdr
        break

if found is None:
    print(f"# nema sekcije za {target} (nisu objavljene izmjene)")
    sys.exit(0)

def clean(c):
    c = re.sub(r'<[^>]+>', '', c)
    c = re.sub(r'&nbsp;', ' ', c)
    c = re.sub(r'&amp;', '&', c)
    c = re.sub(r'&quot;', '"', c)
    c = re.sub(r'\s+', ' ', c)
    return c.strip()

tables = re.findall(r'<table[^>]*>(.*?)</table>', found, re.DOTALL)
changes = []
hours = None
if tables:
    rows = re.findall(r'<tr[^>]*>(.*?)</tr>', tables[0], re.DOTALL)
    class_row = None
    for r in rows:
        cells = re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', r, re.DOTALL)
        cells = [clean(c) for c in cells]
        if not cells: continue
        first = cells[0].upper().replace(' ','')
        if first in ('PRIJEPODNE','POSLIJEPODNE'):
            hours = cells
            continue
        if first == cls.upper():
            class_row = cells
            break
    if class_row and hours:
        for i, cell in enumerate(class_row[1:], start=1):
            if cell and cell.upper() != 'X':
                hour = hours[i].rstrip('.') if i < len(hours) else str(i)
                changes.append((hour, cell))

text = clean(found)
room_changes = []
for m in re.finditer(r'(\d+)\s*\.?\s*SAT:\s*(.*?)(?=\d+\s*\.?\s*SAT:|$)', text, re.DOTALL):
    hour = m.group(1)
    content = m.group(2)
    for rm in re.finditer(
        re.escape(cls) + r'\s*[-–]\s*([A-ZČŠŽĐĆ/]+)\s*[-–]\s*(UČ\.\s*[\w\-/.]+|KAB\.\w+)',
        content
    ):
        room_changes.append((hour, rm.group(1), rm.group(2)))

if not changes and not room_changes:
    print(f"# {cls}: nema promjena za {target}")
    sys.exit(0)

print(f"DATUM: {target}")
print(f"RAZRED: {cls}")
print(f"SOURCE: {source}")
print(f"HEADER: {matched_hdr.strip()}")
for hour, subj in changes:
    print(f"SAT {hour}: {subj}")
for hour, subj, room in room_changes:
    print(f"SAT {hour}: {subj} @ {room}")
sys.exit(1)
PYEOF
