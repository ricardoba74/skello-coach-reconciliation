# Skello Coach Reconciliation — Contexto del proyecto

## ⚠️ INSTRUCCIONES CRÍTICAS PARA CLAUDE

**ANTES de modificar cualquier fichero en este proyecto**, leer obligatoriamente:
1. Este CLAUDE.md completo
2. El estado actual de `index.html` (50KB+, selector de **term** arriba + dos pestañas Sessions + Coaches con ATT_START por term, Consistencia, Asistencia, WhatsApp)
3. El estado actual de `process.py` y `enrich-attendance.mjs`

**NUNCA sobreescribir `index.html` con una versión simplificada.** Si el fichero que existe tiene más features que la versión que se va a escribir, es un error. Verificar siempre el tamaño: debe ser ≥ 45KB.

---

## Qué hace este proyecto

Compara las asignaciones teóricas de entrenadores (fichero de equipos) contra las sesiones reales registradas en Skello (sistema de pagos), y genera un dashboard HTML interactivo en `bacoaches.pomaglobal.com`.

---

## Ficheros clave

| Fichero | Propósito |
|---------|-----------|
| `process.py` | Paso 1 del pipeline — lee Google Sheets (API) o CSVs (`--csv`), reconcilia **cada term del registro `TERMS`**, genera `data/term_output_<id>.json`, `data/sessions_cache_<id>.json` y `data/terms_index.json` |
| `enrich-attendance.mjs` | Paso 2 del pipeline — lee `data/terms_index.json` y enriquece cada `term_output_<id>.json` con `dates[]`, `by_date[]`, `att_by_date[]` |
| `fetch-coaches.mjs` | Paso 0 del pipeline — sincroniza teléfonos de coaches desde Airtable, escribe `data/coaches.csv` y parchea `COACH_PHONES` en `index.html` |
| `update-dashboard.sh` | Orquesta los 3 pasos anteriores en orden (`fetch-coaches` → `process` → `enrich`). Correr con `--csv` para modo local/dev, sin flags para producción (Sheets API) |
| `index.html` | Dashboard VPS — selector de **term** (arriba) + **dos pestañas** (Sessions + Coaches), carga `data/terms_index.json` y, perezosamente, el `term_output_<id>.json` del term seleccionado |
| `comments_script.gs` | Código del Google Apps Script para backend de comentarios |
| `credentials.json` | Clave de la Service Account de Google (Sheets+Drive API, solo lectura) — **excluido de git**, requerido para `process.py` sin `--csv` |
| `.env` | `AIRTABLE_API_KEY` + `BARCA_ATTENDANCE_TOKEN` — **excluido de git**, ver `.env.example` |
| `data/teams.csv` | Solo para modo `--csv` (fallback manual) — export de File 1 pestaña "New info teams" |
| `data/sessions.csv` | Solo para modo `--csv` (fallback manual) — export de File 2 pestaña "Data". **Excluido de git** |
| `data/sessions_cache_<id>.json` | Fichero puente por term generado por `process.py` (fechas/coach/actividad de sesiones Select, ya filtrado a las fechas de ese term) que consume `enrich-attendance.mjs` |
| `data/coaches.csv` | Generado por `fetch-coaches.mjs` desde Airtable — fuente de teléfonos para COACH_PHONES |
| `data/term_output_<id>.json` | Generado por el pipeline, uno por term (`<id>` = el definido en `TERMS`, ej. `t2_2026`) — **excluido de git** |
| `data/terms_index.json` | Manifest de terms disponibles `[{id, label, file, from, to}, ...]` — lo consumen `enrich-attendance.mjs` e `index.html`. **Excluido de git** |

---

## Pipeline completo

**Producción (VPS, automático vía cron diario, sin exportar nada a mano):**

El pipeline corre directamente dentro de `/var/www/bacoaches/` en el VPS, leyendo Google Sheets vía API (Service Account) — no requiere que nadie exporte CSVs ni haga `scp` de datos:

```bash
ssh -i ~/.ssh/hostinger_key root@89.116.33.101
cd /opt/bacoaches-pipeline && ./update-dashboard.sh
```

Cron (en el VPS): `0 22 * * * cd /opt/bacoaches-pipeline && ./update-dashboard.sh >> /var/log/bacoaches-pipeline.log 2>&1` (22:00 UTC = 06:00 SGT).

**Local/dev (modo `--csv`, sin credenciales de Google):**

```bash
python3 process.py --csv       # lee data/teams.csv + data/sessions.csv
node enrich-attendance.mjs      # lee data/sessions_cache.json (generado por process.py)
node fetch-coaches.mjs          # opcional, requiere AIRTABLE_API_KEY en .env
```

