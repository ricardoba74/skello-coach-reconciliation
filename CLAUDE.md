# Skello Coach Reconciliation — Contexto del proyecto

## ⚠️ INSTRUCCIONES CRÍTICAS PARA CLAUDE

**ANTES de modificar cualquier fichero en este proyecto**, leer obligatoriamente:
1. Este CLAUDE.md completo
2. El estado actual de `index.html` (34KB+, tiene dos pestañas Sessions + Coaches con ATT_START, Consistencia, Asistencia, WhatsApp)
3. El estado actual de `process.py` y `enrich-attendance.mjs`

**NUNCA sobreescribir `index.html` con una versión simplificada.** Si el fichero que existe tiene más features que la versión que se va a escribir, es un error. Verificar siempre el tamaño: debe ser ≥ 30KB.

---

## Qué hace este proyecto

Compara las asignaciones teóricas de entrenadores (fichero de equipos) contra las sesiones reales registradas en Skello (sistema de pagos), y genera un dashboard HTML interactivo en `bacoaches.pomaglobal.com`.

---

## Ficheros clave

| Fichero | Propósito |
|---------|-----------|
| `process.py` | Paso 1 del pipeline — lee CSVs, reconcilia, genera `data/term_output.json` |
| `enrich-attendance.mjs` | Paso 2 del pipeline — enriquece el JSON con `dates[]`, `by_date[]`, `att_by_date[]` |
| `index.html` | Dashboard VPS — **dos pestañas** (Sessions + Coaches), carga `data/term_output.json` enriquecido |
| `comments_script.gs` | Código del Google Apps Script para backend de comentarios |
| `data/teams.csv` | Exportado de File 1 pestaña "New info teams" |
| `data/sessions.csv` | Exportado de File 2 pestaña "Data" — **excluido de git**, re-exportar mensualmente |
| `data/coaches.csv` | Exportado de la base de datos de coaches (Airtable/sistema interno) — fuente de teléfonos para COACH_PHONES |
| `data/term_output.json` | Generado por el pipeline — **excluido de git** |

---

## Pipeline completo (orden obligatorio)

```bash
# 1. Exportar pestaña "Data" de Skello → guardar como data/sessions.csv
# 2. Regenerar JSON base con presencia por semana + coaches[]
python3 process.py --csv

# 3. Enriquecer con fechas individuales y datos de att de jugadores
node enrich-attendance.mjs

# 4. Subir al VPS
scp -i ~/.ssh/hostinger_key \
  index.html \
  data/term_output.json \
  root@89.116.33.101:/var/www/bacoaches/
scp -i ~/.ssh/hostinger_key \
  data/term_output.json \
  root@89.116.33.101:/var/www/bacoaches/data/term_output.json
```

**Nunca subir solo el JSON sin el pipeline completo (process.py → enrich).**

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
| File 2 — Sesiones | https://docs.google.com/spreadsheets/d/1uGuXupAHufEPX1BnmZmY_r3PbGnHlpVot8i6a6Y2g_g | `1uGuXupAHufEPX1BnmZmY_r3PbGnHlpVot8i6a6Y2g_g` |

- File 1 pestaña "New info teams": GID `609166241`
- File 2 pestaña "Data": GID `0`

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

Título: **"Academy Coach Monitor T3 2026"** (actualizar cada term).

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

## Cálculo de Asistencia — ATT_START

La herramienta de att de jugadores se lanzó el **4 de mayo de 2026**.

```javascript
const ATT_START = '2026-05-04';
```

- Fechas **anteriores** a ATT_START: sin fondo rojo aunque no haya att
- **Denominador** de Asistencia % = sesiones desde ATT_START en que el coach estuvo presente
- **Numerador** = sesiones desde ATT_START con att registrada

---

## Período actual

- **Term 2**: 20 Apr 2026 → 12 Jul 2026 (12 semanas, TERM_END se ajusta dinámicamente al último día del CSV)
- Definido en `process.py`: `TERM_START` fijo, `TERM_END` dinámico (último día con sesiones en el CSV)
- Actualizar título en `index.html` al cambiar de term: `"Academy Coach Monitor T2 2026"`

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

```json
{
  "term": { "from": "2026-04-20", "to": "2026-07-12" },
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
- `data/sessions.csv` y `data/term_output.json` excluidos de git (`.gitignore`)
