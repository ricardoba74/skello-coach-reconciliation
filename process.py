#!/usr/bin/env python3
"""
Coach Reconciliation – fetch data from Google Sheets, reconcile, output JSON.

Usage:
  python process.py           # reads from Google Sheets API (needs credentials.json)
  python process.py --csv     # reads from data/teams.csv + data/sessions.csv
"""

import json
import os
import re
import sys
import urllib.request
from collections import Counter
from datetime import datetime

try:
    import pandas as pd
except ImportError:
    sys.exit("Missing dependency. Run:  pip install -r requirements.txt")

# ── CONFIGURATION ─────────────────────────────────────────────────────────────

TEAMS_SHEET_ID    = "1COqOZLAQNO437dPZgQpBWsgjreI-FJlbPDfdwHPeDcA"
TEAMS_GID         = 609166241   # tab "New info teams" — shared by every term

# One entry per term. To add a new term: append here (and share its sessions
# sheet, if it's a new one, with coach-reconciliation-reader@skello-coach-
# reconciliation.iam.gserviceaccount.com as Viewer) — no other code changes
# needed, index.html and enrich-attendance.mjs both drive off data/terms_index.json.
TERMS = [
    {
        "id":                "t2_2026",
        "label":             "Term 2 2026",
        "start":             datetime(2026, 4, 20),
        "end":               datetime(2026, 7, 12),
        "sessions_sheet_id": "1wYeFyD9LvyyrvkMz-VoikeB_QAajxKtfUkuUAojDBg8",  # "KPIs Skello T2 2026"
        "sessions_gid":      0,   # tab "Data"
        "att_start":         "2026-05-04",  # historical exception: att tracking launched mid-term
    },
    {
        "id":                "t3_2026",
        "label":             "Term 3 2026",
        "start":             datetime(2026, 7, 13),
        "end":               datetime(2026, 10, 4),
        "sessions_sheet_id": "1wYeFyD9LvyyrvkMz-VoikeB_QAajxKtfUkuUAojDBg8",  # same sheet, filtered by date
        "sessions_gid":      0,
        "att_start":         "2026-07-13",  # = term start, no grace period
    },
    # Term 4 2026 (05/10/2026 – 10/01/2027): add once it's imminent — confirm
    # whether it gets its own sessions sheet or keeps sharing this one.
]

START_DATE        = datetime(2026, 1, 1)
VALID_ACTIVITIES  = {"Academy", "Select", "GK"}
VALID_DAYS        = {"Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"}

# Column positions (0-indexed) in "New info teams" tab
#
# Matched by header text, not position — a column inserted/renamed upstream
# (this tab is hand-edited) no longer silently shifts every field after it.
# Each entry lists acceptable header names in priority order (older CSV
# exports and the live sheet don't always agree on the exact label).
TEAMS_COL = {
    "team":       ["TEAM"],
    "skello":     ["SKELLO NAME"],
    "type":       ["Academy/Select"],
    "coach_id":   ["ID Coach 1"],
    "coach_name": ["Coach", "Coach 1 2026"],
}

# Column headers in "Data" tab (Skello export) — also matched by name.
SESSIONS_COL = {
    "date":       ["Date"],
    "session":    ["Work position or absence type"],
    "start":      ["Start"],
    "status":     ["Status"],
    "coach_id":   ["ID"],
    "activity":   ["Activity"],
    "coach_name": ["Full Name"],
}

# Day-code → Python weekday name (uppercase from col D suffix)
DAY_MAP = {
    "MO": "Monday", "TU": "Tuesday", "WE": "Wednesday",
    "TH": "Thursday", "FR": "Friday", "SA": "Saturday",
}

# Day-code → chronological index for sorting (Mon first, Sat last)
DAY_ORDER = {"MO": 0, "TU": 1, "WE": 2, "TH": 3, "FR": 4, "SA": 5}

# Day-of-week → short label (English 2-letter abbreviations)
DAY_ABBR = {
    "Monday": "Mo", "Tuesday": "Tu", "Wednesday": "We",
    "Thursday": "Th", "Friday": "Fr", "Saturday": "Sa",
}


# ── BARCA ACADEMY ATTENDANCE API ─────────────────────────────────────────────

def _load_env():
    """Populate os.environ from a local .env file (KEY=value per line), if present."""
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.exists(env_path):
        return
    with open(env_path, encoding="utf-8") as f:
        for line in f:
            m = re.match(r'^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$', line.strip())
            if m and m.group(1) not in os.environ:
                os.environ[m.group(1)] = m.group(2).strip().strip('"\'')


_load_env()

