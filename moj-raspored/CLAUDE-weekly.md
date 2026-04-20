# Tjedna rutina — Moj raspored

Pokreni nedjeljom u 20:00 (Europe/Zagreb). Analiziraj zadnji tjedan i update kontekst.

## Preduvjeti

- Model: Sonnet 4.5, thinking OFF
- Radni dir: `moj-raspored/` poddir repoa `matijawork/matijawork.github.io`
- Git push na `main` dozvoljen

## Koraci

### 1. Read data

- Svi `archive/PLAN-*.md` zadnjih 7 dana
- `log.json` (zadnjih 50 `checks` + `issues_resolved`)
- Trenutni `context.md`

### 2. Analiza

Izračunaj:
- Koliko @sutra taskova završeno vs. premješteno
- Koji tipovi taskova najčešće failaju (biznis, učenje, kućanski)
- Je li trening ispunjen 1.5h svaki dan (osim vikend)
- Koliko issue-a je flagano vs. resolved
- Scraper uspješnost (% exit 0/1 vs 2)

### 3. Update context.md

Hard limit: **2048 bytes**. Ako novi context prelazi → trim najstarije natuknice.

Format:
```markdown
# Kontekst ({tjedan X})

## Zadnji tjedan
- {ključni nalaz 1, max 100 znakova}
- {ključni nalaz 2}

## Trendovi (zadnjih 4 tj.)
- {trend, npr. "biznis taskovi česti u @kasnije — razmotri dodijeliti blok"}

## Fokus sljedeći tjedan
- {1–3 natuknice}
```

### 4. Cleanup

```bash
bash scripts/cleanup.sh
```

### 5. Log + commit

Append u `log.json` → `checks`:
```json
{"ts": "…", "type": "weekly", "week": N, "archived_days": N}
```

Commit:
```bash
git add context.md log.json archive/
git commit -m "tjedni sažetak: tj. $ISO_TJEDAN"
git push origin main
```

## Limiti

- `context.md` ≤ 2048B uvijek
- Ne mijenjaj `preferences.md`, `fixed_schedule.md`, `inbox.md`
