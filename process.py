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
from collections import Counter
from datetime import datetime

try:
    import pandas as pd
except ImportError:
    sys.exit("Missing dependency. Run:  pip install -r requirements.txt")

# ── CONFIGURATION ─────────────────────────────────────────────────────────────

TEAMS_SHEET_ID    = "1COqOZLAQNO437dPZgQpBWsgjreI-FJlbPDfdwHPeDcA"
TEAMS_GID         = 609166241   # tab "New info teams"

SESSIONS_SHEET_ID = "1uGuXupAHufEPX1BnmZmY_r3PbGnHlpVot8i6a6Y2g_g"
SESSIONS_GID      = 0           # tab "Data"

START_DATE        = datetime(2026, 1, 1)
VALID_ACTIVITIES  = {"Academy", "Select", "GK"}
VALID_DAYS        = {"Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"}

# Column positions (0-indexed) in "New info teams" tab
TEAMS_COL = {
    "team":       3,   # D – full name incl. day+time suffix for Academy/GK
    "skello":     4,   # E – Skello session name (matches col H in sessions file)
    "type":       11,  # L  (Academy / Select / GK)
    "coach_id":   27,  # AB
    "coach_name": 28,  # AC
}

# Column positions (0-indexed) in "Data" tab
SESSIONS_COL = {
    "date":      5,    # F  DD/MM/YYYY
    "session":   7,    # H  session/team name (matches col E in teams file)
    "start":     9,    # J  HH:MM start time
    "status":    18,   # S  "No clock in" rows excluded
    "coach_id":  20,   # U
    "activity":  23,   # X  Academy / Select / GK / …
}

# Day-code → Python weekday name (uppercase from col D suffix)
DAY_MAP = {
    "MO": "Monday", "TU": "Tuesday", "WE": "Wednesday",
    "TH": "Thursday", "FR": "Friday", "SA": "Saturday",
}


# ── DATA LOADING ──────────────────────────────────────────────────────────────

def _sheet_to_df(gc, sheet_id, gid):
    sh = gc.open_by_key(sheet_id)
    ws = sh.get_worksheet_by_id(gid)
    records = ws.get_all_values()
    if len(records) < 2:
        return pd.DataFrame()
    return pd.DataFrame(records[1:], columns=records[0])


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

    print("  Fetching sessions sheet …")
    sessions_raw = _sheet_to_df(gc, SESSIONS_SHEET_ID, SESSIONS_GID)

    return teams_raw, sessions_raw


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
    return pd.read_csv(teams_path, header=0), pd.read_csv(sessions_path, header=0)


# ── DATA CLEANING ─────────────────────────────────────────────────────────────

def _col(df, pos):
    """Return column by zero-based position, or empty series if out of range."""
    return df.iloc[:, pos] if pos < len(df.columns) else pd.Series([""] * len(df))


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
        "date":      _col(raw, SESSIONS_COL["date"]),
        "session":   _col(raw, SESSIONS_COL["session"]),
        "start":     _col(raw, SESSIONS_COL["start"]),
        "status":    _col(raw, SESSIONS_COL["status"]),
        "coach_id":  _col(raw, SESSIONS_COL["coach_id"]),
        "activity":  _col(raw, SESSIONS_COL["activity"]),
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

def reconcile(teams, sessions):
    months = sorted(sessions["month_key"].unique())
    month_labels = [datetime.strptime(m, "%Y-%m").strftime("%b %y") for m in months]

    # Build coach-ID → name lookup from the teams file
    id_to_name: dict[int, str] = {}
    for _, row in teams.iterrows():
        cid  = row["coach_id"]
        name = row["coach_name"]
        if pd.notna(cid) and name not in ("", "nan", "—", "TBC"):
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

        for key in sorted(bucket):
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


# ── MAIN ──────────────────────────────────────────────────────────────────────

def main():
    use_csv = "--csv" in sys.argv
    print(f"Loading via {'CSV' if use_csv else 'Google Sheets API'} …")

    raw_teams, raw_sessions = load_via_csv() if use_csv else load_via_api()

    print("  Cleaning teams …")
    teams = clean_teams(raw_teams)
    print(f"    {len(teams)} teams (Academy/Select/GK)")

    print("  Cleaning sessions …")
    sessions = clean_sessions(raw_sessions)
    print(f"    {len(sessions)} sessions ≥ {START_DATE:%Y-%m-%d}")

    if sessions.empty:
        print("  ⚠  No sessions found. Check the sessions CSV has data from 2026 onwards.")
        return

    print("Reconciling …")
    result = reconcile(teams, sessions)

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


if __name__ == "__main__":
    main()
