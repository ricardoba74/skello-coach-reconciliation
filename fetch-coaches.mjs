#!/usr/bin/env node
/**
 * fetch-coaches.mjs
 * Descarga coaches de Airtable y escribe data/coaches.csv (teléfono + status
 * por coach_id) — index.html lo carga por fetch() al arrancar, nunca a mano.
 * Requiere: AIRTABLE_API_KEY en .env o en variable de entorno.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createSign } from 'crypto';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_ID  = 'app1lIMS3lNk43BPE';
const TABLE_ID = 'tblDaHlMv3JP1h4Hu';
const FIELDS   = ['ID', 'NAME SURNAME', 'PHONE', 'Status', 'MAIL'];

// "Coaches Air" tab in the (separate, unrelated) Barça Academy Data Base sheet —
// kept in sync here since fetch-coaches.mjs already runs daily via cron.
const DB_SHEET_ID       = '1-kztBuXshBnBptDWt5pdwWaT-dCUIWEHPHUG5gttbis';
const DB_COACHES_AIR_TAB = 'Coaches Air';

// ── Load API key from .env if not set in environment ─────────────────────────
function loadEnv() {
  const envPath = join(__dir, '.env');
  if (!process.env.AIRTABLE_API_KEY && existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^AIRTABLE_API_KEY\s*=\s*(.+)$/);
      if (m) process.env.AIRTABLE_API_KEY = m[1].trim().replace(/^["']|["']$/g, '');
    }
  }
}

loadEnv();

const API_KEY = process.env.AIRTABLE_API_KEY;
if (!API_KEY) {
  console.error('❌  AIRTABLE_API_KEY no configurada.');
  console.error('    Crea un fichero .env con:  AIRTABLE_API_KEY=patXXXXXXXXXXX');
  console.error('    Obtén tu token en: https://airtable.com/create/tokens');
  process.exit(1);
}

// ── Fetch all records (handles pagination) ───────────────────────────────────
async function fetchAll() {
  const records = [];
  let offset = null;

  do {
    const params = new URLSearchParams();
    FIELDS.forEach(f => params.append('fields[]', f));
    if (offset) params.set('offset', offset);

    const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}?${params}`;
    const res  = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}` } });

    if (!res.ok) {
      const err = await res.text();
      console.error(`❌  Error Airtable (${res.status}):`, err);
      process.exit(1);
    }

    const json = await res.json();
    records.push(...(json.records || []));
    offset = json.offset || null;
    if (offset) process.stdout.write('  paginando…\r');
  } while (offset);

  return records;
}

// ── Google service-account auth (no npm deps — hand-rolled JWT-bearer flow) ──
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
  const signature = base64url(signer.sign(creds.private_key));
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Google OAuth error (${res.status}): ${await res.text()}`);
  return (await res.json()).access_token;
}

async function sheetsApi(accessToken, spreadsheetId, path, options = {}) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...options.headers },
  });
  if (!res.ok) throw new Error(`Sheets API error (${res.status}): ${await res.text()}`);
  return res.json();
}

// ── Sync NAME SURNAME/STATUS/ID/PHONE/MAIL into the "Coaches Air" tab ────────
// Column order is fixed by spec: Nombre, Status, ID, Phone, Mail — do not reorder.
async function syncCoachesToDB(records) {
  const credsPath = join(__dir, 'credentials.json');
  if (!existsSync(credsPath)) {
    console.warn('⚠️   credentials.json no encontrado — se omite sync a "Coaches Air".');
    return;
  }

  const rows = records
    .map(rec => {
      const f = rec.fields || {};
      return {
        id: f['ID'],
        name: (f['NAME SURNAME'] || '').trim(),
        status: f['Status'] || '',
        phone: f['PHONE'] ?? '',
        mail: (f['MAIL'] || '').trim(),
      };
    })
    .filter(r => r.id)
    .sort((a, b) => a.id - b.id);

  const values = [
    ['NAME SURNAME', 'STATUS', 'ID', 'PHONE', 'MAIL'],
    ...rows.map(r => [r.name, r.status, r.id, r.phone, r.mail]),
  ];
  const range = `'${DB_COACHES_AIR_TAB}'`;

  const accessToken = await getGoogleAccessToken(credsPath, 'https://www.googleapis.com/auth/spreadsheets');
  await sheetsApi(accessToken, DB_SHEET_ID, `/values/${encodeURIComponent(range)}:clear`, { method: 'POST' });
  await sheetsApi(
    accessToken, DB_SHEET_ID,
    `/values/${encodeURIComponent(range + '!A1')}?valueInputOption=USER_ENTERED`,
    { method: 'PUT', body: JSON.stringify({ values }) }
  );
  console.log(`✅  "${DB_COACHES_AIR_TAB}" actualizada en Barça Academy DB (${rows.length} coaches)`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
console.log('Descargando coaches de Airtable…');
const records = await fetchAll();
console.log(`  ${records.length} registros descargados`);

try {
  await syncCoachesToDB(records);
} catch (e) {
  console.warn(`⚠️   No se pudo sincronizar "Coaches Air": ${e.message}`);
}

// Status field in Airtable only ever has these two values.
const STATUS_CODE = { 'Active': 'A', 'Former': 'F' };

// Build phone + status maps: coach_id (number) → value
const phones    = {};
const statuses  = {};
const csvRows   = ['ID,NAME SURNAME,PHONE,Status'];
let noPhone     = 0;
let badStatus   = new Set();

for (const rec of records) {
  const f    = rec.fields || {};
  const id   = f['ID'];
  const name = (f['NAME SURNAME'] || '').trim();
  const raw  = f['PHONE'];
  const stat = f['Status'] || '';

  if (!id) continue;

  // Normalize phone: keep digits only, ensure Singapore (+65) prefix
  let phone = '';
  if (raw !== undefined && raw !== null && raw !== '') {
    const digits = String(raw).replace(/\D/g, '');
    phone = digits;
    // If it's 8 digits (SG local), prepend 65
    if (digits.length === 8) phone = '65' + digits;
  } else {
    noPhone++;
  }

  if (phone) phones[String(id)] = phone;

  const statusCode = STATUS_CODE[stat];
  if (statusCode) {
    statuses[String(id)] = statusCode;
  } else if (stat) {
    badStatus.add(stat);
  }

  csvRows.push(`${id},"${name}",${phone},${stat}`);
}

if (badStatus.size) {
  console.warn(`⚠️   Valores de Status no reconocidos (ni Active ni Former): ${[...badStatus].join(', ')}`);
}

// Sort by numeric ID
const sortByCoachId = obj => Object.fromEntries(
  Object.entries(obj).sort((a, b) => Number(a[0]) - Number(b[0]))
);
const sortedPhones    = sortByCoachId(phones);
const sortedStatuses  = sortByCoachId(statuses);

console.log(`  ${Object.keys(sortedPhones).length} coaches con teléfono | ${noPhone} sin teléfono`);
console.log(`  ${Object.keys(sortedStatuses).length} coaches con status (Active/Former)`);

// ── Save coaches.csv ──────────────────────────────────────────────────────────
// index.html fetches this file directly at boot (loadCoaches()) — no longer
// patches COACH_PHONES/COACH_STATUS into index.html itself.
const csvPath = join(__dir, 'data', 'coaches.csv');
writeFileSync(csvPath, csvRows.join('\n') + '\n', 'utf8');
console.log(`✅  data/coaches.csv guardado (${records.length} filas)`);
