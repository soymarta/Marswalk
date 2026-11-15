# Marswalk: planificador de rutas EVA (módulo 5)

Responsable: Hani. Este documento explica qué hace el planificador, cómo está construido, de qué datos depende y
cómo se ha validado, incluidos sus límites.

## Qué resuelve

El reto *Interplanetary Survival Guide: Martian Map* pide un mapa integrado de varias misiones que ayude a un
astronauta a planificar y hacer una caminata (EVA) en Marte. El planificador hace eso en el cráter Jezero:

1. **Cómo llegar a pie.** Desde la base (hábitat) elige qué paradas científicas visitar, en qué orden y por dónde
   ir, para volver con reserva de oxígeno, batería, agua y tiempo.
2. **Tres opciones de ruta** (Segura, Equilibrada, Máxima ciencia) y una **recomendación explícita**: se parte de la
   más segura y solo se acepta más riesgo si compensa: (a) al menos una parada más y un 15 % más de valor científico
   con un 10 % de margen, o (b) la misma ciencia al menos 30 min y un 15 % antes, sin pendientes más fuertes y con
   un 15 % de margen (en una EVA el tiempo también es riesgo). Ahorrar unos minutos nunca justifica más riesgo.
3. **Inicio, fin y paradas propias**: «Cambiar» en la primera y la última fila, o «Añadir parada → Elegir en el
   mapa». El fin es un refugio (la base u otro): de él salen el margen de retorno y la ruta de emergencia.
4. **Navegación paso a paso** como en un mapa de uso diario: banner con la maniobra, flechas de giro sobre el
   terreno, cámara en tercera persona, llegada estimada, consumibles en tiempo real e **indicaciones de voz en
   inglés** (giros, avisos y llegadas; botón de silencio en la hoja inferior).
   Avisos durante el camino, una sola vez cada uno: tramos con pendiente, sombra, sin radio o con poco Sol 150 m
   antes (y resaltados sobre el terreno), su final («Radio con la base recuperada», «Vuelves al sol»), llegada a
   cada parada con la muestra a tomar, O₂ al 50 % y 30 %, batería al 30 %, margen de retorno bajo el 10 % y punto
   de no retorno.
5. **Imprevistos durante la EVA**: tormenta de polvo, consumibles al 40 %, alerta solar o "volver ya". La ruta se
   recalcula al instante desde la posición actual.
6. **Seguridad visible**: punto de no retorno o margen mínimo, tramos en sombra (Sol real), tramos sin radio directa
   con la base, pendientes cerca del límite, alcance seguro desde la base y dosis de radiación.

## Cómo se usa

```bash
python3 -m http.server 8000        # desde la raíz del repositorio
# abrir http://localhost:8000/mapa_marte.html#eva   (o pulsar «Ruta a pie en Jezero»)
```

- Panel izquierdo: puntos de paso, hora de salida (hora solar local), opciones de ruta, avisos y perfil de elevación.
- **Iniciar** abre la navegación; **Vista previa** sobrevuela la ruta.
- Botones redondos: capas (luz y sombras reales, pendiente, alcance seguro, sin radio, traza del rover), 2D/3D,
  norte y centrar.
- En navegación: pausa/velocidad (60×, 120×, 480×; el trabajo en las paradas va a ×6), barra de progreso
  arrastrable, silencio de la voz e imprevistos. `Espacio` pausa y `Esc` sale.
- «Editar el terreno»: mover la base o dibujar zonas prohibidas (el planificador las evita).
- `window.marswalk` expone el estado y las acciones para depurar o integrar.

## Arquitectura

```
js/ruta/
  ruta.js                 interfaz (panel, mapa, navegación, imprevistos, validación)
  planificador.worker.js  todo el cálculo, fuera del hilo de la página (3 workers, uno por perfil)
  busqueda.js             A*, Dijkstra, ALT, suavizado; versión JS de referencia
  kernel.js               puente con el núcleo WebAssembly
  ruta_kernel.wasm        núcleo compilado de wasm/ruta_kernel.c (12 kB)
  terreno.js              carga del DTM, pendiente de Horn, rugosidad, rejilla de búsqueda
  terreno3d.js            protocolo marsdem:// (DTM 20 m fundido con MOLA) y capas 3D
  eva.js                  modelo fisiológico y del traje, perfiles de riesgo
  marsTime.js             hora solar y posición del Sol (Mars24)
  perfil.js               gráfico de elevación y tiempo
  validacion.js           tramos de validación con la traza de Perseverance
python/preparar_terreno_jezero.py   datos de entrada (ver más abajo)
wasm/ruta_kernel.c, wasm/build.sh   núcleo C
```

