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
| `fetch-coaches.mjs` | Paso 0 del pipeline — sincroniza teléfonos de coaches desde Airtable y escribe `data/coaches.csv` (`index.html` lo carga por `fetch()` al arrancar, ver "Botón WhatsApp"). **También** escribe columnas `NAME SURNAME, STATUS, ID, PHONE, MAIL` (ese orden exacto, no reordenar) en la pestaña "Coaches Air" del Google Sheet "Barça Academy Data Base" (`1-kztBuXshBnBptDWt5pdwWaT-dCUIWEHPHUG5gttbis`) — un proyecto no relacionado con este repo, pero reutiliza este cron para no montar infraestructura nueva. Autentica contra Sheets API con `credentials.json` vía un flow JWT-bearer hecho a mano (sin deps npm, usa `crypto` nativo) |
| `update-dashboard.sh` | Orquesta los 3 pasos anteriores en orden (`fetch-coaches` → `process` → `enrich`). Correr con `--csv` para modo local/dev, sin flags para producción (Sheets API) |
| `index.html` | Dashboard VPS — selector de **term** (arriba) + **dos pestañas** (Sessions + Coaches), carga `data/terms_index.json` y, perezosamente, el `term_output_<id>.json` del term seleccionado |
| `comments_script.gs` | Código del Google Apps Script para backend de comentarios |
| `credentials.json` | Clave de la Service Account de Google (Sheets+Drive API, solo lectura) — **excluido de git**, requerido para `process.py` sin `--csv` |
| `.env` | `AIRTABLE_API_KEY` + `BARCA_ATTENDANCE_TOKEN` — **excluido de git**, ver `.env.example` |
| `data/teams.csv` | Solo para modo `--csv` (fallback manual) — export de la pestaña "Teams" del Sheet "Barça Academy Data Base" |
| `data/sessions.csv` | Solo para modo `--csv` (fallback manual) — export de File 2 pestaña "Data". **Excluido de git** |
| `data/sessions_cache_<id>.json` | Fichero puente por term generado por `process.py` (fechas/coach/actividad de sesiones Select **y Sports Dev**, ya filtrado a las fechas de ese term) que consume `enrich-attendance.mjs` |
| `data/coaches.csv` | Generado por `fetch-coaches.mjs` desde Airtable — fuente de teléfonos para COACH_PHONES |
| `data/term_output_<id>.json` | Generado por el pipeline, uno por term (`<id>` = el definido en `TERMS`, ej. `t2_2026`) — **excluido de git** |
| `data/terms_index.json` | Manifest de terms disponibles `[{id, label, file, from, to}, ...]` — lo consumen `enrich-attendance.mjs` e `index.html`. **Excluido de git** |
| `inspect-slides-grid.mjs` | Herramienta de desarrollo, uso puntual — vuelca la estructura de las 4 tablas del PowerPoint de planning semanal en `data/slides-grid-map.json`. Solo se re-ejecuta si el PowerPoint cambia de estructura (columnas/filas nuevas) |
| `sync-teams-to-slides.mjs` | Sincroniza `Teams` (Sheet "Barça Academy Data Base") → PowerPoint de planning semanal. Ver sección "Sync Teams → PowerPoint" más abajo |
| `data/slides-grid-map.json` | Mapeo objectId de tabla + fila/columna por venue/día/hora del PowerPoint, generado por `inspect-slides-grid.mjs`, committeado a git — es config/infraestructura, no dato |

---

## Pipeline completo

**Producción (VPS, automático vía cron 4x/día, sin exportar nada a mano):**

El pipeline corre directamente dentro de `/var/www/bacoaches/` en el VPS, leyendo Google Sheets vía API (Service Account) — no requiere que nadie exporte CSVs ni haga `scp` de datos:

```bash
ssh -i ~/.ssh/hostinger_key root@89.116.33.101
cd /opt/bacoaches-pipeline && ./update-dashboard.sh
```

