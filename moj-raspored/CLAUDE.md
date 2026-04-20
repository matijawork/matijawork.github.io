# Dnevna rutina — Moj raspored

Pokreni svaki dan u 21:00 (Ned–Čet, Europe/Zagreb). Generiraj plan za **sutra**.

## Preduvjeti

- Model: Sonnet 4.5, thinking OFF
- Radni dir: `moj-raspored/` poddir repoa `matijawork/matijawork.github.io`
- Sve relativne putanje u ovom dokumentu su unutar `moj-raspored/`
- Git push na `main` dozvoljen (push ide u parent repo `matijawork.github.io`)
- Pages URL: https://matijawork.github.io/moj-raspored/

## Koraci

### 1. Izračunaj sutrašnji datum

- `TARGET` = sutrašnji datum u `YYYY-MM-DD`
- `DAN_HR` = hrvatski naziv dana (ponedjeljak, utorak, …)
- `ISO_TJEDAN` = ISO broj tjedna

### 2. Provjeri skip uvjete

Skip generiranje plana ako:

- Subota ili nedjelja (subota → target je ned; rutina ne radi vikendom)
- Državni praznik: **1.5.2026** (Praznik rada), **4.6.2026** (Tijelovo)
- Ljetni mod: datum > **15.6.2026** (kraj nastave)

Ako skip: napiši `PLAN.md` samo s "Slobodan dan — {razlog}" i završi.

### 3. Odredi smjenu

```
if (ISO_TJEDAN - 17) % 2 == 0 → jutarnja  (7:00–13:05)
else                          → popodnevna (13:20–19:25)
```

Referenca: tjedan 17 (20–26.4.2026) = jutarnja.

### 4. Read state

Pročitaj:
- `inbox.md` — zadaci s tagovima (@hitno @danas @sutra @tjedan @kasnije)
- `preferences.md` — trajne preferencije i autonomy pravila
- `context.md` — tjedni kontekst (≤2KB)
- `fixed_schedule.md` — školski fiksni raspored (read-only)
- Prethodni `PLAN.md` — provjeri što je checkbox-označeno, što ne

### 5. Pokreni scraper

```bash
bash scripts/scrape_tsrb.sh "$TARGET"
```

- Exit 0 → nema promjena, zapiši `Promjene: nema` u PLAN
- Exit 1 → parse stdout (DATUM/RAZRED/SAT N: …), uključi u sekciju Škola
- Exit 2 → flag issue "Scraper fail — provjeri TSRB ručno (https://www.tsrb.hr/a-smjena/)"

### 6. Generiraj PLAN.md

Format ispod. Prioritet aktivnosti: **Biznis > Trening (1.5h obavezno) > Škola > Učenje > Kućanski**.

```markdown
# Plan za {dan_hr} {D.M.YYYY}

## Škola
- Smjena: {jutarnja|popodnevna} ({raspon})
- Učionica: 7 (3.B), razrednica Marija Eva Mrsel
- Promjene danas: {lista ili "nema"}

## Issues
- [ ] {issue opis}  ← samo ako postoji

## Torba
- [ ] knjige/bilježnice za: {predmeti iz fixed_schedule za sutra}
- [ ] oprema za trening (ako trening dan)

## Raspored
| Vrijeme | Aktivnost |
|---------|-----------|
| 07:00   | škola — 1. sat ({predmet}) |
| …       | …         |
| 14:00   | trening (1.5h) |
| 16:00   | biznis rad |
| 20:00   | učenje |
| 21:30   | check PLAN.md |
| 22:30   | spavanje |

## Checklist
- [ ] {@sutra task 1}
- [ ] {@hitno task}
- [ ] {@danas task}
```

### 7. Issues flag logika

Dodaj issue u **## Issues** sekciju kad:

- **Scraper exit 2** → "Scraper fail"
- **@sutra preopterećen**: zbroj procijenjenih sati @sutra taskova > 3h izvan škole+treninga → "Previše @sutra zadataka — razmisliti što odgoditi"
- **Konflikt fixed_schedule ↔ inbox**: task ima vrijeme koje upada u školski termin → "Preklapanje u {HH:MM}"
- **Fiksni trening preskočen**: nema "trening" u rasporedu iako nije subota/nedjelja → "Trening nije zakazan"

### 8. Arhiviranje

Prije overwrite-a `PLAN.md`:
```bash
cp PLAN.md "archive/PLAN-$(date +%Y-%m-%d).md" 2>/dev/null || true
```

### 9. Upiši log

Append u `log.json` → `checks` array:
```json
{
  "ts": "YYYY-MM-DDTHH:MM:SS+02:00",
  "type": "daily",
  "target": "YYYY-MM-DD",
  "scraper_exit": 0|1|2,
  "issues_count": N
}
```

Ako `issues_count > 0`, svaki issue → append u `issues_resolved` kad user označi ✓.

### 10. Commit + push

```bash
git add PLAN.md archive/ log.json
git commit -m "dnevni plan: $TARGET"
git push origin main
```

## Autonomy pravila

- **Smiješ** odbit @sutra task ako prekoračuje procijenjeni dnevni kapacitet → flag issue umjesto tihog dodavanja
- **Smiješ** premjestit task u @tjedan ako se očito ne stigne sutra — flag issue s razlogom
- **Ne smiješ** mijenjat `fixed_schedule.md`, `preferences.md`
- **Ne smiješ** brisat inbox stavke — samo Matija to radi

## Edge case-i

- **Scraper 2× exit 2 u redu**: issue "TSRB nedostupan 2 dana" → ručna provjera
- **Prazan inbox**: OK, generiraj plan samo s fixed_schedule + trening
- **Kontekst >2KB**: ne briši — tjedna rutina rješava