BARCA_TOKEN = os.environ.get("BARCA_ATTENDANCE_TOKEN", "")
BARCA_API   = "https://attendance.barcaacademy.sg/api/attendance/logs"


def _sig_tokens(name):
    """Significant word tokens: strip parentheticals, skip short words/stopwords."""
    name = re.sub(r'\([^)]*\)', '', name)
    skip = {'BIN', 'BTE', 'S/O', 'D/O', 'A', 'B', 'AND', 'THE', 'AL'}
    return [t for t in name.upper().split() if t not in skip and len(t) > 1]


def _resolve_coach_name(api_name, name_to_id, word_to_cids):
    norm = api_name.upper().strip()
    cid = name_to_id.get(norm)
    if cid is not None:
        return cid
    # Token-based voting fallback
    tokens = _sig_tokens(api_name)
    if not tokens or not word_to_cids:
        return None
    votes = Counter()
    for t in tokens:
        for c in word_to_cids.get(t, set()):
            votes[c] += 1
    if not votes:
        return None
    top = max(votes.values())
    min_votes = 1 if len(tokens) == 1 else 2
    if top < min_votes:
        return None
    winners = [c for c, cnt in votes.items() if cnt == top]
    return winners[0] if len(winners) == 1 else None


def fetch_attendance_lookup(session_dates, name_to_id=None, word_to_cids=None):
    """
    Fetch player attendance from Barca Academy API for the given dates.
    Returns a set of (coach_id: int, date: str "YYYY-MM-DD") where
    the coach submitted at least one player's attendance on that date.
    name_to_id: dict of normalized-uppercase coach name → coach_id int.
    word_to_cids: inverted index word → set of coach_ids (for fuzzy matching).
    """
    if not BARCA_TOKEN:
        print("  ⚠  BARCA_ATTENDANCE_TOKEN no configurado (.env) — se omite asistencia de jugadores.")
        return set()

    lookup = set()
    unmatched_names = set()
    dates = sorted(session_dates)
    print(f"  Fetching player attendance for {len(dates)} session dates …")

    for date_str in dates:
        page = 1
        while True:
            url = f"{BARCA_API}?from={date_str}&to={date_str}&page={page}"
            req = urllib.request.Request(
                url, headers={"Authorization": f"Bearer {BARCA_TOKEN}"}
            )
            try:
                with urllib.request.urlopen(req, timeout=15) as resp:
                    data = json.loads(resp.read().decode())
            except Exception as e:
                print(f"    ⚠  API error {date_str} p{page}: {e}")
                break

            items = data if isinstance(data, list) else (data.get("data") or [])
            total_pages = data.get("pages", 1) if isinstance(data, dict) else 1

            for s in items:
                coach_name = s.get("coach", "")
                players    = s.get("logs") or s.get("players") or []
                if not coach_name or not players:
                    continue
                cid = _resolve_coach_name(
                    coach_name, name_to_id or {}, word_to_cids or {}
                )
                if cid is not None:
                    lookup.add((cid, date_str))
                else:
                    unmatched_names.add(coach_name)

            if page >= total_pages:
                break
            page += 1

    if unmatched_names:
        print(f"    ⚠  {len(unmatched_names)} API coach names not matched to an ID:")
        for n in sorted(unmatched_names)[:10]:
            print(f"       {n}")
    print(f"    → {len(lookup)} coach-date pairs with player attendance")
    return lookup


# ── DATA LOADING ──────────────────────────────────────────────────────────────

def _sheet_to_df(gc, sheet_id, gid):
    sh = gc.open_by_key(sheet_id)
    ws = sh.get_worksheet_by_id(gid)
    records = ws.get_all_values()
    if len(records) < 2:
        return pd.DataFrame()
    return pd.DataFrame(records[1:], columns=records[0])


def _unique_session_sheets():
    """(sheet_id, gid) pairs referenced across TERMS, deduplicated — terms that
    share a sheet (e.g. Term 2 and Term 3 today) only get fetched once."""
    seen = []
    for t in TERMS:
        key = (t["sessions_sheet_id"], t["sessions_gid"])
        if key not in seen:
            seen.append(key)
    return seen