No hay backend: la página es estática y el cálculo se hace en Web Workers con WebAssembly. Así la demo no depende
de un servidor y la replanificación es inmediata.

## Algoritmos

**Rejillas.** El DTM CTX de 20 m (1596 × 1512 celdas) se usa tal cual para los tramos finales. Para buscar se usa
una rejilla de 40 m que toma, en cada bloque de 2 × 2, la elevación media y la pendiente, rugosidad y peligro
**máximos** (conservador).

**Vecindad de 16 direcciones** (incluye saltos de caballo): rumbos cada ~26,6°, rutas menos en zigzag que con 8.
En los saltos de caballo se comprueban las dos celdas intermedias atravesadas.

**Coste de arista** (s equivalentes): tiempo de marcha × (0,5 + potencia metabólica / 800 W) × (1 + riesgo).
El riesgo crece con (pendiente / límite)⁴, con la rugosidad y con la capa de peligro. Pendientes por encima del
límite del perfil y peligro = 1 son intransitables. El modelo metabólico está tabulado por (rasante, rugosidad)
para no evaluar exponenciales en cada una de los ~10 M de aristas de un campo.

**Campo de vuelta a la base.** Un Dijkstra inverso desde la base da, para cada celda, el coste, el tiempo, la
energía metabólica y el calor necesarios para volver. Con él se calcula el margen de retorno en cada punto de la
ruta, el punto de no retorno y la ruta de emergencia (siguiendo el árbol del campo: coste nulo al pedirla).

**Tres aceleraciones exactas** (no cambian el resultado):
1. *Poda física*: ninguna celda a más de v_max · T_útil / 2 de la base puede formar parte de una EVA factible.
2. *ALT* (A*, Landmarks, Triangle inequality; Goldberg & Harrelson 2005): los campos de la base son hitos y dan
   cotas inferiores exactas `d(v,t) ≥ d(v→base) − d(t→base)`. El máximo de heurísticas consistentes es consistente,
   así que A* sigue siendo óptimo.
3. *Refinamiento exacto perezoso*: el optimizador de paradas usa costes de 40 m; los tramos que elige se recalculan
   a 20 m, se reinyectan y se re-optimiza hasta que el recorrido no cambia. Las cifras mostradas son siempre de 20 m.

**Selección y orden de paradas.** Programación dinámica exacta sobre subconjuntos (problema de orientación,
n ≤ 12): maximiza el valor científico con la EVA dentro de los límites de consumibles y la reserva del perfil, y
respeta las paradas fijadas. Si se replanifica a mitad de EVA, se suman los consumibles ya gastados.

**Suavizado.** Line-of-sight (string pulling): se unen vértices lejanos si el tramo recto es transitable y no cuesta
más de un 1 % sobre el camino original.

**Núcleo WebAssembly.** C sin libc compilado con clang a wasm32. Datos de celda intercalados (elevación, pendiente,
rugosidad, peligro en 16 bytes) y montículo 4-ario para reducir fallos de caché. Usa las mismas tablas que JS,
así que ambos motores dan las mismas rutas. Si el .wasm no carga, se usa JS automáticamente.

### Rendimiento (medido en Chrome, i5-10310U con GPU Intel UHD, limitado a 800 MHz por el modo ahorro)

| Qué | Antes | Ahora | Cómo |
|---|---|---|---|
| Primera ruta tras cargar la página | 15 s | ~9 s | workers que arrancan al importar el módulo; terreno decodificado una vez y copiado a los otros workers; caché exacta de pares (`data/ruta/cache_pares.json`) |
| Costes entre paradas (primer plan) | 2 s | 1 ms | caché exacta, invalidada por versión del terreno, traje y zonas |
| Replanificación / ruta de emergencia | — | 60-90 ms / ≈ 5 ms | campos de la base en caché y árbol del campo de vuelta |
| Navegación (fotogramas por segundo) | 1,6 | ~18 | calidad adaptativa (abajo) y capas de Explorar ocultas al navegar |

