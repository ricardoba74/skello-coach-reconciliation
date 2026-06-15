# Coach Reconciliation Dashboard

Compares theoretical coach assignments (New info teams sheet) against actual sessions (Skello export) to detect discrepancies month by month.

---

## View locally (quick start)

```bash
cd "Skello C"
python -m http.server 8000
# open http://localhost:8000
```

Without `data/output.json` the dashboard shows **sample data** from the 36 Select teams already extracted. Add real data with the steps below.

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
   python process.py --csv
   ```

### Option B – Google Sheets API (one-time setup, then fully automatic)

1. Go to [Google Cloud Console](https://console.cloud.google.com) → create a project  
2. Enable **Google Sheets API** and **Google Drive API**  
3. Create a **Service Account** → download JSON key → save as `credentials.json` in this folder  
4. Share both Google Sheets with the service account email (view-only)  
5. Run:
   ```bash
   pip install -r requirements.txt
   python process.py
   ```

---

## Data format requirements

### Teams file (`data/teams.csv` or "New info teams" tab)

The script reads by column position (not header name):

| Column | Position | Expected content |
|--------|----------|-----------------|
| D | 4th (index 3) | Team name |
| E | 5th (index 4) | Skello name — for Select: exact name as in Skello; for Academy/GK: day+hour code e.g. `Mo16` |
| L | 12th (index 11) | `Academy` / `Select` / `GK` |
| AB | 28th (index 27) | ID Coach 1 (numeric) |
| AC | 29th (index 28) | Coach name 2026 |

### Sessions file (`data/sessions.csv` or "Data" tab)

| Column | Position | Expected content |
|--------|----------|-----------------|
| F | 6th (index 5) | Date `DD/MM/YYYY` |
| H | 8th (index 7) | Session / team name |
| J | 10th (index 9) | Start time `HH:MM` |
| S | 19th (index 18) | Status — rows with `No clock in` are excluded |
| U | 21st (index 20) | Coach ID (numeric) |
| X | 24th (index 23) | Activity (`Academy` / `Select` / `GK` / ...) |

Only sessions with Activity = `Academy`, `Select`, or `GK`, from **01/01/2026 onwards**, Monday–Saturday, are included.

---

## Matching logic

**Select teams** — matched by name:
1. Exact match: column E (Skello name) ↔ column H (session name)
2. Normalized match: strip `SELECT ` prefix, case-insensitive
3. Partial match: longest common prefix

**Academy / GK teams** — matched by schedule:
- Extract `Mo16` → Monday 16 h from column E (or column D if E is empty)
- Match against: day-of-week derived from date (col F) + start hour (col J)

---

## Deploy to GitHub Pages

```bash
# First time
git init
git add index.html process.py requirements.txt README.md .gitignore
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main

# After running process.py (to publish fresh data)
git add data/output.json
git commit -m "Update reconciliation data"
git push
```

Then in the GitHub repo → Settings → Pages → Deploy from branch `main` / root.

---

## Known data issues (pending)

1. **Skello export (File 2) only has data up to May 2024** – need a fresh export covering Jan 2026 onwards.  
2. **Academy and GK teams missing** from the "New info teams" tab – only 36 Select teams found there. Confirm which tab/file contains Academy + GK coach assignments.  
3. **Column E (Skello name) is empty** for all Select rows – the script falls back to normalized team name matching.
