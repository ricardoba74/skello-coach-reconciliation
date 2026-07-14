#!/usr/bin/env bash
# Orquesta el pipeline completo: coaches (Airtable) → reconciliación
# (Sheets/CSV) → enriquecimiento de asistencia (Barca Academy API).
#
# Uso:
#   ./update-dashboard.sh          # producción — process.py lee Google Sheets vía API
#   ./update-dashboard.sh --csv    # local/dev  — process.py lee data/teams.csv y data/sessions.csv
#
# set -e hace que un fallo en cualquier paso detenga el resto, para no dejar
# el dashboard servido a medio actualizar.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

PYTHON="python3"
[ -x "./venv/bin/python3" ] && PYTHON="./venv/bin/python3"

log "Actualizando coaches desde Airtable…"
node fetch-coaches.mjs

log "Reconciliando equipos/sesiones…"
"$PYTHON" process.py "$@"

log "Enriqueciendo con asistencia de jugadores…"
node enrich-attendance.mjs

log "Pipeline completo ✅"