def load_via_api():
    try:
        import gspread
        from google.oauth2.service_account import Credentials
    except ImportError:
        sys.exit("Missing gspread. Run:  pip install -r requirements.txt")

    creds_file = "credentials.json"
    if not os.path.exists(creds_file):
        sys.exit(
            f"Error: {creds_file} not found.\n"
            "Follow README.md → 'Google Sheets API setup' to create a service account."
        )

    scopes = [
        "https://www.googleapis.com/auth/spreadsheets.readonly",
        "https://www.googleapis.com/auth/drive.readonly",
    ]
    creds = Credentials.from_service_account_file(creds_file, scopes=scopes)
    gc = gspread.authorize(creds)

    print("  Fetching teams sheet …")
    teams_raw = _sheet_to_df(gc, TEAMS_SHEET_ID, TEAMS_GID)

    sessions_raw_by_sheet = {}
    for sheet_id, gid in _unique_session_sheets():
        print(f"  Fetching sessions sheet {sheet_id[:12]}… (gid={gid}) …")
        sessions_raw_by_sheet[(sheet_id, gid)] = _sheet_to_df(gc, sheet_id, gid)

    return teams_raw, sessions_raw_by_sheet


def load_via_csv():
    teams_path    = "data/teams.csv"
    sessions_path = "data/sessions.csv"
    missing = [p for p in (teams_path, sessions_path) if not os.path.exists(p)]
    if missing:
        sys.exit(
            f"Missing CSV files: {missing}\n\n"
            "Export from Google Sheets (File → Download → CSV):\n"
            f"  File 1 tab 'New info teams' → {teams_path}\n"
            f"  File 2 tab 'Data'           → {sessions_path}"
        )
    teams_raw    = pd.read_csv(teams_path, header=0)
    sessions_raw = pd.read_csv(sessions_path, header=0)
    # --csv is a local/dev fallback — one file stands in for every configured term.
    sessions_raw_by_sheet = {key: sessions_raw for key in _unique_session_sheets()}
    return teams_raw, sessions_raw_by_sheet


# ── DATA CLEANING ─────────────────────────────────────────────────────────────

def _col(df, names):
    """
    Return a column by header text — tries each name in `names` in order,
    first match wins. For duplicate headers (e.g. "Data" tab has two columns
    named "Status") the leftmost occurrence is used. Exits with a clear
    error if none of the candidate names exist, instead of silently
    misaligning every field after it.
    """
    for name in names:
        matches = [i for i, c in enumerate(df.columns) if c == name]
        if matches:
            return df.iloc[:, matches[0]]
    sys.exit(
        f"Column not found: tried {names}.\n"
        f"Available columns: {list(df.columns)}\n"
        "The sheet's structure changed — update TEAMS_COL/SESSIONS_COL in process.py."
    )


def clean_teams(raw):
    df = pd.DataFrame({
        "team":       _col(raw, TEAMS_COL["team"]),
        "skello":     _col(raw, TEAMS_COL["skello"]),
        "type":       _col(raw, TEAMS_COL["type"]),
        "coach_id":   _col(raw, TEAMS_COL["coach_id"]),
        "coach_name": _col(raw, TEAMS_COL["coach_name"]),
    })
    df = df.map(lambda x: str(x).strip() if pd.notna(x) else "")
    df["type"] = df["type"].str.strip()
    df = df[df["type"].isin(VALID_ACTIVITIES)].copy()
    df["coach_id"] = pd.to_numeric(df["coach_id"], errors="coerce")
    return df.reset_index(drop=True)


def clean_sessions(raw):
    df = pd.DataFrame({
        "date":       _col(raw, SESSIONS_COL["date"]),
        "session":    _col(raw, SESSIONS_COL["session"]),
        "start":      _col(raw, SESSIONS_COL["start"]),
        "status":     _col(raw, SESSIONS_COL["status"]),
        "coach_id":   _col(raw, SESSIONS_COL["coach_id"]),
        "activity":   _col(raw, SESSIONS_COL["activity"]),
        "coach_name": _col(raw, SESSIONS_COL["coach_name"]),
    })
    df = df.map(lambda x: str(x).strip() if pd.notna(x) else "")

    # Parse date
    df["date"] = pd.to_datetime(df["date"], format="%d/%m/%Y", errors="coerce")
    df = df[df["date"].notna()].copy()

    # Filters
    df = df[df["date"] >= pd.Timestamp(START_DATE)]
    df = df[df["status"] != "No clock in"]
    df = df[df["activity"].isin(VALID_ACTIVITIES)]
    df["day_of_week"] = df["date"].dt.day_name()
    df = df[df["day_of_week"].isin(VALID_DAYS)]

    # Derived fields
    start_parts        = df["start"].str.extract(r"^(\d{1,2}):(\d{2})")
    df["start_hour"]   = pd.to_numeric(start_parts[0], errors="coerce")
    df["start_minute"] = pd.to_numeric(start_parts[1], errors="coerce").fillna(0)
    df["month_key"]    = df["date"].dt.strftime("%Y-%m")
    df["coach_id"]     = pd.to_numeric(df["coach_id"], errors="coerce")

    return df.reset_index(drop=True)


