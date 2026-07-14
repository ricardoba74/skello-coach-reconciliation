#!/usr/bin/env node
/**
 * fetch-coaches.mjs
 * Descarga coaches de Airtable y actualiza COACH_PHONES en index.html.
 * Requiere: AIRTABLE_API_KEY en .env o en variable de entorno.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_ID  = 'app1lIMS3lNk43BPE';
const TABLE_ID = 'tblDaHlMv3JP1h4Hu';
const FIELDS   = ['ID', 'NAME SURNAME', 'PHONE', 'Status'];

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

// ── Main ─────────────────────────────────────────────────────────────────────
console.log('Descargando coaches de Airtable…');
const records = await fetchAll();
console.log(`  ${records.length} registros descargados`);

// Build phone map: coach_id (number) → phone string (with country code)
const phones = {};
const csvRows = ['ID,NAME SURNAME,PHONE,Status'];
let noPhone = 0;

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

  csvRows.push(`${id},"${name}",${phone},${stat}`);
}

// Sort by numeric ID
const sorted = Object.fromEntries(
  Object.entries(phones).sort((a, b) => Number(a[0]) - Number(b[0]))
);

console.log(`  ${Object.keys(sorted).length} coaches con teléfono | ${noPhone} sin teléfono`);

// ── Save coaches.csv ──────────────────────────────────────────────────────────
const csvPath = join(__dir, 'data', 'coaches.csv');
writeFileSync(csvPath, csvRows.join('\n') + '\n', 'utf8');
console.log(`✅  data/coaches.csv guardado (${records.length} filas)`);

// ── Patch COACH_PHONES in index.html ─────────────────────────────────────────
const htmlPath = join(__dir, 'index.html');
let html = readFileSync(htmlPath, 'utf8');

const newConst = `const COACH_PHONES = ${JSON.stringify(sorted)};`;
const updated  = html.replace(/const COACH_PHONES = \{[^}]*\};/, newConst);

if (updated === html) {
  console.warn('⚠️   No se encontró COACH_PHONES en index.html — revisa el formato');
} else {
  writeFileSync(htmlPath, updated, 'utf8');
  console.log(`✅  COACH_PHONES actualizado en index.html (${Object.keys(sorted).length} entradas)`);
}