**Cuando yo (Claude) modifico código** (`index.html`, `process.py`, etc.), el `scp` al VPS sigue siendo manual/confirmado — nunca automático:

```bash
scp -i ~/.ssh/hostinger_key index.html root@89.116.33.101:/var/www/bacoaches/
```

**Nunca subir solo el JSON sin el pipeline completo.** Los datos ahora se generan y sirven desde el propio VPS — el `scp` de datos ya no aplica, solo el de código.

---

## URLs y rutas

| Entorno | Ruta |
|---------|------|
| VPS (producción) | `root@89.116.33.101:/var/www/bacoaches/` |
| Dominio | `bacoaches.pomaglobal.com` |
| SSH key | `~/.ssh/hostinger_key` |
| Proyecto local | `/Users/ricardosancho/Documents/Claude/Skello C/` |

---

## Google Sheets

| Fichero | URL | Sheet ID |
|---------|-----|----------|
| File 1 — Equipos | https://docs.google.com/spreadsheets/d/1COqOZLAQNO437dPZgQpBWsgjreI-FJlbPDfdwHPeDcA/edit?gid=609166241 | `1COqOZLAQNO437dPZgQpBWsgjreI-FJlbPDfdwHPeDcA` |
| File 2 — Sesiones ("KPIs Skello T2 2026") | https://docs.google.com/spreadsheets/d/1wYeFyD9LvyyrvkMz-VoikeB_QAajxKtfUkuUAojDBg8/edit?gid=0 | `1wYeFyD9LvyyrvkMz-VoikeB_QAajxKtfUkuUAojDBg8` |

- File 1 pestaña "New info teams": GID `609166241`
- File 2 pestaña "Data": GID `0`

**⚠️ Se crea un Google Sheet nuevo por term** (el de Term 1 era `1uGuXupAHufEPX1BnmZmY_r3PbGnHlpVot8i6a6Y2g_g` — ya no tiene datos recientes). Al cambiar de term, actualizar `SESSIONS_SHEET_ID` en `process.py` y compartir el nuevo Sheet con la service account (`coach-reconciliation-reader@skello-coach-reconciliation.iam.gserviceaccount.com`, permiso Viewer) — si no, el pipeline sigue leyendo el Sheet del term anterior sin avisar.

---

## Columnas relevantes

### File 1 — Equipos (`data/teams.csv`)

| Índice Python | Columna | Contenido |
|--------------|---------|-----------|
| 3  | D  | Nombre completo del equipo. Academy/GK incluyen sufijo de horario: `ACADEMY Nexus 2015-2017 MO1800` |
| 4  | E  | Nombre Skello — coincide con col H de sesiones. Ej: `Academy Nexus 2015-2017`. **Vacío para Select.** |
| 11 | L  | Tipo: `Academy` / `Select` / `GK` |
| 27 | AB | ID del entrenador asignado (numérico; puede ser `TBC` o `#N/A`) |
| 28 | AC | Nombre del entrenador 2026 |
| 29 | AD | Teléfono Coach 1 2026 (para botón WhatsApp) |
| 32 | AG | Teléfono Coach 2 2026 |
| 35 | AJ | Teléfono Coach 3 2026 |

### File 2 — Sesiones (`data/sessions.csv`)

| Índice Python | Columna | Contenido |
|--------------|---------|-----------|
| 5  | F  | Fecha `DD/MM/YYYY` |
| 7  | H  | Nombre de la sesión — coincide con col E de File 1 |
| 9  | J  | Hora de inicio `HH:MM` |
| 14 | O  | Full Name — fuente principal para lookup ID→nombre de entrenador |
| 18 | S  | Status — excluir filas con `No clock in` |
| 20 | U  | ID del entrenador (numérico) |
| 23 | X  | Actividad: `Academy` / `Select` / `GK` / `Sports Dev` / ... |

---

## Lógica de matching

### Academy y GK — dos pasos
1. **Nombre Skello** (col E de File 1) normalizado == nombre de sesión (col H de File 2) normalizado
2. **Horario** del sufijo de col D (`MO1800` = lunes 18:00) == día de semana de la fecha + hora de inicio

### Select — por nombre
1. Exact match col E vs col H
2. Normalizado: quitar prefijo `SELECT `, case-insensitive
3. Partial: prefijo común más largo

### Comparación de entrenador
- `ref_coach_id` (col AB File 1) vs `actual_coach_id` (col U File 2)
- **Assigned** si coinciden; **Other** si no
- Si `ref_coach_id` es `TBC` o `#N/A` → siempre cuenta como Other

---

