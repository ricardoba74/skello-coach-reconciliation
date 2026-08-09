#!/usr/bin/env node
/**
 * inspect-slides-grid.mjs
 * Herramienta de desarrollo — uso puntual, no forma parte del pipeline diario.
 *
 * Lee las 4 diapositivas-cuadrícula (Nexus/St Patricks/SJII/Perse) del PowerPoint
 * de planning semanal y genera data/slides-grid-map.json: para cada celda de
 * equipos (día/hora entre semana o slot de sábado), qué "segmentos" contiene
 * (bloque principal por horario de fila, excepciones de horario incrustadas
 * tipo "7:00 - 8:30 pm" dentro de la misma celda, y bloques de Goalkeeper
 * Training que se preservan verbatim y nunca se tocan desde el sync).
 *
 * Cada tabla tiene siempre esta forma de filas:
 *   0 = cabecera días (o "SATURDAY" en la sección de sábado)
 *   1 = horario bloque 1 (por columna/día)
 *   2 = equipos bloque 1
 *   3 = horario bloque 2
 *   4 = equipos bloque 2
 *   5 = "SATURDAY"
 *   6 = horarios de sábado (una sub-columna por franja, no por día)
 *   7 = equipos de sábado
 *
 * Requiere: credentials.json en la raíz del proyecto, con el fichero de
 * PowerPoint ya compartido como Editor con esa cuenta de servicio y la API de
 * Google Slides habilitada en su proyecto de GCP.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createSign } from 'crypto';

const __dir = dirname(fileURLToPath(import.meta.url));

const PRESENTATION_ID = '1wYL01YWe-tcI-NgbVVITpCH_RbSH7g-Cf8wHi7CgO24';
const VENUE_SLIDE_IDX = { Nexus: 19, 'St Patricks': 21, SJII: 23, Perse: 25 };
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

// ── Auth (mismo patrón hand-rolled que fetch-coaches.mjs, sin deps npm) ──────
function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getGoogleAccessToken(credsPath, scope) {
  const creds = JSON.parse(readFileSync(credsPath, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.` +
    base64url(JSON.stringify({
      iss: creds.client_email, scope,
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600, iat: now,
    }));
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

// ── Helpers de parseo ─────────────────────────────────────────────────────────
const TIME_RANGE_RE = /^\d{1,2}[.:\-]\d{2}\s*-\s*\d{1,2}[.:\-]\d{2}\s*(am|pm)?$/i;
const REPORT_RE = /^report at[:]?/i;
const GK_RE = /^goalkeeper training/i;
const YEAR_LIST_RE = /^\d{4}(\s*,\s*\d{4})*\s*$/;

function parseStartTime(label) {
  const m = label.match(/(\d{1,2})[.:\-](\d{2})\s*-\s*(\d{1,2})[.:\-](\d{2})\s*(am|pm)?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = (m[5] || '').toLowerCase();
  if (ampm === 'pm' && h !== 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  if (!ampm && h < 8) h += 12; // heurística: horas sin am/pm explícito son de tarde/noche en este contexto
  return `${String(h).padStart(2, '0')}${min}`;
}

function cellText(cell) {
  const runs = [];
  for (const te of cell?.text?.textElements || []) {
    if (te.textRun) runs.push(te.textRun.content);
  }
  return runs.join('');
}

/** Divide el texto crudo de una celda de equipos en segmentos: bloque principal
 *  y excepciones de horario incrustadas. Los bloques "Goalkeeper Training"
 *  (texto libre con años, no equipos reales de Teams) se descartan por completo
 *  — el equipo "GK ..." real, si existe, ya llega vía Teams como cualquier otro. */
