# Conciliación de Entrenadores – Contexto de trabajo

## Objetivo
Comparar el entrenador **teórico** asignado a cada sesión (fichero de planificación) con el entrenador **real** registrado (fichero de pagos/Skello) para identificar discrepancias desde el 1 de enero de 2026.

---

## Fuente 1 – Planificación teórica
**Google Sheet:** `1COqOZLAQNO437dPZgQpBWsgjreI-FJlbPDfdwHPeDcA`  
**Pestaña:** New info teams

| Columna | Contenido |
|---------|-----------|
| D | Team (nombre del equipo) |
| E | Skello name (nombre del equipo tal como aparece en Skello) |
| AB | ID Coach 1 (entrenador teórico principal) |

### Respuestas confirmadas – Fuente 1
- Solo se analiza **ID Coach 1** (columna AB). Ignorar Coach 2, 3…
- El día de la semana y hora para equipos academy están **codificados en el nombre del equipo**. Ejemplos: "Mo16" = Monday 16h, "Tu16" = Tuesday 16h. Prefijos: Mo=Monday, Tu=Tuesday, We=Wednesday, Th=Thursday, Fr=Friday, Sa=Saturday.
- Columna E (Skello name) debería coincidir con col. H del fichero 2, pero puede haber casos puntuales que no. Gestionar log de no-mapeados.
- No debe haber filas duplicadas por equipo.

---

## Fuente 2 – Sesiones reales (pagos / Skello)
**Google Sheet:** `1uGuXupAHufEPX1BnmZmY_r3PbGnHlpVot8i6a6Y2g_g`  
**Pestaña:** Data (única pestaña a analizar)  
**Rango temporal:** desde 01/01/2026

| Columna | Contenido |
|---------|-----------|
| F | Fecha de la sesión (de aquí se deduce el día de la semana) |
| H | Sesión (nombre del equipo) |
| J | Start (hora de inicio) |
| S | Status (excluir filas con "No clock in") |
| U | ID entrenador real |

### Respuestas confirmadas – Fuente 2
- Columna F = fecha → deducir día de la semana para mapeo academy.
- Columna J = hora de inicio → segundo eje del mapeo academy.
- Columna S = Status → **excluir** cualquier fila con valor "No clock in".
- **Solo analizar** sesiones de tipo Academy, Select y GK, de **lunes a sábado**.
- Solo pestaña **Data**.

---

## Lógica de mapeo

### Equipos SELECT
```
Fichero 1 col. E (Skello name)  <-->  Fichero 2 col. H (Sesión)
Fichero 1 col. AB (ID Coach 1)  <-->  Fichero 2 col. U (ID entrenador real)
```
Match directo por nombre. Discrepancia si IDs no coinciden.

### Equipos ACADEMY
```
Extraer de col. E (Skello name): prefijo día (Mo/Tu/We/Th/Fr/Sa) + número hora
Fichero 2: día_semana(col. F) + hora(col. J)  <-->  día+hora extraídos del nombre
Fichero 1 col. AB (ID Coach 1)  <-->  Fichero 2 col. U (ID entrenador real)
```
Match por día de la semana + hora de inicio. Discrepancia si IDs no coinciden.

### Equipos GK
Misma lógica que Academy o Select según cómo aparezca el nombre. Confirmar al ver datos.

---

## Output – Dashboard

### Estructura de filas (desplegable)
```
> Academy
    U8 Mo16 (Entrenador ref: Carlos García)
    U10 Tu18 (Entrenador ref: ...)
    ...
> Select
    U12 Select (Entrenador ref: ...)
    ...
> GK
    GK Mo17 (Entrenador ref: ...)
    ...
```

### Estructura de columnas
| Total asignado | Total otro | Ene 26 asig | Ene 26 otro | Feb 26 asig | Feb 26 otro | … |
|---|---|---|---|---|---|---|

### Tecnología
- **Python** (pandas + gspread) para extracción y reconciliación
- **HTML + vanilla JS** para el dashboard con filas expandibles
- Primero local → luego GitHub Pages

### Estado
- [x] Preguntas respondidas
- [ ] Acceso a Google Sheets verificado y datos extraídos
- [ ] Script de reconciliación implementado
- [ ] Dashboard HTML generado
- [ ] Publicado en GitHub