Cron (en el VPS): `0 2,8,14,20 * * * cd /opt/bacoaches-pipeline && ./update-dashboard.sh >> /var/log/bacoaches-pipeline.log 2>&1` — **4 veces al día**, mismo horario que el resto de automatizaciones del VPS (`academia-tools`, `sync-teams-to-slides.mjs`). Antes corría solo una vez al día (22:00 UTC); se cambió el 2026-08-10 para no quedarse desactualizado horas cuando alguien añade sesiones nuevas en Skello a mitad de día.

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
| Barça Academy Data Base — Equipos | pestaña "Teams" | `1-kztBuXshBnBptDWt5pdwWaT-dCUIWEHPHUG5gttbis` |
| File 2 — Sesiones ("KPIs Skello T2 2026") | https://docs.google.com/spreadsheets/d/1wYeFyD9LvyyrvkMz-VoikeB_QAajxKtfUkuUAojDBg8/edit?gid=0 | `1wYeFyD9LvyyrvkMz-VoikeB_QAajxKtfUkuUAojDBg8` |

- Barça Academy Data Base, pestaña "Teams": GID `1522724169`
- File 2 pestaña "Data": GID `0`

**El pipeline ya no lee la pestaña "New info teams"** (Sheet `1COqOZLAQNO437dPZgQpBWsgjreI-FJlbPDfdwHPeDcA`, GID `609166241`, propósito original de "File 1"). Se migró a la pestaña "Teams" de "Barça Academy Data Base" porque "New info teams" tenía una columna `SKELLO NAME` editada a mano de forma independiente del nombre del equipo, lo que permitía que se desincronizara y "robara" sesiones de otro equipo (ver problema conocido #1, resuelto por esta migración). "New info teams" puede seguir usándose para otros fines de operaciones, pero ya no es fuente de datos del dashboard. La misma pestaña "Teams" ya la usaban `fetch-coaches.mjs` (vía "Coaches Air") y `sync-teams-to-slides.mjs`.

**⚠️ Se crea un Google Sheet nuevo por term** (el de Term 1 era `1uGuXupAHufEPX1BnmZmY_r3PbGnHlpVot8i6a6Y2g_g` — ya no tiene datos recientes). Al cambiar de term, actualizar `SESSIONS_SHEET_ID` en `process.py` y compartir el nuevo Sheet con la service account (`coach-reconciliation-reader@skello-coach-reconciliation.iam.gserviceaccount.com`, permiso Viewer) — si no, el pipeline sigue leyendo el Sheet del term anterior sin avisar.

---

## Columnas relevantes

### Equipos — pestaña "Teams" (`data/teams.csv`)

Columnas leídas por `TEAMS_COL` en `process.py` (por nombre de cabecera, no por posición): `TEAM`, `ENTITY`, `STATUS`, `Coach ID1`, `Coach 1`.

| Columna | Contenido |
|---------|-----------|
| `TEAM`  | Nombre completo del equipo. Academy/GK incluyen sufijo de horario: `ACADEMY Nexus 2015-2017 MO1800` |
| `ENTITY` | Filtrado a `"BARÇA ACADEMY"` — la pestaña también tiene filas de `TPUFC` (otro club) que se descartan |
| `STATUS` | Filtrado a `"Active"` — descarta equipos `Inactive`/`Other` |
| `Coach ID1` | ID del entrenador de referencia (numérico; puede ser `TBC` o vacío) |
| `Coach 1` | Nombre del entrenador de referencia |
| `Coach ID2`/`Coach 2` | Coach secundario (ej. portero backup) — **no se usa** como segunda referencia, se trata como cualquier coach sustituto |

**No existen columnas `Type` ni `SKELLO NAME`** — se derivan en `clean_teams()`:
- `type` = `_derive_type(TEAM)`: prefijo `ACADEMY ` → Academy, `GK ` → GK, cualquier otro caso (incluye `SELECT ...` y `20XX BARÇA SPORTS DEV`) → Select.
- `skello` = `_derive_skello(TEAM, type)`: para Academy/GK, quita el sufijo de horario final (`\s+(MO|TU|WE|TH|FR|SA)\d{4}$`); para Select/Sports Dev, usa `TEAM` tal cual.

**Teléfonos de coaches** ya no vienen de esta pestaña (no tiene esas columnas) — ver sección "Botón WhatsApp".

### File 2 — Sesiones (`data/sessions.csv`)

| Índice Python | Columna | Contenido |
|--------------|---------|-----------|
| 5  | F  | Fecha `DD/MM/YYYY` |
| 7  | H  | Nombre de la sesión — coincide con el nombre Skello derivado de `TEAM` (pestaña "Teams", ver sección "Equipos" arriba) |
| 9  | J  | Hora de inicio `HH:MM` |
| 14 | O  | Full Name — fuente principal para lookup ID→nombre de entrenador |
| 18 | S  | Status — excluir filas con `No clock in` |
| 20 | U  | ID del entrenador (numérico) |
| 23 | X  | Actividad: `Academy` / `Select` / `GK` / `Sports Dev` / ... — las 4 primeras entran al pipeline (`VALID_ACTIVITIES` en `process.py`), el resto (Field Support, CCA, Coordinator, Camps, Internal League, PE Lesson, International Tournaments) se descarta |

---

## Lógica de matching

### Academy y GK — dos pasos
1. **Nombre Skello** (derivado de `TEAM`, ver arriba) normalizado == nombre de sesión (col H de File 2) normalizado
2. **Horario** del sufijo de `TEAM` (`MO1800` = lunes 18:00) == día de semana de la fecha + hora de inicio

### Select — por nombre
1. Exact match `skello` (= `TEAM`) vs col H
2. Normalizado: quitar prefijo `SELECT `, case-insensitive
3. Partial: prefijo común más largo

### Sports Dev — mismo matching que Select
Los equipos "BARÇA SPORTS DEV" se derivan como tipo `Select` (no hay tipo "Sports Dev" real). `find_team()` en `process.py` enruta las sesiones con `activity == "Sports Dev"` por `_match_select()`, que matchea directamente por `skello` (= `TEAM` tal cual, ej. `2014 BARÇA SPORTS DEV SYL`) — funciona porque el nombre de sesión en Skello coincide literalmente con `TEAM`. Aparecen como 4ª categoría en el dashboard.

**Importante**: como `skello` se deriva de `TEAM` (no hay columna de override independiente), el nombre de sesión en Skello y `TEAM` deben coincidir literalmente (tras normalizar). Si Skello registra una sesión con un nombre distinto (rango de años erróneo, orden de palabras distinto, etc.), el equipo se queda sin sesiones matcheadas y esas sesiones caen en `unmatched_sessions` — hay que corregir el nombre en la pestaña "Teams" (o el nombre real en Skello) para que coincidan. Ver problema conocido #5.

### Comparación de entrenador
- `ref_coach_id` (`Coach ID1`) vs `actual_coach_id` (col U File 2)
- **Assigned** si coinciden; **Other** si no
- Si `ref_coach_id` es `TBC` o vacío → siempre cuenta como Other

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

Dentro de cada categoría (Academy/Select/GK/Sports Dev):
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
- `data/sessions_cache_<id>.json` — bridge file de sesiones Select y Sports Dev (equipos sin sufijo de horario en el nombre) para `enrich-attendance.mjs`, ya filtrado a las fechas de ese term.
- `data/terms_index.json` — manifest `[{id, label, file, from, to}, ...]` que consumen tanto `enrich-attendance.mjs` como `index.html` para saber qué terms existen.

---

## Cabecera sticky

- `thead { position: sticky; top: 0; z-index: 3 }` — fila de fechas congelada
- `#term-table-wrap` y `#coaches-table-wrap`: `max-height: calc(100vh - 180px); overflow-y: auto`
- Columnas Session/Team y Coach: `position: sticky; left: 0/220px`

---

## Sistema de comentarios

Los comentarios se guardan en la pestaña **"Comments"** del spreadsheet original de equipos (`1COqOZLAQNO437dPZgQpBWsgjreI-FJlbPDfdwHPeDcA`, el que contenía "New info teams") — no relacionado con la migración a "Teams", que solo afecta a los datos de reconciliación.

- **Web App URL** (hardcodeada en `index.html` como `HARDCODED_GAS_URL`):
  `https://script.google.com/macros/s/AKfycbxgutR_S63QtgwQlajz1CKtdKWlKLbF_21-3fxjXU6jdXC_OUkZ0QB2kwl4hODzRQwXgw/exec`
- **Script project ID**: `10vN8kbyCN9hbBmiD4a80Om2Q75ecJvEmRmbqf1_oF32sFLfPyv7prIDI`
- Deploy: Execute as Me (ricardo@sportsdev.group), Who has access: Anyone
- GET devuelve `{teamKey: "texto"}` / POST guarda con `mode: 'no-cors'`
- Fallback a `localStorage` si no hay conexión

---

## Botón WhatsApp

Mapa `coach_id → teléfono` en `COACH_PHONES` (y status en `COACH_STATUS`), en `index.html` — **ya no están hardcodeados**: son `let` vacíos poblados por `loadCoaches()` al arrancar la página, que hace `fetch("data/coaches.csv")` y lo parsea en el cliente. Se cargan en paralelo con `loadTermsIndex()`/`loadComments()` en el `Promise.all` de arranque, antes de la primera llamada a `switchTerm()`/render.

**Fuente de teléfonos:**
`data/coaches.csv` (generado por `fetch-coaches.mjs` desde Airtable) — columnas `ID`, `PHONE`, `Status`. Es la **única** fuente desde la migración a la pestaña "Teams" (que no tiene columnas de teléfono); antes `data/teams.csv` (cols AD/AG/AJ de "New info teams") era fuente secundaria.

**Para actualizar teléfonos/status ya no hace falta tocar `index.html`** — `fetch-coaches.mjs` solo escribe `data/coaches.csv` (Paso 0 del pipeline, corre 4x/día); el navegador lo recarga en cada visita. Antes de 2026-08-10, `fetch-coaches.mjs` parcheaba `COACH_PHONES`/`COACH_STATUS` directamente en `index.html` con un `replace` por regex — se quitó porque era frágil (fallaba en silencio si el patrón de texto no coincidía exactamente) y obligaba a re-subir `index.html` en cada sync de Airtable.

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

1. **[RESUELTO por la migración a "Teams"] `2009 10 BARÇA SPORTS DEV` "robaba" las sesiones de `2011 BARÇA SPORTS DEV`.** En "New info teams", alguien había escrito a mano en la columna `SKELLO NAME` de `2009 10 BARÇA SPORTS DEV` el valor `2010 BARÇA SPORTS DEV` (el nombre con el que Skello registra esas sesiones desde julio 2026), lo que hacía que el match exacto por esa columna le robara a `2011 BARÇA SPORTS DEV` (mismo coach, Alan Martin) sus propias sesiones, dejándolo con 0 sesiones y sin fila en el dashboard. Como "Teams" no tiene una columna `SKELLO NAME` independiente que se pueda desincronizar así (se deriva de `TEAM`), esta clase de bug ya no puede ocurrir. Las sesiones de Skello literalmente llamadas `2010 BARÇA SPORTS DEV` siguen sin tener equipo exacto — aparecen en `unmatched_sessions` en vez de esconderse bajo otro equipo; pendiente decidir si son en realidad del grupo 2011 (mismo coach/horario en Term 2) y renombrarlas en Skello.

2. **[OBSOLETO, verificado 2026-08-10]** Este punto decía que `ACADEMY Nexus 2015-2017 SA1630`/`SA1800` tenían como coach de referencia a ID 82 (ZAINATUL AZHAR), que nunca aparece en Skello para esos slots — arrastrado sin verificar desde el CLAUDE.md de la época de "New info teams". Comprobado en vivo en "Teams": ambos slots tienen `Coach ID1 = 28` (MOHAMED FAIZAL BIN ABDUL RAHIM), coincide con quien realmente los cubre. No hay problema real aquí.

3. **Cada term puede tener su propia Google Sheet de sesiones.** Ya pasó una vez: `process.py` apuntaba a una sheet de sesiones que dejó de recibir datos nuevos al terminar Term 2 (había una sheet nueva, "KPIs Skello T2 2026", que nadie actualizó en el código). Síntoma: el term se corta en una fecha antigua aunque en Skello haya sesiones más recientes. Si esto vuelve a pasar, comprobar en `TERMS` (`process.py`) que `sessions_sheet_id` apunta a la sheet correcta para ese term.

4. **`Coach ID1` en "Teams" puede quedar en blanco** si alguien reestructura esa pestaña. Si el % de match cae a 0% de golpe sin que cambie nada en el código, comprobar esa columna en vivo antes de asumir que es un bug del pipeline.

5. **Discrepancias entre `TEAM` y el nombre real de sesión en Skello** — como `skello` se deriva de `TEAM` (no hay columna de override independiente, ver "Lógica de matching"), cualquier diferencia literal entre ambos deja al equipo sin sesiones matcheadas. Corregidas el 2026-08-09 (se editó `TEAM` en "Teams" para que coincida con Skello):
   - `ACADEMY St Pats 2015-2017 SA0930` → renombrado a `ACADEMY St Pats 2016-2017 SA0930`.
   - `GK SJII 2013-2018 MO1800` → renombrado a `GK SJII 2012-2018 MO1800`.
   - `ACADEMY Nexus 2014-2016 Girls SA1500` → renombrado a `ACADEMY Nexus Girls 2014-2016 SA1500` (Skello pone "Girls" antes del rango de años, no después).

   Si vuelve a aparecer un equipo con 0 sesiones que antes sí las tenía, comprobar primero si el nombre de sesión en Skello coincide literalmente (tras normalizar prefijo/sufijo de horario) con `TEAM` en "Teams".

6. **Equipos con 0 sesiones en el dashboard no siempre son un bug** — la mayoría de equipos ausentes del dashboard respecto a "Teams" son legítimos: equipos aún no empezados, o slots hermanos con mismo nombre base donde uno tiene coach `TBC` o `STATUS = Inactive` (`clean_teams()` filtra a `STATUS == "Active"`). Antes de asumir un problema de matching, comprobar si el equipo tiene sesiones reales en Skello con ese nombre.

   **Caso detectado 2026-08-09**: `SELECT 2017 18 NEON` tiene `STATUS = Inactive` en "Teams" (y sin coach asignado), pero sigue teniendo sesiones reales fichadas en Skello con coach real — esas sesiones caen en `unmatched_sessions` porque el filtro Active lo excluye. No se corrigió automáticamente (cambiar Active/Inactive es una decisión de roster, no un typo de nombre) — pendiente de que alguien confirme si el equipo sigue activo y actualice `STATUS` en "Teams".

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

## Sync Teams → PowerPoint (planning semanal por venue)

Sincroniza automáticamente la pestaña **Teams** del Google Sheet "Barça Academy Data Base" (`1-kztBuXshBnBptDWt5pdwWaT-dCUIWEHPHUG5gttbis`) hacia un PowerPoint de Google Slides (`1wYL01YWe-tcI-NgbVVITpCH_RbSH7g-Cf8wHi7CgO24`) con una diapositiva-cuadrícula por sede (Nexus=20, St Patricks=22, SJII=24, Perse=26 — 1-indexado) donde se listan los equipos Select/Sports Dev/GK que entrenan cada día/hora. **No es parte de este repo por diseño de proyecto — es una automatización aparte que vive aquí porque reutiliza la infraestructura de auth ya construida.**

- **Cada tabla-cuadrícula es una tabla nativa de Slides** (no cuadros de texto sueltos, pese a que la exportación de texto plano pueda sugerir lo contrario): 8 filas fijas — cabecera de días, horario bloque 1, equipos bloque 1, horario bloque 2, equipos bloque 2, "SATURDAY", horarios de sábado (una sub-columna por franja, no por día), equipos de sábado.
- **Solo Select, Sports Dev y GK** — los equipos `ACADEMY ...` se excluyen (tienen su propia plantilla). Los **GK van siempre al final de cada celda**, con una línea en blanco de separación, en **amarillo** (el resto en blanco) — ver `resolveDesiredForSegment`/`renderCellWithStyle` en `sync-teams-to-slides.mjs`.
- **Excepciones de horario incrustadas dentro de una celda** (ej. la mayoría de un bloque a las 19:30 pero 1-2 equipos a las 19:00, con su propia línea de horario dentro de la misma celda) se detectan en `inspect-slides-grid.mjs` (`parseTeamCell`) y se preservan como segmentos `inline` — mismo patrón ya visto al validar Teams contra el planificador T3 SELECT.
- Los bloques de texto libre "Goalkeeper Training\n<años>" (no son datos de Teams, no representan un equipo real) se descartan por completo, no se preservan.
- **Escritura**: `deleteText`+`insertText` dirigidos por `{tableObjectId, cellLocation: {rowIndex, columnIndex}}` — nunca `replaceAllText` (reescribiría dos celdas distintas que compartan texto idéntico). Color con `updateTextStyle` + `FIXED_RANGE`.
- **Pre-flight obligatorio**: antes de escribir, se relee la tabla y se confirma que el `tableObjectId` de cada venue sigue existiendo — si no, aborta sin escribir nada (protección para el cron desatendido).
- **Auth**: mismo flow JWT-bearer hecho a mano (sin deps npm) que `fetch-coaches.mjs`, pidiendo el scope `https://www.googleapis.com/auth/presentations`. Requiere la API de Slides habilitada en el proyecto GCP del `credentials.json` (`skello-coach-reconciliation`) y el PowerPoint compartido como Editor con esa cuenta de servicio — ambos ya resueltos.
- **Cron en el VPS**: `0 2,8,14,20 * * * cd /opt/bacoaches-pipeline && node sync-teams-to-slides.mjs --apply` — **4 veces al día**, mismo horario que el resto de crons del VPS (ver más abajo). Independiente de `update-dashboard.sh`.
- **Regenerar el mapeo**: si el PowerPoint cambia de estructura (columnas/filas nuevas, tabla recreada), volver a correr `node inspect-slides-grid.mjs` y revisar `data/slides-grid-map.json` a mano contra el PowerPoint antes de confiar en él.

**⚠️ Hay otro sistema de automatización totalmente separado en el mismo VPS**, en `/root/Documents/claude/academia-tools/` (dependencias npm propias — `googleapis`, `google-auth-library` — y su propio `reconcile-lib.mjs` de auth), que corre también a las 2,8,14,20h vía `build-all.mjs` y gestiona dashboards de coaches/contabilidad/staff/retención y una comparación Planificador↔New Info Teams (`planificador.mjs`) — **no tiene relación con este repo ni con el PowerPoint de planning**, pero comparte VPS y horario de cron. Verificado sin solapamiento (2026-08-01) antes de añadir el cron de `sync-teams-to-slides.mjs`.

---

## GitHub

- **Repo**: https://github.com/ricardoba74/skello-coach-reconciliation
- `data/sessions.csv`, `data/term_output_*.json`, `data/sessions_cache_*.json` y `data/terms_index.json` excluidos de git (`.gitignore`)