def write_sessions_cache(sessions, term_id):
    """
    Bridge file consumed by enrich-attendance.mjs, so it no longer needs to
    parse data/sessions.csv by hand — works whether `sessions` came from the
    CSV export or the Sheets API. One file per term (`sessions` should already
    be filtered to that term's date range).
    """
    records = []
    for _, row in sessions.iterrows():
        cid = row["coach_id"]
        records.append({
            "date":     row["date"].strftime("%Y-%m-%d"),
            "session":  str(row["session"]),
            "status":   str(row["status"]),
            "coach_id": int(cid) if pd.notna(cid) else None,
            "activity": str(row["activity"]),
        })
    os.makedirs("data", exist_ok=True)
    out = f"data/sessions_cache_{term_id}.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False)
    print(f"Saved → {out} ({len(records)} rows)")


# ── MATCHING ──────────────────────────────────────────────────────────────────

def _normalize(text):
    """Lowercase + strip activity prefix for fuzzy name matching."""
    t = str(text).lower().strip()
    for pfx in ("select ", "academy ", "gk "):
        if t.startswith(pfx):
            t = t[len(pfx):]
    return t


def _parse_slot(text):
    """
    Extract (weekday_name, hour_int, minute_int) from col D suffix.
    Handles 'MO1800', 'SA0930', 'FR1730', etc.
    Returns (None, None, None) if no match.
    """
    t = str(text).upper()
    m = re.search(r'\b(MO|TU|WE|TH|FR|SA)(\d{2})(\d{2})\b', t)
    if m:
        return DAY_MAP.get(m.group(1)), int(m.group(2)), int(m.group(3))
    return None, None, None


def _match_select(session_name, teams):
    candidates = teams[teams["type"] == "Select"]
    sess_norm = _normalize(session_name)

    # 1. Exact Skello name (col E)
    hit = candidates[candidates["skello"].str.lower() == session_name.lower()]
    if not hit.empty:
        return hit.iloc[0]

    # 2. Normalised team name (strip "SELECT " prefix from col D)
    for _, row in candidates.iterrows():
        if _normalize(row["team"]) == sess_norm:
            return row

    # 3. Partial – longest prefix match
    best, best_len = None, 0
    for _, row in candidates.iterrows():
        nt = _normalize(row["team"])
        if sess_norm.startswith(nt) or nt.startswith(sess_norm):
            if len(nt) > best_len:
                best, best_len = row, len(nt)
    return best


def _match_academy_gk(sess_row, teams, activity):
    """
    Match Academy/GK session:
      1. Col E (Skello name) must match session name (col H) — case-insensitive normalized.
      2. Among matches, select the team whose col D slot (e.g. MO1800) matches
         the session's day-of-week + start hour+minute.
    """
    candidates = teams[teams["type"] == activity]
    sess_name_norm = _normalize(sess_row["session"])
    day    = sess_row["day_of_week"]
    hour   = sess_row["start_hour"]
    minute = int(sess_row.get("start_minute", 0) or 0)

    # Step 1 – filter by Skello name
    name_matches = [
        row for _, row in candidates.iterrows()
        if _normalize(row["skello"]) == sess_name_norm
    ]

    if not name_matches:
        return None

    if len(name_matches) == 1:
        return name_matches[0]

    # Step 2 – disambiguate by day + hour + minute from col D
    if pd.isna(hour):
        return name_matches[0]

    sess_hour = int(hour)
    for row in name_matches:
        t_day, t_hour, t_min = _parse_slot(row["team"])
        if t_day == day and t_hour == sess_hour and t_min == minute:
            return row

    # Fallback: match on day + hour only (ignore minute)
    for row in name_matches:
        t_day, t_hour, _ = _parse_slot(row["team"])
        if t_day == day and t_hour == sess_hour:
            return row

    return name_matches[0]


def find_team(sess_row, teams):
    activity = sess_row["activity"]
    if activity == "Select":
        return _match_select(sess_row["session"], teams)
    return _match_academy_gk(sess_row, teams, activity)


# ── RECONCILIATION ────────────────────────────────────────────────────────────

