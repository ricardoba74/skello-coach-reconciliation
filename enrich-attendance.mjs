/**
 * Enriches every term listed in data/terms_index.json with player-attendance
 * data from the Barca Academy API. For each term's term_output_<id>.json,
 * adds to each coach entry:
 *   att_by_week[]    — week-level att flag (used by Sessions tab)
 *   att_count        — total att weeks
 *   by_date[]        — per-day presence, indexed against data.dates[]
 *   att_by_date[]    — per-day att flag, indexed against data.dates[]
 *
 * Adds to the root JSON:
 *   dates[]          — sorted list of all unique session dates in the term
 *   coaches[]        — inverted structure: one entry per coach with all their sessions
 *
 * For Academy/GK sessions: dates are derived from the day code in the team name
 *   (e.g. "MO1800" → every Monday of the term).
 * For Select sessions: actual dates and per-coach presence are read from
 *   data/sessions_cache_<id>.json (bridge file written by process.py from the
 *   same source — CSV or Sheets API), which has both training days per
 *   week instead of only one.
 *
 * Usage: node enrich-attendance.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const envPath = join(__dir, '.env');
  if (!process.env.BARCA_ATTENDANCE_TOKEN && existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^BARCA_ATTENDANCE_TOKEN\s*=\s*(.+)$/);
      if (m) process.env.BARCA_ATTENDANCE_TOKEN = m[1].trim().replace(/^["']|["']$/g, '');
    }
  }
}

loadEnv();

const TOKEN = process.env.BARCA_ATTENDANCE_TOKEN || '';
const API   = 'https://attendance.barcaacademy.sg/api/attendance/logs';

if (!TOKEN) {
  console.warn('⚠  BARCA_ATTENDANCE_TOKEN no configurado (.env) — se omite asistencia de jugadores.');
}

const norm = s => (s || '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();

function utcDayOfWeek(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getUTCDay(); // 0=Sun
}

async function enrichTerm(termEntry) {
  const FILE           = `data/${termEntry.file}`;
  const SESSIONS_CACHE = `data/sessions_cache_${termEntry.id}.json`;

  console.log(`\n── ${termEntry.label} ──`);

  const data      = JSON.parse(readFileSync(FILE, 'utf8'));
  const termStart = new Date(data.term.from + 'T00:00:00Z');
  const todayStr  = new Date().toISOString().slice(0, 10);
  const T_FROM    = data.term.from;
  const T_TO      = data.term.to;
  const numWeeks  = data.weeks.length;

  // ── Parse sessions_cache_<id>.json for actual Select session dates ──────────
  // selectPresence : Map<TEAM_UPPER, Map<dateStr, Set<coachId>>>
  // selectAllDates : Map<TEAM_UPPER, Set<dateStr>>
  const selectPresence = new Map();
  const selectAllDates = new Map();

  try {
    const cacheRows = JSON.parse(readFileSync(SESSIONS_CACHE, 'utf8'));
    let selectRows = 0;
    for (const row of cacheRows) {
      if (row.activity !== 'Select') continue;
      const dateStr = row.date;
      if (!dateStr || dateStr < T_FROM || dateStr > T_TO) continue;
      if (utcDayOfWeek(dateStr) === 0) continue; // exclude Sundays (matches process.py filter)
      if (row.status === 'No clock in') continue; // same status filter

      const teamKey = (row.session || '').trim().toUpperCase();
      const coachId = row.coach_id;

      if (!selectPresence.has(teamKey)) {
        selectPresence.set(teamKey, new Map());
        selectAllDates.set(teamKey, new Set());
      }
      if (!selectPresence.get(teamKey).has(dateStr)) {
        selectPresence.get(teamKey).set(dateStr, new Set());
      }
      if (coachId !== null && coachId !== undefined) {
        selectPresence.get(teamKey).get(dateStr).add(coachId);
      }
      selectAllDates.get(teamKey).add(dateStr);
      selectRows++;
    }
    console.log(`  ${SESSIONS_CACHE} loaded: ${selectRows} Select rows → ${selectPresence.size} teams`);
  } catch (e) {
    console.warn(`  ⚠  Could not read ${SESSIONS_CACHE}: ${e.message}`);
    console.warn('     Select sessions will fall back to Saturday-only dates.');
  }

  // ── Build name → coach_id lookup from JSON ───────────────────────────────────
  const nameToId = new Map();
  for (const cat of data.categories) {
    for (const sess of cat.sessions) {
      for (const coach of sess.coaches || []) {
        if (coach.coach_id && coach.coach_name) {
          nameToId.set(norm(coach.coach_name), coach.coach_id);
        }
      }
    }
  }
  console.log(`  Coach name→ID map: ${nameToId.size} entries`);

  function resolveCoachId(apiName) {
    const n = norm(apiName);
    if (nameToId.has(n)) return nameToId.get(n);
    for (const [known, id] of nameToId) {
      if (known.includes(n) || n.includes(known)) return id;
    }
    return null;
  }

  // ── Day-of-week offset from session name (Academy/GK only) ──────────────────
  const DAY_OFFSETS = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };

  function parseDayOffset(teamName) {
    const m = teamName.match(/\b(MO|TU|WE|TH|FR|SA|SU)\d{4}\b/);
    return m ? DAY_OFFSETS[m[1]] : null; // null = no day code (Select)
  }

  function dateForWeek(wIdx, dayOffset) {
    const d = new Date(termStart);
    d.setUTCDate(d.getUTCDate() + wIdx * 7 + dayOffset);
    return d.toISOString().slice(0, 10);
  }

  // ── Collect all unique session dates ─────────────────────────────────────────
  const allDatesSet = new Set();

  for (const cat of data.categories) {
    for (const sess of cat.sessions) {
      const dayOffset = parseDayOffset(sess.team);

      if (dayOffset !== null) {
        // Academy / GK: derive dates from day code + by_week
        const refByWeek = sess.coaches?.[0]?.by_week || [];
        refByWeek.forEach((val, wIdx) => {
          if (val !== null && val !== undefined) {
            const ds = dateForWeek(wIdx, dayOffset);
            if (ds <= todayStr) allDatesSet.add(ds);
          }
        });
      } else {
        // Select: use actual dates from sessions_cache_<id>.json
        const key = sess.team.toUpperCase();
        const selDates = selectAllDates.get(key);
        if (selDates) {
          selDates.forEach(ds => { if (ds <= todayStr) allDatesSet.add(ds); });
        } else {
          // Cache not available → fall back to Saturday per active week
          const refByWeek = sess.coaches?.[0]?.by_week || [];
          refByWeek.forEach((val, wIdx) => {
            if (val !== null && val !== undefined) {
              const ds = dateForWeek(wIdx, 5); // Saturday fallback
              if (ds <= todayStr) allDatesSet.add(ds);
            }
          });
        }
      }
    }
  }

  const dates = [...allDatesSet].sort();

  if (!dates.length) {
    console.log('  No hay fechas de sesión todavía para este term — se omite la asistencia.');
    data.dates        = [];
    data.coaches       = [];
    data.generated_at  = new Date().toISOString();
    writeFileSync(FILE, JSON.stringify(data, null, 2));
    return;
  }
  console.log(`  Unique session dates: ${dates.length} (${dates[0]} → ${dates[dates.length - 1]})`);

  // ── Collect which weeks have sessions (for API fetching) ─────────────────────
  const weeksWithSessions = new Set();
  for (const cat of data.categories) {
    for (const sess of cat.sessions) {
      for (const coach of sess.coaches || []) {
        (coach.by_week || []).forEach((val, i) => {
          if (val !== null && val !== undefined) weeksWithSessions.add(i);
        });
      }
    }
  }
  console.log(`  Weeks with sessions: ${[...weeksWithSessions].sort((a,b)=>a-b).map(i=>`S${i+1}`).join(', ')}`);

  // ── Fetch attendance from API, day by day ────────────────────────────────────
  const attLookup       = new Map(); // coach_id → Set<week_idx>
  const attLookupByDate = new Map(); // coach_id → Set<dateStr>
  const unknownNames    = new Set();

  if (TOKEN) {
    for (const wIdx of [...weeksWithSessions].sort((a, b) => a - b)) {
      const weekStart = new Date(termStart);
      weekStart.setUTCDate(weekStart.getUTCDate() + wIdx * 7);
      process.stdout.write(`  S${wIdx + 1} (${weekStart.toISOString().slice(0,10)}): `);

      for (let d = 0; d < 7; d++) {
        const day = new Date(weekStart);
        day.setUTCDate(weekStart.getUTCDate() + d);
        const dateStr = day.toISOString().slice(0, 10);
        if (dateStr > todayStr) continue;

        let page = 1;
        while (true) {
          const url = `${API}?from=${dateStr}&to=${dateStr}&page=${page}`;
          let body;
          try {
            const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
            if (!res.ok) break;
            body = await res.json();
          } catch (e) {
            process.stderr.write(`  API error ${dateStr}: ${e.message}\n`);
            break;
          }

          const sessions = Array.isArray(body) ? body : (body.logs || body.data || []);
          if (!sessions.length) break;

          for (const s of sessions) {
            const players = s.logs || s.players || [];
            if (!s.coach || !players.length) continue;

            const cid = resolveCoachId(s.coach);
            if (cid) {
              if (!attLookup.has(cid))       attLookup.set(cid, new Set());
              attLookup.get(cid).add(wIdx);
              if (!attLookupByDate.has(cid)) attLookupByDate.set(cid, new Set());
              attLookupByDate.get(cid).add(dateStr);
            } else {
              unknownNames.add(s.coach);
            }
          }

          const totalPages = (typeof body === 'object' && body.pages) ? body.pages : 1;
          if (page >= totalPages) break;
          page++;
        }
      }
      process.stdout.write('done\n');
    }
  }

  console.log(`  Attendance found: ${attLookup.size} coaches with player submissions`);
  if (unknownNames.size) {
    console.log(`  Unmatched coach names (${unknownNames.size}):`);
    for (const n of [...unknownNames].sort()) console.log(`    "${n}"`);
  }

  // ── Enrich each coach entry ───────────────────────────────────────────────────
  let enriched = 0;
  for (const cat of data.categories) {
    for (const sess of cat.sessions) {
      const dayOffset    = parseDayOffset(sess.team);        // null for Select
      const isSelect     = dayOffset === null;
      const selectKey    = sess.team.toUpperCase();
      const teamPresence = isSelect ? (selectPresence.get(selectKey) || null) : null;

      for (const coach of sess.coaches || []) {
        const coachWeeks = attLookup.get(coach.coach_id)       || new Set();
        const coachDates = attLookupByDate.get(coach.coach_id) || new Set();

        // ── att_by_week (week-level — used by Sessions tab) ──────────────────
        const attByWeek = (coach.by_week || []).map((val, i) => {
          if (val === null || val === undefined) return null;
          if (!val) return null;
          return coachWeeks.has(i);
        });
        coach.att_by_week = attByWeek;
        coach.att_count   = attByWeek.filter(v => v === true).length;

        // ── by_date / att_by_date (day-level — used by Coaches tab) ─────────
        const by_date     = [];
        const att_by_date = [];

        if (isSelect) {
          // Select: presence data comes directly from sessions_cache_<id>.json
          for (const dateStr of dates) {
            if (!teamPresence || !teamPresence.has(dateStr)) {
              by_date.push(null);
              att_by_date.push(null);
            } else {
              const coachPresent = teamPresence.get(dateStr).has(coach.coach_id);
              by_date.push(coachPresent);
              att_by_date.push(coachPresent ? coachDates.has(dateStr) : null);
            }
          }
        } else {
          // Academy / GK: derive presence from by_week + day offset
          for (const dateStr of dates) {
            const dateObj         = new Date(dateStr + 'T00:00:00Z');
            const diffDays        = Math.round((dateObj - termStart) / 86400000);
            const wIdx            = Math.floor(diffDays / 7);
            const dayOfWeekInTerm = diffDays % 7; // 0=Mon … 5=Sat … 6=Sun

            if (dayOfWeekInTerm !== dayOffset || wIdx < 0 || wIdx >= numWeeks) {
              by_date.push(null);
              att_by_date.push(null);
              continue;
            }

            const weekVal = (coach.by_week || [])[wIdx];
            if (weekVal === null || weekVal === undefined) {
              by_date.push(null);
              att_by_date.push(null);
              continue;
            }

            by_date.push(weekVal);
            att_by_date.push(weekVal ? coachDates.has(dateStr) : null);
          }
        }

        coach.by_date     = by_date;
        coach.att_by_date = att_by_date;
        enriched++;
      }
    }
  }

  // ── Build top-level coaches section ──────────────────────────────────────────
  const coachesMap = new Map();
  for (const cat of data.categories) {
    for (const sess of cat.sessions) {
      for (const coach of sess.coaches || []) {
        if (!coachesMap.has(coach.coach_id)) {
          coachesMap.set(coach.coach_id, {
            coach_id:   coach.coach_id,
            coach_name: coach.coach_name,
            sessions:   [],
          });
        }
        coachesMap.get(coach.coach_id).sessions.push({
          team:            sess.team,
          category:        cat.name,
          total_sessions:  sess.total_sessions,
          is_ref:          coach.is_ref,
          count:           coach.count,
          att_count:       coach.att_count,
          att_count_date:  (coach.att_by_date || []).filter(v => v === true).length,
          by_date:         coach.by_date,
          att_by_date:     coach.att_by_date,
        });
      }
    }
  }

  data.dates        = dates;
  data.coaches      = [...coachesMap.values()].sort((a, b) => a.coach_name.localeCompare(b.coach_name));
  data.generated_at = new Date().toISOString();

  writeFileSync(FILE, JSON.stringify(data, null, 2));
  console.log(`  ✅ Enriched ${enriched} coach entries → ${FILE}`);
  console.log(`  ✅ ${dates.length} dates | ${coachesMap.size} coaches in root`);
}

// ── Main: enrich every term listed in data/terms_index.json ─────────────────
const terms = JSON.parse(readFileSync('data/terms_index.json', 'utf8'));
for (const term of terms) {
  await enrichTerm(term);
}
