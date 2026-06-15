# Coach Reconciliation Dashboard

Compares theoretical coach assignments (New info teams sheet) against actual sessions (Skello export) to detect discrepancies month by month.

---

## View locally (quick start)

```bash
cd "Skello C"
python3 -m http.server 8000
# open http://localhost:8000
```

Without `data/output.json` the dashboard shows **sample data**. Generate real data with the steps below.

---

## Generate real data

### Option A – CSV export (no credentials needed)

1. Open each Google Sheet, **File → Download → Comma-separated values**

   | File | Tab to export | Save as |
   |------|--------------|---------|
   | File 1 | `New info teams` | `data/teams.csv` |
   | File 2 | `Data` | `data/sessions.csv` |

2. Run:
   ```bash
   pip install -r requirements.txt
   python3 process.py --csv
   ```

### Option B – Google Sheets API (one-time setup, then fully automatic)

1. Go to [Google Cloud Console](https://console.cloud.google.com) → create a project  
2. Enable **Google Sheets API** and **Google Drive API**  
3. Create a **Service Account** → download JSON key → save as `credentials.json` in this folder  
4. Share both Google Sheets with the service account email (view-only)  
5. Run:
   ```bash
   pip install -r requirements.txt
   python3 process.py
   ```

---

## Data format requirements

### Teams file (`data/teams.csv` — "New info teams" tab)

The script reads by column position (not header name):

| Column | Position | Expected content |
|--------|----------|-----------------|
| D | index 3 | Full team name — for Academy/GK includes day+time suffix e.g. `ACADEMY Nexus 2015-2017 MO1800` |
| E | index 4 | Skello session name — matches col H in sessions file (e.g. `Academy Nexus 2015-2017`). Empty for Select teams. |
| L | index 11 | `Academy` / `Select` / `GK` |
| AB | index 27 | ID Coach 1 (numeric) |
| AC | index 28 | Coach name 2026 |

### Sessions file (`data/sessions.csv` — "Data" tab)

| Column | Position | Expected content |
|--------|----------|-----------------|
| F | index 5 | Date `DD/MM/YYYY` |
| H | index 7 | Session / team name |
| J | index 9 | Start time `HH:MM` |
| S | index 18 | Status — rows with `No clock in` are excluded |
| U | index 20 | Coach ID (numeric) |
| X | index 23 | Activity (`Academy` / `Select` / `GK` / ...) |

Only sessions with Activity = `Academy`, `Select`, or `GK`, from **01/01/2026 onwards**, Monday–Saturday, are included.

---

## Matching logic

**Academy / GK teams** — two-step match:
1. **Skello name** (col E, e.g. `Academy Nexus 2015-2017`) matched against session name (col H) — case-insensitive
2. **Slot** (col D suffix e.g. `MO1800` = Monday 18:00) matched against session day-of-week + start hour+minute

This is necessary because the same team name can have multiple time slots on different days with different assigned coaches.

**Select teams** — matched by name:
1. Exact match: column E (Skello name) ↔ column H (session name)
2. Normalised match: strip `SELECT ` prefix, case-insensitive
3. Partial match: longest common prefix

---

## Dashboard features

- Expandable rows by category (Academy / Select / GK)
- Reference coach column per team
- Monthly columns (A = assigned coach, O = other coach)
- Green cells = assigned coach showed up; red cells = different coach
- Summary bar: total sessions, assigned count, other count, match rate %
- Unmatched sessions listed below the table

---

## Deploy to GitHub Pages

```bash
# After running process.py
git add data/output.json
git commit -m "Update reconciliation data"
git push
```

Then in the GitHub repo → Settings → Pages → Deploy from branch `main` / root.

---

## Known data notes

- **`ACADEMY NEXUS GIRLS 2014-2016`** sessions (35 rows) are unmatched because the Skello session name differs from what is recorded in column E of the teams file (`Academy Nexus 2014-2016`). Update column E in the teams file to `Academy Nexus Girls 2014-2016` to fix this.
- Sessions with Activity = `JSSL / SYL Game Support` are automatically excluded (not in scope).
- The `data/sessions.csv` file is excluded from git (large raw export). Re-export from Skello each time you want to refresh the data.