## Dashboard — `bacoaches.pomaglobal.com`

**Multi-term.** El dashboard ya no asume un único periodo — hay un selector de term (pestañas arriba del todo, encima de Sessions/Coaches) generado dinámicamente desde `data/terms_index.json`. Al cargar, se selecciona por defecto el term cuyo rango de fechas contiene el día de hoy (si no hay ninguno, el más reciente). Cambiar de term recarga (con caché en memoria, `window._termsData`) las vistas Sessions/Coaches/Resumen Ejecutivo con el JSON de ese term — nunca se cargan todos los terms de golpe.

Título (`<title>` y `<h1 id="page-title">`): `"Academy Coach Monitor — {label del term activo}"`, actualizado en cada cambio de term por `switchTerm()` — ya no hay que tocar el HTML a mano al cambiar de term.

### Pestaña Sessions

Vista por equipo: una fila por coach por sesión, columnas = fechas individuales del term.

- **Columnas fijas (sticky left):** Session/Team | Coach
- **Columnas de métricas:** Consistencia | Asistencia | Comments
- **Columnas de fechas:** una por día con sesiones (no por semana)

**Colores de celda de fecha:**
- Fondo verde oscuro (`#1b5e20`): coach presente + att de jugadores registrada
- Fondo rojo oscuro (`#b71c1c`): coach presente + sin att (**solo desde ATT_START = 2026-05-04**)
- Sin fondo: coach presente antes de ATT_START (sin penalización), o coach ausente

**Cabeceras de categoría** muestran tres badges:
- `N equipos` — total de sesiones en esa categoría
- `Consist. X%` — % presencia agregada del coach REF
- `Asist. Y%` — % att agregada desde ATT_START

### Pestaña Coaches

Vista invertida: un bloque por coach (colapsable), sub-filas por sesión. Mismas columnas de fechas.

**Cabecera de coach** muestra:
- `N teams` — número de equipos
- `Consist. X%` — % de sesiones del term en que el coach apareció
- `Asist. Y%` — % de sesiones desde ATT_START con att registrada
- Botón **WhatsApp** verde — solo si el coach tiene teléfono en `COACH_PHONES`

### Orden de sesiones

Dentro de cada categoría (Academy/Select/GK):
1. **Venue** (Nexus, Perse, SJII, St Pats…)
2. **Día de la semana**: Mo → Tu → We → Th → Fr → Sa
3. **Hora** (ascendente)
4. **Nombre base** como desempate

---

## Cálculo de Asistencia — ATT_START (por term)

`ATT_START` ya **no está hardcodeado** en `index.html` — es `let ATT_START` (no `const`), asignado en `switchTerm()` desde `data.term.att_start` de cada JSON. Cada entrada en `TERMS` (`process.py`) define su propio `att_start`:

- **Term 2 2026**: `att_start = "2026-05-04"` — excepción histórica, la herramienta de att de jugadores se lanzó a mitad de term (empezó 20 abr).
- **Term 3 2026 en adelante**: `att_start` = fecha de inicio de ese term, **sin periodo de gracia** (la herramienta ya lleva meses activa).

- Fechas **anteriores** a `ATT_START` del term activo: sin fondo rojo aunque no haya att
- **Denominador** de Asistencia % = sesiones desde `ATT_START` en que el coach estuvo presente
- **Numerador** = sesiones desde `ATT_START` con att registrada

---

## Terms — registro multi-term (`process.py` → `TERMS`)

El pipeline reconcilia **todos los terms configurados** en cada ejecución (no solo el actual) — es barato y evita lógica de "term activo/cerrado". Un term cerrado no cambia porque su rango de fechas ya no admite filas nuevas de Skello.

```python
TERMS = [
    {
        "id": "t2_2026", "label": "Term 2 2026",
        "start": datetime(2026, 4, 20), "end": datetime(2026, 7, 12),
        "sessions_sheet_id": "1wYeFyD9LvyyrvkMz-VoikeB_QAajxKtfUkuUAojDBg8", "sessions_gid": 0,
        "att_start": "2026-05-04",
    },
    {
        "id": "t3_2026", "label": "Term 3 2026",
        "start": datetime(2026, 7, 13), "end": datetime(2026, 10, 4),
        "sessions_sheet_id": "1wYeFyD9LvyyrvkMz-VoikeB_QAajxKtfUkuUAojDBg8", "sessions_gid": 0,
        "att_start": "2026-07-13",
    },
]
```

| Term | Inicio | Fin |
|------|--------|-----|
| Term 2 2026 | 20/04/2026 | 12/07/2026 |
| Term 3 2026 | 13/07/2026 | 04/10/2026 |
| Term 4 2026 | 05/10/2026 | 10/01/2027 (aún no dado de alta) |