def _session_sort_key(team_name: str):
    """
    Sort key: (venue, day_index, hour, minute, full_base).
    - venue   → keeps all Nexus together, all Perse together, etc.
    - day/time → chronological Mon→Sat, earliest first within each day
    - full_base → tie-breaker when two age-groups share the same slot
    """
    t = str(team_name)
    t_up = t.upper()

    # Extract the slot suffix (MO1800, SA0930, …)
    slot_m = re.search(r'\b(MO|TU|WE|TH|FR|SA)(\d{2})(\d{2})\b', t_up)
    if not slot_m:
        return (t_up, t_up, 99, 0, 0)

    day_idx = DAY_ORDER.get(slot_m.group(1), 99)
    hour    = int(slot_m.group(2))
    minute  = int(slot_m.group(3))

    # Extract venue: word(s) between the type prefix and the year range
    venue_m = re.search(r'^(?:ACADEMY|GK|SELECT)\s+(.+?)\s+\d{4}', t_up)
    venue   = venue_m.group(1).strip() if venue_m else t_up

    # Full base name (without slot) as tie-breaker for same venue+day+time
    base = t[:slot_m.start()].strip().upper()

    return (venue, day_idx, hour, minute, base)

def reconcile(teams, sessions):
    months = sorted(sessions["month_key"].unique())
    month_labels = [datetime.strptime(m, "%Y-%m").strftime("%b %y") for m in months]

    # Build coach-ID → name lookup.
    # Sessions file is the most complete source (every coach who ever worked).
    # Teams file supplements with any remaining entries.
    id_to_name: dict[int, str] = {}
    for _, row in sessions.iterrows():
        cid  = row["coach_id"]
        name = str(row.get("coach_name", "")).strip()
        if pd.notna(cid) and name and name not in ("", "nan"):
            id_to_name[int(cid)] = name
    for _, row in teams.iterrows():
        cid  = row["coach_id"]
        name = row["coach_name"]
        if pd.notna(cid) and name not in ("", "nan", "—", "TBC") and int(cid) not in id_to_name:
            id_to_name[int(cid)] = name

    result = {
        "generated_at": datetime.now().isoformat(),
        "date_range": {
            "from": sessions["date"].min().strftime("%Y-%m-%d") if not sessions.empty else "2026-01-01",
            "to":   sessions["date"].max().strftime("%Y-%m-%d") if not sessions.empty else datetime.now().strftime("%Y-%m-%d"),
        },
        "months":      month_labels,
        "month_keys":  months,
        "categories":  [],
        "unmatched_sessions": [],
    }

    for activity in ("Academy", "Select", "GK"):
        act_sessions = sessions[sessions["activity"] == activity].copy()
        category = {"name": activity, "total": {"assigned": 0, "other": 0}, "match_pct": 0, "sessions": []}

        bucket: dict[str, dict] = {}
        for _, sess in act_sessions.iterrows():
            team = find_team(sess, teams)
            if team is not None:
                key = str(team["team"])
                bucket.setdefault(key, {"team_row": team, "rows": []})["rows"].append(sess)
            else:
                result["unmatched_sessions"].append({
                    "date":      sess["date"].strftime("%Y-%m-%d"),
                    "session":   sess["session"],
                    "activity":  activity,
                    "coach_id":  int(sess["coach_id"]) if pd.notna(sess["coach_id"]) else None,
                })

        for key in sorted(bucket, key=_session_sort_key):
            team     = bucket[key]["team_row"]
            ref_id   = team["coach_id"]
            ref_name = team["coach_name"] if team["coach_name"] not in ("", "nan") else "—"
            rows     = bucket[key]["rows"]

            assigned_count = 0
            other_counts: Counter = Counter()
            month_data   = {m: {"assigned": 0, "other": 0} for m in months}
            discrepancies = []

            for sess in rows:
                month     = sess["month_key"]
                actual_id = sess["coach_id"]
                is_match  = (
                    pd.notna(ref_id) and pd.notna(actual_id)
                    and int(actual_id) == int(ref_id)
                )
                if is_match:
                    assigned_count += 1
                    if month in month_data:
                        month_data[month]["assigned"] += 1
                else:
                    if pd.notna(actual_id):
                        other_counts[int(actual_id)] += 1
                    if month in month_data:
                        month_data[month]["other"] += 1
                    discrepancies.append({
                        "date":            sess["date"].strftime("%Y-%m-%d"),
                        "session":         sess["session"],
                        "start":           sess["start"],
                        "ref_coach_id":    int(ref_id) if pd.notna(ref_id) else None,
                        "actual_coach_id": int(actual_id) if pd.notna(actual_id) else None,
                    })

            total_count = len(rows)
            other_count = total_count - assigned_count
            match_pct   = round(100 * assigned_count / total_count) if total_count > 0 else 0

            top_substitutes = [
                {
                    "coach_id":   cid,
                    "coach_name": id_to_name.get(cid, f"#{cid}"),
                    "count":      cnt,
                    "pct":        round(100 * cnt / total_count) if total_count > 0 else 0,
                }
                for cid, cnt in other_counts.most_common(2)
            ]

            sdata = {
                "team":             str(team["team"]),
                "skello":           str(team["skello"]),
                "ref_coach_id":     int(ref_id) if pd.notna(ref_id) else None,
                "ref_coach_name":   ref_name,
                "match_pct":        match_pct,
                "top_substitutes":  top_substitutes,
                "total":            {"assigned": assigned_count, "other": other_count},
                "months":           month_data,
                "discrepancies":    discrepancies,
            }

            category["total"]["assigned"] += assigned_count
            category["total"]["other"]    += other_count
            category["sessions"].append(sdata)

        cat_total = category["total"]["assigned"] + category["total"]["other"]
        category["match_pct"] = round(100 * category["total"]["assigned"] / cat_total) if cat_total > 0 else 0
        result["categories"].append(category)

    return result


