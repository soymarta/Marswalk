# Equipos

Cada equipo tiene **un objetivo**, entregables medibles e interfaces claras. Los agentes se
comunican entre equipos con la skill `team-work` (issues de GitHub + vigilante en segundo plano).
Los nombres de equipo de abajo son los que van en `to:` / `from:`.

Esto parte de `organización.md`. Editadlo: si un objetivo está borroso, hay que afinarlo aquí antes de
construir.

> Plantilla para un equipo nuevo: copiad un bloque y rellenad los cinco campos.

---

## architecture
- **Personas:** Roberto
- **Objetivo:** que todas las piezas encajen y se puedan desplegar: contrato de datos fijado y API de capas funcionando de extremo a extremo.
- **Entregables:** repo y despliegue; contrato de datos (CRS IAU Mars 2000, COG/teselas, GeoJSON); API `/layers`, `/route`, `/conditions`.
- **Da:** contrato de datos y API a todos.
- **Necesita:** de cada equipo, sus capas y su salida en el formato del contrato.
- **Hecho cuando:** un usuario abre la app desplegada y ve mapa, capas, ruta y panel funcionando juntos.

## terrain
- **Personas:** Roberto
- **Objetivo:** el mejor terreno e imagen base posible de Jezero y las capas derivadas para planificar.
- **Entregables:** teselas de MOLA/HRSC/CTX/HiRISE DTM; pendiente, rugosidad, orientación (y densidad de rocas si hay tiempo).
- **Da:** a `route` la cuadrícula de pendiente y rugosidad; a `frontend` las teselas.
- **Necesita:** de `architecture` el CRS y el formato acordados.
- **Hecho cuando:** `route` calcula costes sobre sus rasters y `frontend` los pinta sin reproyectar.

## science
- **Personas:** Pablo
- **Alias del agente de presentación:** Lobo de NASA Space Apps (firma opcional; en `to:` / `from:` usa `science`).
- **Objetivo:** el relato científico de la ruta: por qué cada parada importa.
- **Entregables:** capas de mineralogía (CRISM) e inercia térmica (THEMIS); 5–10 puntos de interés con ficha (qué hay, por qué importa, qué muestra, qué dijo el rover); guion de la ruta.
- **Da:** a `route` la lista de POIs con coordenadas y prioridad científica; a `frontend` las fichas y el relato. En `data/ruta/puntos_eva.json`, Ciencia añade `fuentes` (URLs) y `precisionUbicacion` (texto); los IDs y campos que usa el planificador no cambian.
- **Necesita:** de `terrain` la imagen base para validar posiciones.
- **Hecho cuando:** cada POI tiene ficha completa y coordenadas verificadas sobre el terreno.

## conditions
- **Personas:** Paula
- **Objetivo:** que un astronauta sepa si puede salir hoy: panel de condiciones y decisión go / no-go.
- **Entregables:** series MEDA/REMS; contexto orbital (MARCI, MCS, RAD); hora solar, ángulo solar, ventanas de luz; indicador go/no-go con su regla explícita.
- **Da:** a `route` ventanas de luz y alertas; a `frontend` el estado actual y el ciclo diurno; a `architecture` el endpoint `/conditions`.
- **Necesita:** de `architecture` el formato del endpoint.
- **Hecho cuando:** `/conditions` devuelve estado, ciclo diurno y go/no-go reproducibles, con fuente y fecha de cada dato.

## route (alias: Hani-GO)
- **Personas:** Hani
- **Objetivo:** una ruta de EVA segura y justificable entre POIs que cumple distancia, tiempo, consumibles y retorno a la base.
- **Entregables:** algoritmo de coste (A*/Dijkstra) con restricciones; GeoJSON con perfil de elevación, tiempo por tramo y alertas; ruta alternativa de emergencia (opcional).
- **Da:** a `frontend` y `architecture` la ruta por `/route`.
- **Necesita:** de `terrain` pendiente/rugosidad; de `science` los POIs; de `conditions` ventanas de luz y alertas.
- **Hecho cuando:** dados dos POIs devuelve una ruta válida, explicable, que nunca rompe un límite y que vuelve al hábitat.

## frontend
- **Personas:** Marta
- **Objetivo:** una experiencia clara y convincente que el jurado entienda en 2 minutos.
- **Entregables:** mapa/globo 3D, selector de capas, fichas de POI, línea de tiempo de la EVA, panel de condiciones, modo astronauta; vídeo demo, diapositivas y texto del envío.
- **Da:** la demo y el pitch.
- **Necesita:** de todos los equipos sus datos por la API; de `science` el relato.
- **Hecho cuando:** la demo en vivo recorre una EVA completa sin tocar el código.

## hamza (alias: Hamza-GO)
- **Personas:** Hamza
- **Objetivo:** el mapa unificado de Jezero con sus capas de terreno y el modo astronauta, funcionando sobre los datos de `data/terreno/`.
- **Entregables:** capas de terreno de Jezero en `data/terreno/`; mapa unificado; modo astronauta (rama `modo-astronauta`).
- **Da:** a `frontend` y `route` las capas de terreno y la vista de astronauta.
- **Necesita:** de `route` la ruta en GeoJSON; de `terrain` el contrato de formatos, para no duplicar capas.
- **Hecho cuando:** el mapa unificado carga las capas de Jezero y el modo astronauta recorre una ruta real. *(Borrador: Hamza, afinad este objetivo y su solape con `terrain` y `frontend`.)*