**⚠️ Cada term puede tener su propio Google Sheet de sesiones** (ya ha pasado una vez — ver "Problemas conocidos"). Term 2 y Term 3 comparten hoy la misma sheet (`KPIs Skello T2 2026`), filtrando cada uno por su rango de fechas; `process.py` deduplica la petición a la Sheets API cuando varios terms comparten `sessions_sheet_id`.

**Para dar de alta un term nuevo** (ej. Term 4 cuando arranque):
1. Añadir una entrada a `TERMS` en `process.py` (id, label, start, end, sessions_sheet_id, sessions_gid, att_start).
2. Si es una sheet nueva, compartirla (Viewer) con `coach-reconciliation-reader@skello-coach-reconciliation.iam.gserviceaccount.com`.
3. Nada más — `enrich-attendance.mjs` e `index.html` leen `data/terms_index.json` y se adaptan solos, sin tocar código.

**Ficheros generados por term** (naming `<algo>_<id>.json`, `id` = el de `TERMS`):
- `data/term_output_<id>.json` — mismo formato que antes (categories/coaches/dates), más `term.att_start` y `term.label`.
- `data/sessions_cache_<id>.json` — bridge file de sesiones Select para `enrich-attendance.mjs`, ya filtrado a las fechas de ese term.
- `data/terms_index.json` — manifest `[{id, label, file, from, to}, ...]` que consumen tanto `enrich-attendance.mjs` como `index.html` para saber qué terms existen.

---

## Cabecera sticky

- `thead { position: sticky; top: 0; z-index: 3 }` — fila de fechas congelada
- `#term-table-wrap` y `#coaches-table-wrap`: `max-height: calc(100vh - 180px); overflow-y: auto`
- Columnas Session/Team y Coach: `position: sticky; left: 0/220px`

---

## Sistema de comentarios

Los comentarios se guardan en la pestaña **"Comments"** del spreadsheet de File 1.

- **Web App URL** (hardcodeada en `index.html` como `HARDCODED_GAS_URL`):
  `https://script.google.com/macros/s/AKfycbxgutR_S63QtgwQlajz1CKtdKWlKLbF_21-3fxjXU6jdXC_OUkZ0QB2kwl4hODzRQwXgw/exec`
- **Script project ID**: `10vN8kbyCN9hbBmiD4a80Om2Q75ecJvEmRmbqf1_oF32sFLfPyv7prIDI`
- Deploy: Execute as Me (ricardo@sportsdev.group), Who has access: Anyone
- GET devuelve `{teamKey: "texto"}` / POST guarda con `mode: 'no-cors'`
- Fallback a `localStorage` si no hay conexión

---

## Botón WhatsApp

Mapa `coach_id → teléfono` embebido como constante `COACH_PHONES` en `index.html`.

**Fuentes de teléfonos (en orden de prioridad):**
1. `data/coaches.csv` — columna `PHONE` (col 13), columna `ID` (col 1). **Fuente principal y más completa.**
2. `data/teams.csv` — cols AD/AG/AJ (índices 29, 32, 35). Fuente secundaria.

**Proceso para actualizar COACH_PHONES:**
1. Exportar coaches.csv del sistema de gestión de coaches
2. Leer col `ID` y col `PHONE`
3. Para coaches que aparecen en el dashboard (`term_output.json`) pero no tienen botón, buscar su ID en coaches.csv col `ID`
4. Añadir la entrada `"coach_id":"phone"` en la constante `COACH_PHONES` de `index.html` manteniendo orden numérico

Mensaje pre-redactado (firmado por Jordi, enlace a attendance.barcaacademy.sg).

---

## API de att de jugadores

`https://attendance.barcaacademy.sg/api/attendance/logs`
Token: `bff40f954954bf2c8fafa4cc1dbb7fe06b14de8afb9c754e19bb9bdcf3b970b5`

**Resolución de nombres API → coach_id:**
- La API devuelve nombres de coach (no IDs)
- `process.py` construye `name_to_id` y `word_to_cids` (índice invertido por tokens) para matching fuzzy
- `enrich-attendance.mjs` usa `resolveCoachId()` con fallback por inclusión de substring
- 5 nombres sin match esperados (Jordi, Ricardo, Nur Syarafiqa, HERWAN — nombre distinto en Skello, Indra — spelling diferente)

---

## Estructura del JSON (tras pipeline completo)

Un fichero `data/term_output_<id>.json` por term (ver `data/terms_index.json` para la lista):