# ── TERM RECONCILIATION ───────────────────────────────────────────────────────

def reconcile_term(teams, sessions, att_lookup, term_start, term_end):
    """
    Session-by-session view for one term (term_start – term_end).
    Returns one week column per 7-day span in the term; each team cell shows
    ✓/✗ per actual session.
    att_lookup: set of (coach_id, "YYYY-MM-DD") where player attendance was submitted.
    """
    from datetime import timedelta

    num_weeks = (term_end - term_start).days // 7 + 1

    # Build week descriptors
    MONTHS_ES = {1:"Ene",2:"Feb",3:"Mar",4:"Abr",5:"May",6:"Jun",
                 7:"Jul",8:"Ago",9:"Sep",10:"Oct",11:"Nov",12:"Dic"}
    weeks = []
    for i in range(num_weeks):
        ws = term_start + timedelta(weeks=i)
        we = ws + timedelta(days=6)
        label = (f"{ws.day} {MONTHS_ES[ws.month]}"
                 if ws.month == we.month
                 else f"{ws.day} {MONTHS_ES[ws.month]}–{we.day} {MONTHS_ES[we.month]}")
        weeks.append({"num": i + 1, "label": f"S{i+1}", "dates": label,
                      "start": ws, "end": we})

    # Build coach id→name lookup from sessions first, then teams
    id_to_name: dict[int, str] = {}
    for _, row in sessions.iterrows():
        cid  = row["coach_id"]
        name = str(row.get("coach_name", "")).strip()
        if pd.notna(cid) and name and name not in ("", "nan"):
            id_to_name[int(cid)] = name
    for _, row in teams.iterrows():
        cid  = row["coach_id"]
        name = row["coach_name"]
        if pd.notna(cid) and name not in ("", "nan", "—", "TBC") and int(cid) not in id_to_name:
            id_to_name[int(cid)] = name

    # Filter sessions to term range
    term_sess = sessions[
        (sessions["date"] >= pd.Timestamp(term_start)) &
        (sessions["date"] <= pd.Timestamp(term_end))
    ].copy()

    result = {
        "generated_at": datetime.now().isoformat(),
        "term":  {"from": term_start.strftime("%Y-%m-%d"),
                  "to":   term_end.strftime("%Y-%m-%d")},
        "weeks": [{"num": w["num"], "label": w["label"], "dates": w["dates"]}
                  for w in weeks],
        "categories":         [],
        "unmatched_sessions": [],
    }

    for activity in ("Academy", "Select", "GK"):
        act_sess = term_sess[term_sess["activity"] == activity].copy()
        category = {"name": activity, "sessions": []}

        bucket: dict[str, dict] = {}
        for _, sess in act_sess.iterrows():
            team = find_team(sess, teams)
            if team is not None:
                key = str(team["team"])
                bucket.setdefault(key, {"team_row": team, "rows": []})["rows"].append(sess)
            else:
                result["unmatched_sessions"].append({
                    "date":     sess["date"].strftime("%Y-%m-%d"),
                    "session":  sess["session"],
                    "activity": activity,
                })

        for key in sorted(bucket, key=_session_sort_key):
            team     = bucket[key]["team_row"]
            ref_id   = team["coach_id"]
            ref_name = team["coach_name"] if team["coach_name"] not in ("", "nan") else "—"
            rows     = bucket[key]["rows"]

            # Group rows by date — one entry per actual session date, not per coach
            date_groups: dict = {}
            for sess in rows:
                date_groups.setdefault(sess["date"], []).append(sess)

            total_sess = len(date_groups)
            ref_id_int = int(ref_id) if pd.notna(ref_id) else None

            # Map each date to week index and day abbreviation
            date_to_week_idx: dict = {}
            date_to_day: dict = {}
            for sess_date, date_rows in date_groups.items():
                sess_dt = sess_date.to_pydatetime()
                date_to_day[sess_date] = DAY_ABBR.get(date_rows[0]["day_of_week"], "?")
                for i, w in enumerate(weeks):
                    if w["start"] <= sess_dt <= w["end"]:
                        date_to_week_idx[sess_date] = i
                        break

            # Per-date: which coaches attended
            date_attendees: dict = {}   # sess_date → set of coach_ids present
            coach_dates: dict[int, set] = {}  # coach_id → set of dates attended
            for sess_date, date_rows in date_groups.items():
                present: set[int] = set()
                for r in date_rows:
                    cid = r["coach_id"]
                    if pd.notna(cid):
                        cid_int = int(cid)
                        present.add(cid_int)
                        coach_dates.setdefault(cid_int, set()).add(sess_date)
                date_attendees[sess_date] = present

            total_assigned = len(coach_dates.get(ref_id_int, set())) if ref_id_int else 0

            # Ordered coach list: ref first, then others by count desc
            other_ids = sorted(
                [c for c in coach_dates if c != ref_id_int],
                key=lambda c: -len(coach_dates[c])
            )
            coach_entries = ([(ref_id_int, True)] if ref_id_int is not None else []) + \
                            [(c, False) for c in other_ids]

            # Aggregate stats per coach (no per-week detail here)
            coaches_summary = []
            for cid_int, is_ref in coach_entries:
                count = len(coach_dates.get(cid_int, set()))
                att_count = sum(
                    1 for d in coach_dates.get(cid_int, set())
                    if att_lookup and (cid_int, d.strftime("%Y-%m-%d")) in att_lookup
                ) if att_lookup else 0
                coaches_summary.append({
                    "coach_id":   cid_int,
                    "coach_name": ref_name if is_ref else id_to_name.get(cid_int, f"#{cid_int}"),
                    "is_ref":     is_ref,
                    "count":      count,
                    "pct":        round(100 * count / total_sess) if total_sess else 0,
                    "att_count":  att_count,
                })

            coach_info = {c["coach_id"]: c for c in coaches_summary}
            all_coach_ids = [e[0] for e in coach_entries]

            # by_week: one item per week in the term, each a list of sessions
            # [{day, coaches}]. Handles teams with 1 or 2 sessions per week naturally.
            by_week: list = [[] for _ in range(num_weeks)]
            for sess_date in sorted(date_groups.keys()):
                week_idx = date_to_week_idx.get(sess_date)
                if week_idx is None:
                    continue
                date_key = sess_date.strftime("%Y-%m-%d")
                present  = date_attendees[sess_date]
                by_week[week_idx].append({
                    "day": date_to_day[sess_date],
                    "coaches": [
                        {
                            "coach_id":   cid_int,
                            "coach_name": coach_info[cid_int]["coach_name"],
                            "is_ref":     coach_info[cid_int]["is_ref"],
                            "attended":   cid_int in present,
                            "att":        bool(
                                att_lookup and cid_int in present
                                and (cid_int, date_key) in att_lookup
                            ),
                        }
                        for cid_int in all_coach_ids
                    ],
                })

            # coaches[] — per-coach weekly presence (required by enrich-attendance.mjs)
            coaches = []
            for cid_int, is_ref in coach_entries:
                c_by_week = []
                for week_sessions in by_week:
                    if not week_sessions:
                        c_by_week.append(None)
                    else:
                        attended = any(
                            c["attended"]
                            for ws in week_sessions
                            for c in ws["coaches"]
                            if c["coach_id"] == cid_int
                        )
                        c_by_week.append(attended)
                coaches.append({
                    "coach_id":   cid_int,
                    "coach_name": ref_name if is_ref else id_to_name.get(cid_int, f"#{cid_int}"),
                    "is_ref":     is_ref,
                    "count":      len(coach_dates.get(cid_int, set())),
                    "by_week":    c_by_week,
                })

            sdata = {
                "team":            str(team["team"]),
                "ref_coach_id":    ref_id_int,
                "ref_coach_name":  ref_name,
                "total_sessions":  total_sess,
                "total_assigned":  total_assigned,
                "coaches_summary": coaches_summary,
                "coaches":         coaches,
                "by_week":         by_week,
            }
            category["sessions"].append(sdata)

        result["categories"].append(category)

    return result