**Calidad adaptativa del 3D.** El terreno 3D de MapLibre es caro con la cámara en movimiento: en este equipo,
4 fps con terreno frente a 50 fps sin él, con la misma cámara inclinada (el coste está en el motor, no en el
planificador: probado quitando capas, marcadores, etiquetas, cielo y resolución). Durante la navegación y el
sobrevuelo se mide el ritmo de fotogramas y, si no llega a ~15 fps, se pasa a mapa inclinado (como la navegación
de los mapas de uso diario), con el sombreado reforzado y fondo de neblina de polvo. La decisión se recuerda en el
navegador; el botón 3D la anula. En equipos con GPU dedicada el 3D se mantiene.

## Modelo de la EVA

| Elemento | Modelo | Fuente |
|---|---|---|
| Velocidad | Tobler (1993) × 0,55 por el traje (≈ 0,77 m/s en llano) y reducción por rugosidad | Apolo: 0,7-1 m/s |
| Gasto metabólico | Pandolf (1977) + corrección de bajada de Santee (2003); carga y locomoción × 0,7 en 0,38 g; × 1,25 por el traje | Farley & McMahon 1992; Carr & Newman 2007 |
| Oxígeno | 1 L de O₂ por cada 20,1 kJ metabólicos; 1,429 g/L | fisiología estándar |
| Batería | 140 W de base + calefacción por debajo de −20 °C + 25 W en sombra | supuesto, editable |
| Agua | calor rechazado / 2,45 MJ/kg (sublimación) | supuesto, editable |
| Radiación | 0,64 mSv/día (RAD/MSL) + 5 % por la menor columna de aire de Jezero | Hassler et al. 2014 |
| Sol y hora local | Mars24 | Allison & McEwen 2000 |
| Sombras | trazado de rayos hacia el Sol sobre el DTM | propio |
| Radio con la base | línea de visión astronauta (2 m) – mástil (10 m) sobre el DTM | propio |

Valores por defecto del traje (panel «Traje y consumibles»): 1,2 kg de O₂, 2200 Wh, 4 kg de agua, 7 h, 10 kg de
carga, 75 kg de astronauta y 60 kg de traje.

## Datos

`python/preparar_terreno_jezero.py` (necesita `venv-marte` con rasterio; `make ruta`) descarga y genera:

| Salida | Fuente | Uso |
|---|---|---|
| `data/ruta/jezero_dem.png` | USGS Mars 2020 TRN CTX DTM 20 m (con el que aterrizó Perseverance) | rejilla del planificador (16 bits sin pérdida) |
| `tiles/jezero_dem/` z7-13 | el mismo DTM fundido con MOLA en un borde de 1 km | terreno 3D |
| `tiles/jezero_orto/` z7-14 | USGS CTX orthoMosaic 6 m (pancromática, con tinte) | imagen base |
| `data/ruta/m20_traverse.geojson` | NASA/JPL MMGIS Mars 2020 | traza real y validación |
| `data/ruta/puntos_eva.json` | posiciones de Perseverance por sol (provisional) | base y paradas |

Comprobación de georreferencia: en el punto de aterrizaje coinciden DTM (GDAL), teselas y rejilla a < 1 m, y difieren
2,7 m de la localización a bordo de Perseverance (−2569,9 m).

### Contrato con el módulo de terreno

GeoTIFF float32 de una banda en `data/terreno/`, en la rejilla exacta del DTM CTX (equirectangular, lat_ts = 0,
esfera IAU Mars 2000 R = 3 396 190 m, 20 m, 1596 × 1512, esquina NO x = 4 573 663,250853, y = 1 109 693,140188):

| Archivo | Unidad | Uso en el planificador |
|---|---|---|
| `pendiente.tif` | grados (Horn 3×3) | sustituye a la calculada en el navegador |
| `rugosidad.tif` | m (σ del residuo 5×5) | sustituye a la calculada |
| `peligro.tif` | fracción 0-1 (1 = prohibido); agregada a 20 m con el máximo | límite duro y penalización |
| `confianza.tif` | 0-1 (1 = verificado con HiRISE 1 m) | penaliza levemente lo no verificado |