```json
{
  "term": { "from": "2026-04-20", "to": "2026-07-12", "att_start": "2026-05-04", "label": "Term 2 2026" },
  "generated_at": "...",
  "weeks": [{"num":1,"label":"S1","dates":"20 Abr"}, ...],
  "dates": ["2026-04-20", "2026-04-21", ...],
  "categories": [
    {
      "name": "Academy",
      "sessions": [
        {
          "team": "ACADEMY Nexus 2015-2017 MO1800",
          "ref_coach_id": 33,
          "ref_coach_name": "HADEY LATIFF",
          "total_sessions": 9,
          "total_assigned": 7,
          "coaches_summary": [{"coach_id":33,"coach_name":"...","is_ref":true,"count":7,"pct":78,"att_count":5}],
          "coaches": [
            {
              "coach_id": 33,
              "coach_name": "HADEY LATIFF",
              "is_ref": true,
              "count": 7,
              "by_week": [true, false, null, ...],
              "by_date": [true, null, null, false, ...],
              "att_by_date": [true, null, null, false, ...]
            }
          ],
          "by_week": [[{"day":"Mo","coaches":[{"coach_id":33,"attended":true,"att":true}]}], ...]
        }
      ]
    }
  ],
  "coaches": [
    {
      "coach_id": 33,
      "coach_name": "HADEY LATIFF",
      "sessions": [{"team":"...","category":"Academy","total_sessions":9,"is_ref":true,"count":7,"by_date":[...],"att_by_date":[...]}]
    }
  ]
}
```

**Nota:** `coaches[]` en cada sesión es lo que usa `enrich-attendance.mjs`. `coaches_summary[]` y `by_week[]` son para uso interno/legacy.

---

## Problemas conocidos en los datos

1. **`ACADEMY NEXUS GIRLS 2014-2016`** (35 sesiones sin match): col E tiene `Academy Nexus 2014-2016` sin "Girls". Fix: actualizar col E en Google Sheets.

2. **`ACADEMY Nexus 2015-2017 SA1630` y `SA1800`**: col AB tiene ID 82 (ZAINATUL AZHAR) pero ese coach nunca aparece en Skello. Los que cubren son HADEY LATIFF (33) y coach 28. Datos incorrectos en Google Sheets.

3. **Cada term puede tener su propia Google Sheet de sesiones.** Ya pasó una vez: `process.py` apuntaba a una sheet de sesiones que dejó de recibir datos nuevos al terminar Term 2 (había una sheet nueva, "KPIs Skello T2 2026", que nadie actualizó en el código). Síntoma: el term se corta en una fecha antigua aunque en Skello haya sesiones más recientes. Si esto vuelve a pasar, comprobar en `TERMS` (`process.py`) que `sessions_sheet_id` apunta a la sheet correcta para ese term.

4. **`ID Coach 1` en "New info teams" puede quedar en blanco/`#REF!`** si alguien reestructura esa pestaña (ej. migración a un sistema de "slots" con `ID Slot1_Coach`/`ID Slot2_Coach`/`ID Slot3_Coach`). Si el % de match cae a 0% de golpe sin que cambie nada en el código, comprobar esa columna en vivo antes de asumir que es un bug del pipeline.

---

## Resumen Ejecutivo (panel dinámico)

Panel colapsable en `index.html`, renderizado por `renderExecSummary(data)`, ubicado entre el strip de métricas globales y la tabla de sesiones (`<div id="exec-summary"></div>`).

**4 tarjetas calculadas al vuelo desde `term_output.json`:**

| Tarjeta | Criterio | Filtro mínimo |
|---------|----------|---------------|
| ▲ Sesiones — Mejor Consistencia | Top 6 sesiones por % del coach REF, desc | ≥ 3 sesiones en el term |
| ▼ Sesiones — Peor Consistencia | Top 6 sesiones por % del coach REF, asc | ≥ 3 sesiones en el term |
| ▲ Coaches — Mejor Consistencia | Top 6 coaches por % global, desc | ≥ 3 sesiones en el term |
| ▼ Coaches — Peor Asistencia | Top 6 coaches por att % desde ATT_START, asc | ≥ 3 sesiones att-elegibles |

- Badges verdes/naranja/rojo: ≥80% ok · 50–79% mid · <50% bad
- Los nombres de sesión se acortan quitando el prefijo `ACADEMY /SELECT /GK `
- Toggle con `toggleExec()`: colapsa/expande el body `#exec-body`

---

## GitHub

- **Repo**: https://github.com/ricardoba74/skello-coach-reconciliation
- `data/sessions.csv`, `data/term_output_*.json`, `data/sessions_cache_*.json` y `data/terms_index.json` excluidos de git (`.gitignore`)
