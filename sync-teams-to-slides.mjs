#!/usr/bin/env node
/**
 * sync-teams-to-slides.mjs
 * Sincroniza Teams (Google Sheet "Barça Academy Data Base") -> PowerPoint de
 * planning semanal por sede. Lee data/slides-grid-map.json (generado por
 * inspect-slides-grid.mjs) y reescribe únicamente las celdas de equipos,
 * preservando cabeceras, horarios y bloques de Goalkeeper Training.
 *
 * Modo por defecto: --dry-run (solo imprime el diff, no escribe nada).
 * Solo escribe de verdad con --apply explícito.
 *
 * Pre-flight: si algún tableObjectId del mapeo ya no existe en el PowerPoint,
 * aborta sin escribir nada — así una ejecución desatendida (cron) nunca
 * escribe sobre un shape equivocado.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createSign } from 'crypto';

const __dir = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');

const DB_SHEET_ID = '1-kztBuXshBnBptDWt5pdwWaT-dCUIWEHPHUG5gttbis';
const TEAMS_TAB = 'Teams';

// Sheet usa "SJI"/"St Pats"/"Nexus"/"Perse"; el mapeo de slides usa "SJII"/"St Patricks".
const VENUE_ALIAS = { nexus: 'Nexus', sji: 'SJII', sjii: 'SJII', 'st patricks': 'St Patricks', 'st pats': 'St Patricks', perse: 'Perse' };
const DAY3_TO_FULL = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' };

// ── Auth (mismo patrón que fetch-coaches.mjs / inspect-slides-grid.mjs) ──────
function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getGoogleAccessToken(credsPath, scope) {
  const creds = JSON.parse(readFileSync(credsPath, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.` +
    base64url(JSON.stringify({ iss: creds.client_email, scope, aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now }));
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const jwt = `${unsigned}.${base64url(signer.sign(creds.private_key))}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!res.ok) throw new Error(`Google OAuth error (${res.status}): ${await res.text()}`);
  return (await res.json()).access_token;
}

async function sheetsGet(token, spreadsheetId, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets API error (${res.status}): ${await res.text()}`);
  return (await res.json()).values || [];
}

async function slidesGet(token, presentationId, fields) {
  const url = `https://slides.googleapis.com/v1/presentations/${presentationId}?fields=${encodeURIComponent(fields)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Slides API error (${res.status}): ${await res.text()}`);
  return res.json();
}

async function slidesBatchUpdate(token, presentationId, requests) {
  const url = `https://slides.googleapis.com/v1/presentations/${presentationId}:batchUpdate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`Slides batchUpdate error (${res.status}): ${await res.text()}`);
  return res.json();
}

// ── Parseo de Slot "Nexus Mon 1800" ──────────────────────────────────────────
function parseSlot(slot) {
  const m = slot.trim().match(/^(Nexus|SJI|SJII|St Patricks|St Pats|Perse)\s+(Mon|Tue|Wed|Thu|Fri|Sat)\s+(\d{3,4})$/i);
  if (!m) return null;
  const venue = VENUE_ALIAS[m[1].toLowerCase()];
  const day = DAY3_TO_FULL[m[2].toLowerCase()];
  const time = m[3].padStart(4, '0');
  if (!venue || !day) return null;
  return { venue, day, time };
}

function isSoonPlaceholder(teamLine) {
  return /-?\s*soon\s*-?/i.test(teamLine);
}
function baseTeamName(teamLine) {
  return teamLine.replace(/\s*-?\s*soon\s*-?\s*$/i, '').trim();
}

function cellText(cell) {
  const runs = [];
  for (const te of cell?.text?.textElements || []) if (te.textRun) runs.push(te.textRun.content);
  return runs.join('');
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Modo: ${APPLY ? 'APPLY (escribe de verdad)' : 'DRY-RUN (solo diff, no escribe nada)'}`);

  const mapPath = join(__dir, 'data', 'slides-grid-map.json');
  if (!existsSync(mapPath)) {
    console.error(`❌  No existe ${mapPath}. Ejecuta antes: node inspect-slides-grid.mjs`);
    process.exit(1);
  }
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));

  const credsPath = join(__dir, 'credentials.json');
  const sheetsToken = await getGoogleAccessToken(credsPath, 'https://www.googleapis.com/auth/spreadsheets.readonly');
  const slidesToken = await getGoogleAccessToken(credsPath, 'https://www.googleapis.com/auth/presentations');

  // ── Pre-flight: confirmar que las 4 tablas y sus celdas siguen existiendo ──
  const liveFields = 'slides(objectId,pageElements(objectId,table))';
  const live = await slidesGet(slidesToken, map.presentationId, liveFields);

  const liveTables = {};
  for (const [venue, vmap] of Object.entries(map.venues)) {
    const slide = live.slides[vmap.slideIdx];
    const tableEl = slide?.pageElements?.find(el => el.objectId === vmap.tableObjectId);
    if (!tableEl) {
      console.error(`❌  PRE-FLIGHT FALLIDO: la tabla de "${venue}" (objectId ${vmap.tableObjectId}) ya no existe en slide idx ${vmap.slideIdx}.`);
      console.error('    Abortando sin escribir nada. Vuelve a ejecutar inspect-slides-grid.mjs y revisa el mapeo.');
      process.exit(1);
    }
    liveTables[venue] = tableEl.table;
  }
  console.log('✅  Pre-flight OK: las 4 tablas existen tal como las recuerda el mapeo.\n');

  // ── Leer Teams y agrupar por (venue, day-o-Saturday, time) ──────────────────
  const rows = await sheetsGet(sheetsToken, DB_SHEET_ID, `'${TEAMS_TAB}'`);
  const header = rows[0];
  const teamIdx = header.indexOf('TEAM');
  const slotIdxs = ['Slot 1', 'Slot 2', 'Slot 3'].map(h => header.indexOf(h)).filter(i => i >= 0);

  const grouped = {}; // `${venue}|${day}|${time}` -> Set<teamName>
  const unmatched = [];

  for (const row of rows.slice(1)) {
    const team = (row[teamIdx] || '').trim();
    if (!team) continue;
    // Este PowerPoint es Select/Sports Dev/GK — Academy tiene su propia plantilla.
    if (/^ACADEMY\s/i.test(team)) continue;
    for (const si of slotIdxs) {
      const slot = (row[si] || '').trim();
      if (!slot) continue;
      const parsed = parseSlot(slot);
      if (!parsed) { unmatched.push({ team, slot, reason: 'formato de slot no reconocido' }); continue; }
      const key = `${parsed.venue}|${parsed.day}|${parsed.time}`;
      (grouped[key] = grouped[key] || new Set()).add(team);
    }
  }

  // ── Construir texto deseado por celda y comparar contra el actual ──────────
  const cellUpdates = []; // { venue, row, col, currentText, desiredText }
  const stillUnmatched = [];

  function resolveDesiredForSegment(venue, day, seg) {
    const key = `${venue}|${day}|${seg.time}`;
    const matched = grouped[key] ? [...grouped[key]] : [];
    const matchedBase = new Set(matched.map(t => t.toLowerCase()));
    const preservedSoon = seg.teams
      .filter(isSoonPlaceholder)
      .filter(t => !matchedBase.has(baseTeamName(t).toLowerCase()));
    const all = [...new Set([...matched, ...preservedSoon])];
    // GK siempre al final de la celda, el resto alfabético.
    const isGK = t => /^GK\s/i.test(t);
    const rest = all.filter(t => !isGK(t)).sort((a, b) => a.localeCompare(b));
    const gk = all.filter(isGK).sort((a, b) => a.localeCompare(b));
    return { rest, gk };
  }

  // Une equipos "normales" y GK con una línea en blanco de separación cuando
  // ambos grupos existen. Los bloques de "Goalkeeper Training" (texto libre,
  // no datos de Teams) ya no se preservan — se descartan.
  function buildTeamsText(rest, gk) {
    const blocks = [];
    if (rest.length) blocks.push(rest.join('\n'));
    if (gk.length) blocks.push(gk.join('\n'));
    return blocks.join('\n\n');
  }

  /** Devuelve { text, gkRanges } — gkRanges son rangos [start,end) del texto
   *  final que corresponden a líneas de equipos GK, para pintarlos en amarillo. */
  function renderCellWithStyle(venue, day, segments) {
    const segResults = [];
    for (const seg of segments) {
      if (seg.type === 'gk') continue; // descartado, no es dato de Teams
      const { rest, gk } = resolveDesiredForSegment(venue, day, seg);
      if (!rest.length && !gk.length) continue; // sin equipos -> se omite (incl. excepciones horarias huérfanas)
      const teamsText = buildTeamsText(rest, gk);
      const segText = seg.inline ? `${seg.label}\n${teamsText}` : teamsText;
      const gkJoined = gk.length ? gk.join('\n') : '';
      segResults.push({ segText, gkLocalStart: gk.length ? segText.length - gkJoined.length : null, gkLen: gkJoined.length });
    }
    let text = '';
    const gkRanges = [];
    for (const sr of segResults) {
      if (text.length) text += '\n\n';
      const base = text.length;
      text += sr.segText;
      if (sr.gkLocalStart !== null) gkRanges.push([base + sr.gkLocalStart, base + sr.gkLocalStart + sr.gkLen]);
    }
    return { text, gkRanges };
  }

  for (const [venue, vmap] of Object.entries(map.venues)) {
    const liveTable = liveTables[venue];
    for (const [day, entries] of Object.entries(vmap.days)) {
      for (const entry of entries) {
        const { text: desired, gkRanges } = renderCellWithStyle(venue, day, entry.segments);
        const current = cellText(liveTable.tableRows[entry.row].tableCells[entry.col]);
        if (desired.trim() !== current.trim()) {
          cellUpdates.push({ venue, day, row: entry.row, col: entry.col, current, desired, gkRanges, tableObjectId: vmap.tableObjectId });
        }
      }
    }
    for (const sat of vmap.saturday) {
      const { text: desired, gkRanges } = renderCellWithStyle(venue, 'Saturday', sat.segments);
      const current = cellText(liveTable.tableRows[sat.row].tableCells[sat.col]);
      if (desired.trim() !== current.trim()) {
        cellUpdates.push({ venue, day: `Saturday (${sat.label})`, row: sat.row, col: sat.col, current, desired, gkRanges, tableObjectId: vmap.tableObjectId });
      }
    }
  }

  // Slots que no matchearon NINGÚN segmento conocido (venue/día/hora no existe en el mapeo):
  // recorremos qué claves `grouped` (venue|day|time construidas desde Teams) fueron realmente
  // consumidas por algún segmento del mapeo; lo que sobra son combinaciones sin celda destino.
  const consumedKeys = new Set();
  for (const [venue, vmap] of Object.entries(map.venues)) {
    for (const [day, entries] of Object.entries(vmap.days)) for (const entry of entries) for (const seg of entry.segments) if (seg.time) consumedKeys.add(`${venue}|${day}|${seg.time}`);
    for (const sat of vmap.saturday) for (const seg of sat.segments) if (seg.time) consumedKeys.add(`${venue}|Saturday|${seg.time}`);
  }
  for (const key of Object.keys(grouped)) {
    if (!consumedKeys.has(key)) stillUnmatched.push({ key, teams: [...grouped[key]] });
  }

  // ── Reporte ──────────────────────────────────────────────────────────────
  console.log(`Celdas con cambios: ${cellUpdates.length}`);
  for (const u of cellUpdates) {
    console.log(`\n[${u.venue} / ${u.day}, fila ${u.row} col ${u.col}]`);
    console.log('  ANTES:', JSON.stringify(u.current));
    console.log('  DESPUÉS:', JSON.stringify(u.desired));
  }

  if (unmatched.length) {
    console.log(`\n⚠️  ${unmatched.length} filas de Teams con Slot en formato no reconocido:`);
    for (const u of unmatched.slice(0, 20)) console.log(`   ${u.team} | ${u.slot}`);
  }
  if (stillUnmatched.length) {
    console.log(`\n⚠️  ${stillUnmatched.length} combinaciones venue/día/hora de Teams sin celda conocida en el PowerPoint (necesitan añadirse a mano en el deck + re-ejecutar inspect-slides-grid.mjs):`);
    for (const u of stillUnmatched) console.log(`   ${u.key} -> ${u.teams.join(', ')}`);
  }

  if (!cellUpdates.length) { console.log('\nNada que sincronizar.'); return; }

  if (!APPLY) {
    console.log(`\n${cellUpdates.length} celdas cambiarían. Ejecuta con --apply para escribir de verdad.`);
    return;
  }

  // ── Escritura: deleteText + insertText + color por celda, agrupado por sede ──
  const WHITE = { red: 1, green: 1, blue: 1 };
  const YELLOW = { red: 1, green: 1, blue: 0 };

  function colorRequest(objectId, cellLocation, startIndex, endIndex, rgbColor) {
    return {
      updateTextStyle: {
        objectId, cellLocation,
        textRange: { type: 'FIXED_RANGE', startIndex, endIndex },
        style: { foregroundColor: { opaqueColor: { rgbColor } } },
        fields: 'foregroundColor',
      },
    };
  }

  const byVenue = {};
  for (const u of cellUpdates) (byVenue[u.venue] = byVenue[u.venue] || []).push(u);

  for (const [venue, updates] of Object.entries(byVenue)) {
    const requests = [];
    for (const u of updates) {
      const cellLocation = { rowIndex: u.row, columnIndex: u.col };
      requests.push({ deleteText: { objectId: u.tableObjectId, cellLocation, textRange: { type: 'ALL' } } });
      if (u.desired) {
        requests.push({ insertText: { objectId: u.tableObjectId, cellLocation, insertionIndex: 0, text: u.desired } });
        // Blanco para todo el texto, luego amarillo por encima solo en los tramos GK.
        requests.push(colorRequest(u.tableObjectId, cellLocation, 0, u.desired.length, WHITE));
        for (const [start, end] of u.gkRanges) {
          requests.push(colorRequest(u.tableObjectId, cellLocation, start, end, YELLOW));
        }
      }
    }
    await slidesBatchUpdate(slidesToken, map.presentationId, requests);
    console.log(`✅  ${venue}: ${updates.length} celdas escritas`);
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