# ── MAIN ──────────────────────────────────────────────────────────────────────

def main():
    use_csv = "--csv" in sys.argv
    print(f"Loading via {'CSV' if use_csv else 'Google Sheets API'} …")

    raw_teams, raw_sessions_by_sheet = load_via_csv() if use_csv else load_via_api()

    print("  Cleaning teams …")
    teams = clean_teams(raw_teams)
    print(f"    {len(teams)} teams (Academy/Select/GK)")

    print("  Cleaning sessions …")
    sessions_by_sheet = {
        key: clean_sessions(raw) for key, raw in raw_sessions_by_sheet.items()
    }
    all_sessions = (
        pd.concat(sessions_by_sheet.values(), ignore_index=True)
        if sessions_by_sheet else pd.DataFrame()
    )
    print(f"    {len(all_sessions)} sessions ≥ {START_DATE:%Y-%m-%d} "
          f"(across {len(sessions_by_sheet)} sheet(s))")

    if all_sessions.empty:
        print("  ⚠  No sessions found. Check the sessions source has data from 2026 onwards.")
        return

    print("Reconciling …")
    result = reconcile(teams, all_sessions)

    total_a = sum(c["total"]["assigned"] for c in result["categories"])
    total_o = sum(c["total"]["other"]    for c in result["categories"])
    total   = total_a + total_o
    rate    = round(100 * total_a / total) if total else 0
    print(f"  {total} sessions → {total_a} assigned  {total_o} other  ({rate}% match)")

    unmatched = result["unmatched_sessions"]
    if unmatched:
        print(f"  ⚠  {len(unmatched)} sessions could not be matched to a team")
        for u in unmatched[:15]:
            print(f"     {u['date']}  {u['activity']:8}  {u['session']}")

    os.makedirs("data", exist_ok=True)
    out = "data/output.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"Saved → {out}")

    # Build name→id and word→cids maps (across every sheet) so the attendance
    # API's coach-name strings resolve to numeric IDs (with fuzzy token-based
    # fallback for name format differences).
    from collections import defaultdict as _dd
    name_to_id: dict[str, int] = {}
    word_to_cids: dict[str, set] = _dd(set)
    for _, row in all_sessions.iterrows():
        cid  = row["coach_id"]
        name = str(row.get("coach_name", "")).strip()
        if pd.notna(cid) and name and name not in ("", "nan"):
            cid_int = int(cid)
            name_to_id[name.upper()] = cid_int
            for w in _sig_tokens(name):
                word_to_cids[w].add(cid_int)

    terms_manifest = []
    for term in TERMS:
        key      = (term["sessions_sheet_id"], term["sessions_gid"])
        sessions = sessions_by_sheet[key]
        term_sess = sessions[
            (sessions["date"] >= pd.Timestamp(term["start"])) &
            (sessions["date"] <= pd.Timestamp(term["end"]))
        ]

        print(f"\nReconciling {term['label']} ({term['start']:%d %b} – {term['end']:%d %b}) …")
        write_sessions_cache(term_sess, term["id"])

        session_dates = set(term_sess["date"].dt.strftime("%Y-%m-%d").unique())
        att_lookup = fetch_attendance_lookup(session_dates, name_to_id, word_to_cids)
        term_result = reconcile_term(teams, sessions, att_lookup, term["start"], term["end"])
        term_result["term"]["att_start"] = term["att_start"]
        term_result["term"]["label"]     = term["label"]

        term_counts = sum(
            s["total_sessions"] for c in term_result["categories"] for s in c["sessions"]
        )
        term_assigned = sum(
            s["total_assigned"] for c in term_result["categories"] for s in c["sessions"]
        )
        term_rate = round(100 * term_assigned / term_counts) if term_counts else 0
        print(f"  {term_counts} sessions → {term_assigned} assigned ({term_rate}% match)")

        out_name = f"term_output_{term['id']}.json"
        with open(f"data/{out_name}", "w", encoding="utf-8") as f:
            json.dump(term_result, f, indent=2, ensure_ascii=False)
        print(f"Saved → data/{out_name}")

        terms_manifest.append({
            "id":    term["id"],
            "label": term["label"],
            "file":  out_name,
            "from":  term["start"].strftime("%Y-%m-%d"),
            "to":    term["end"].strftime("%Y-%m-%d"),
        })

    with open("data/terms_index.json", "w", encoding="utf-8") as f:
        json.dump(terms_manifest, f, indent=2, ensure_ascii=False)
    print(f"Saved → data/terms_index.json ({len(terms_manifest)} terms)")


if __name__ == "__main__":
    main()