No-data (NaN) en pendiente o peligro = intransitable. Fuera de la cobertura de HiRISE el peligro debe ser 0 y la
confianza 0, no NaN, para no prohibir terreno que solo se conoce a 20 m. Tras dejar los archivos:
`python python/preparar_terreno_jezero.py --solo-capas`.

## Validación con Perseverance

Se comparan nuestras rutas (coste de rover) con **105 conducciones reales de un solo sol** dentro del DTM. Los pesos
del coste de rover se calibraron con la mitad de las conducciones y los resultados son de la otra mitad (52).

| Métrica | Resultado |
|---|---|
| Terreno conducido por el rover que el modelo considera transitable | **100 %** (sin falsos «prohibido») |
| Conducciones reproducidas a menos de 50 m (2,5 celdas) | **96 %** |
| Separación media con la traza real | 15 m (línea recta: 12,5 m) |

Lectura honesta: a escala de un sol el rover conduce casi en línea recta (12 m de la recta, menos de una celda de
20 m). Un planificador de 20 m no puede mejorar a la recta por debajo de su propia resolución. El resultado útil es
que el mapa de transitabilidad no prohíbe nada que el rover cruzara y que las rutas están dentro de 2-3 celdas de la
real. Para afinar hace falta la capa de peligros de HiRISE de 1 m (módulo de terreno).

## Dependencias con el resto del equipo

| Módulo | Qué necesito | Estado |
|---|---|---|
| 2. Terreno (Hamza/Roberto) | `pendiente`, `rugosidad`, `peligro`, `confianza` en `data/terreno/` | en curso; el planificador ya funciona sin ellas |
| 2. Terreno (Roberto) | **Corregido en modo Explorar**: `main.js` recodifica en memoria las teselas MOLA −12000 a `mapbox` −10000 antes de dibujar curvas y etiquetas; el planificador conserva su decodificador −12000 | hecho |
| 3. Ciencia (Pablo) | sustituir `data/ruta/puntos_eva.json` (coordenadas, valor 1-10, minutos de trabajo y fichas) | provisional con posiciones reales del rover |
| 4. Ambiental (Paula) | exponer `window.marsConditions.en(lon, lat, utcMs)` → `{ tempMediaC, amplitudC, tau, vientoMs, tormentaSolar }` con el ciclo diurno de MEDA | uso polvo (MCD) y viento (EMARS) de `data/`; la temperatura es una climatología tipo MEDA |
| 1. Arquitectura (Roberto) | MapLibre pasa a 5.24.0 (necesario para cielo, anclaje de cámara y altura de iluminación); `main.js` solo añade `initRutaModule(map)` | hecho en esta rama |
| 6. Frontend (Marta) | la navegación paso a paso ya cubre el «modo astronauta»; coordinar estilos y vídeo | — |

## Caché de costes por pares

Los costes entre paradas son deterministas (mismo terreno, traje y paradas → mismos números), así que se guardan
sin aproximación: en el navegador (`localStorage`) y, para el escenario por defecto, en `data/ruta/cache_pares.json`,
que hace que la primera ruta salga ~2 s antes incluso en la primera visita. La clave es un hash del terreno
(`jezero_meta.json`, incluidas las capas del módulo de terreno), de las masas y la duración del traje y de las zonas
prohibidas: si algo cambia, la caché se ignora y se recalcula.

**Regenerar** (tras cambiar `puntos_eva.json`, la base o el traje por defecto): abrir `mapa_marte.html#eva`, esperar
a que salgan las tres rutas, ejecutar `marswalk.exportarCache()` en la consola y guardar el archivo descargado en
`data/ruta/cache_pares.json`. Sin regenerar no se rompe nada: la primera ruta solo tarda un poco más.

## Núcleo WebAssembly: compilar

```bash
sudo dnf install clang lld binaryen     # Fedora
make wasm                               # o wasm/build.sh → js/ruta/ruta_kernel.wasm
```