function parseTeamCell(rawText, blockTime, blockLabel) {
  const lines = rawText.split('\n').map(l => l.trim());
  const segments = [{ time: blockTime, label: blockLabel, inline: false, teams: [] }];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line) { i++; continue; }
    if (GK_RE.test(line)) {
      i++;
      while (i < lines.length && (YEAR_LIST_RE.test(lines[i]) || !lines[i])) i++;
      continue;
    }
    if (TIME_RANGE_RE.test(line)) {
      const t = parseStartTime(line);
      segments.push({ time: t, label: line, inline: true, teams: [] });
      i++;
      continue;
    }
    // línea de equipo -> va al último segmento de tipo "teams" abierto
    const target = [...segments].reverse().find(s => s.teams !== undefined);
    target.teams.push(line);
    i++;
  }
  return segments.filter(s => s.teams.length > 0 || s === segments[0]);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const credsPath = join(__dir, 'credentials.json');
  const token = await getGoogleAccessToken(credsPath, 'https://www.googleapis.com/auth/presentations.readonly');

  const fields = 'slides(objectId,pageElements(objectId,table))';
  const url = `https://slides.googleapis.com/v1/presentations/${PRESENTATION_ID}?fields=${encodeURIComponent(fields)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Slides API error (${res.status}): ${await res.text()}`);
  const data = await res.json();

  const map = { presentationId: PRESENTATION_ID, generatedAt: new Date().toISOString(), venues: {} };

  for (const [venue, slideIdx] of Object.entries(VENUE_SLIDE_IDX)) {
    const slide = data.slides[slideIdx];
    const tableEl = slide.pageElements.find(el => el.table);
    if (!tableEl) { console.warn(`⚠️  ${venue}: no se encontró tabla en slide idx ${slideIdx}`); continue; }
    const table = tableEl.table;
    const rows = table.tableRows.map(r => (r.tableCells || []).map(cellText));

    const venueMap = { tableObjectId: tableEl.objectId, slideIdx, days: {}, saturday: [] };

    // Bloques entre semana: filas [1,2] y [3,4]
    for (const [timeRow, teamRow] of [[1, 2], [3, 4]]) {
      for (let col = 0; col < DAYS.length; col++) {
        const label = (rows[timeRow]?.[col] || '').trim();
        const raw = rows[teamRow]?.[col] || '';
        if (!label && !raw.trim()) continue; // día sin sesión en este bloque para esta sede
        const blockTime = parseStartTime(label);
        const segments = parseTeamCell(raw, blockTime, label);
        venueMap.days[DAYS[col]] = venueMap.days[DAYS[col]] || [];
        venueMap.days[DAYS[col]].push({ row: teamRow, col, segments });
      }
    }

    // Sábado: filas 6 (horarios por sub-columna) y 7 (equipos)
    const satLabels = rows[6] || [];
    const satTeams = rows[7] || [];
    for (let col = 0; col < satLabels.length; col++) {
      const label = (satLabels[col] || '').trim();
      const raw = satTeams[col] || '';
      if (!label && !raw.trim()) continue;
      // "Report at: X\nY.YY - Z.ZZ am/pm" -> el horario real está en la 2a línea
      const labelLines = label.split('\n').map(s => s.trim());
      let reportAt = null, timeLine = labelLines[0];
      if (REPORT_RE.test(labelLines[0]) && labelLines[1]) {
        reportAt = labelLines[0].replace(REPORT_RE, '').trim();
        timeLine = labelLines[1];
      }
      const blockTime = parseStartTime(timeLine);
      const segments = parseTeamCell(raw, blockTime, timeLine);
      venueMap.saturday.push({ row: 7, col, label: timeLine, reportAt, segments });
    }

    map.venues[venue] = venueMap;
    console.log(`✅  ${venue}: ${Object.keys(venueMap.days).length} días entre semana, ${venueMap.saturday.length} franjas de sábado`);
  }

  const outPath = join(__dir, 'data', 'slides-grid-map.json');
  writeFileSync(outPath, JSON.stringify(map, null, 2), 'utf8');
  console.log(`\nGuardado → ${outPath}`);
  console.log('⚠️  Revisa este fichero a mano contra el PowerPoint antes de usarlo con sync-teams-to-slides.mjs');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
