# Skello Coach Reconciliation — Contexto del proyecto

## Qué hace este proyecto

Compara las asignaciones teóricas de entrenadores (fichero de equipos) contra las sesiones reales registradas en Skello (sistema de pagos), y genera un dashboard HTML interactivo con los resultados por mes.

---

## Ficheros clave

| Fichero | Propósito |
|---------|-----------|
| `process.py` | Script principal — lee CSVs, reconcilia, genera `data/output.json` |
| `index.html` | Dashboard self-contained — carga `data/output.json` via fetch |
| `data/teams.csv` | Exportado de File 1 pestaña "New info teams" (169 equipos) |
| `data/sessions.csv` | Exportado de File 2 pestaña "Data" — **excluido de git**, re-exportar mensualmente |
| `data/output.json` | Generado por `process.py` — **excluido de git** |

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

Necesario porque el mismo nombre Skello puede tener varios slots en la semana con entrenadores distintos (ej: `Academy Nexus 2015-2017` tiene 7 slots con 6 entrenadores diferentes).

### Select — por nombre
1. Exact match col E vs col H
2. Normalizado: quitar prefijo `SELECT `, case-insensitive
3. Partial: prefijo común más largo

### Comparación de entrenador
- `ref_coach_id` (col AB File 1) vs `actual_coach_id` (col U File 2)
- **Assigned** si coinciden; **Other** si no
- Si `ref_coach_id` es `TBC` o `#N/A` → siempre cuenta como Other

---

## Orden de sesiones en el dashboard

Dentro de cada categoría (Academy/Select/GK), las sesiones se ordenan por:
1. **Venue** (Nexus, Perse, SJII, St Pats…)
2. **Día de la semana**: Lunes → Martes → Miércoles → Jueves → Viernes → Sábado
3. **Hora** (ascendente)
4. **Nombre base** como desempate si dos grupos de edad comparten el mismo slot

---

## Features del dashboard

- **Barra de resumen**: total sesiones, asignado, otro, % match global
- **Filas de categoría**: badge con % de match (verde ≥80% / ámbar 50–79% / rojo <50%) + asignado/total
- **Columna Match %**: por slot, antes del TOTAL, con colores
- **Celda Reference Coach**: nombre del titular + top 2 suplentes con su % sobre el total de sesiones
- **Columnas mensuales**: Ene–May 26, cada una con A (asignado) / O (otro)

---

## Problemas conocidos en los datos

1. **`ACADEMY NEXUS GIRLS 2014-2016`** (35 sesiones sin match): col E del fichero de equipos tiene `Academy Nexus 2014-2016` sin "Girls". Fix: actualizar col E en Google Sheets a `Academy Nexus Girls 2014-2016`.

2. **`ACADEMY Nexus 2015-2017 SA1630` y `SA1800`**: col AB del fichero de equipos tiene ID 82 (ZAINATUL AZHAR) como entrenador asignado, pero ese entrenador nunca aparece en esas sesiones en Skello. Los que realmente cubren son HADEY LATIFF (33) y coach 28. Los datos en Google Sheets son incorrectos para esas filas.

---

## Cómo actualizar los datos

```bash
# 1. Exportar pestaña "Data" de Skello → guardar como data/sessions.csv
# 2. Regenerar JSON
python3 process.py --csv
# 3. Ver en local
python3 -m http.server 8000
# 4. Subir a GitHub
git add data/output.json && git commit -m "Update data $(date +%Y-%m)" && git push
```

---

## GitHub

- **Repo**: https://github.com/ricardoba74/skello-coach-reconciliation
- **GitHub Pages**: Settings → Pages → branch `main` / root
