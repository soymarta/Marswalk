# Dependencias del planificador de rutas (módulo 5) con el resto del equipo

Rama: `rutas/planificador-eva`. El planificador **ya funciona sin ninguna de estas entregas**: todo lo que falta
tiene un valor provisional. Cada entrega mejora la precisión o el relato, y entra sin tocar código.

| # | Quién | Qué necesito | Formato / dónde | Estado | Bloquea |
|---|---|---|---|---|---|
| 1 | Hamza (terreno) | Capas de terreno en la rejilla del DTM CTX | `data/terreno/{pendiente,rugosidad,peligro}.tif` | **entregado e integrado** (rama `terreno-capas-ruta`) | no |
| 2 | Roberto (terreno) | Corregir la base de las teselas MOLA | `tiles/marte_xyz` o `js/main.js` | pendiente | no (afecta al modo Explorar) |
| 3 | Pablo (ciencia) | Paradas científicas reales y sus fichas | `data/ruta/puntos_eva.json` | provisional | no |
| 4 | Paula (ambiental) | Condiciones de superficie con ciclo diurno | `window.marsConditions.en(...)` | provisional | no |
| 5 | Roberto (arquitectura) | Aceptar MapLibre 5.24.0 y la integración en `main.js` | revisión del PR | hecho en la rama | no |
| 6 | Marta (frontend) | Coordinar estilo, vídeo y relato de la demo | — | — | no |

---

## 1. Hamza: capas de terreno

**Rejilla obligatoria** (idéntica al DTM `JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0.tif`):
equirectangular, `lat_ts = 0`, `lon_0 = 0`, esfera IAU Mars 2000 (R = 3 396 190 m), píxel 20 × 20 m,
1596 × 1512 px, esquina NO x = 4 573 663,250853 m, y = 1 109 693,140188 m. GeoTIFF float32, una banda, no-data NaN.

| Archivo | Unidad | Cómo se usa |
|---|---|---|
| `pendiente.tif` | grados, Horn 3×3 | sustituye a la pendiente calculada en el navegador |
| `rugosidad.tif` | m, σ del residuo respecto a un plano en 5×5 | sustituye a la rugosidad calculada |
| `peligro.tif` | fracción 0-1 de obstáculo, agregada a 20 m con el máximo | 1 = prohibido; < 1 penaliza |
| `confianza.tif` | 0-1 (1 = verificado con HiRISE 1 m, 0 = solo CTX) | penalización suave de lo no verificado |

**Estado:** entregadas `pendiente.tif`, `rugosidad.tif` y `peligro.tif` (HiRISE 1 m, umbral 30°, subceldas de 5 m)
e integradas en `rutas/planificador-eva`. Con ellas el 100 % del terreno que condujo Perseverance sigue siendo
transitable (ninguna falsa prohibición) y las rutas no cambian de forma sustancial.

`peligro.tif` tiene NaN en el 68 % de la rejilla (fuera de HiRISE). Para no prohibir ese terreno, la integración
usa la cobertura como confianza: fuera de HiRISE, peligro 0 y confianza 0 (penalización suave). Si Hamza entrega
un `confianza.tif` propio, se usa ese.

Detalles pendientes (no bloquean):
- `gdaldem slope` sobre la proyección equirectangular usa 20 m en x, pero a 18,4° N el píxel mide 18,97 m sobre el
  terreno: las pendientes este-oeste salen ~5 % bajas. Corrección: escalar el gradiente x por 1/cos(lat) o calcular
  la pendiente como en `js/ruta/terreno.js`. Afecta igual al umbral de 30° de HiRISE.
- Revisar la franja con ruido del suroeste que mencionó.

Parámetros actuales (umbral de 30° a 1 m y subceldas de 5 m): bien. La visibilidad de radio desde la base **no hace
falta**: el planificador la calcula para cualquier posición de la base (por defecto 77.42449 E, 18.45649 N).

Para integrar tras dejar los archivos:

```bash
source venv-marte/bin/activate
python python/preparar_terreno_jezero.py --solo-capas
```

El script comprueba la alineación (y reproyecta si hace falta), codifica las capas para el navegador
(`data/ruta/terreno_*.png`) y las registra en `data/ruta/jezero_meta.json`. Los `.tif` de `data/terreno/` sí se
versionan (excepción en `.gitignore`); los intermedios de HiRISE, no.

## 2. Roberto: error de 2000 m en las teselas MOLA

`tiles/marte_xyz` se generó con `rio rgbify --base-val -12000`, pero MapLibre espera la base −10000 para
`encoding: 'mapbox'`. Para no regenerar las 19 000 teselas ni cambiar el contrato del planificador, `main.js`
recodifica cada tile en memoria antes de entregarlo a MapLibre y a `maplibre-contour`. Resultado anterior:
**las curvas de nivel y sus etiquetas salían 2000 m más altas** (en el aterrizaje de Perseverance marcaban ≈ −560 m
en lugar de −2570 m).

La transformación resta 20 000 unidades Terrain-RGB (2 000 m) y deja la salida en la codificación estándar
`mapbox`; el planificador sigue leyendo las teselas originales con base −12000 mediante `marsdem://`.

La fuente de `maplibre-contour` se ejecuta en el hilo principal porque su versión 0.1.0 solo acepta `mapbox` o
`terrarium`; así se puede instalar el adaptador de lectura sin modificar la dependencia externa.

Opcional: el mosaico HiRISE de 25 cm de Jezero existe en USGS
(`mars2020_trn/HiRISE/JEZ_hirise_soc_006_orthoMosaic_25cm_...`), pero pesa 7,3 GB; la ortoimagen CTX de 6 m ya
está integrada.

## 3. Pablo: paradas científicas

`data/ruta/puntos_eva.json` tiene 7 paradas **provisionales** en posiciones reales de Perseverance (sol indicado en
cada una). La asociación sol ↔ lugar es aproximada. Por cada parada:

| Campo | Significado |
|---|---|
| `id`, `nombre`, `lon`, `lat` | identificador, nombre y posición (grados este, planetocéntrica) |
| `valor` | valor científico 1-10: el optimizador maximiza la suma |
| `trabajoMin` | minutos de trabajo en la parada |
| `obligatoria` | `true` si la EVA debe incluirla siempre |
| `que`, `porque`, `muestra`, `rover` | ficha que aparece al pulsar la parada |

Lo más importante para el jurado: que los **valores** reflejen prioridades científicas defendibles (biofirmas,
muestras de Mars Sample Return, cronología) y que las fichas cuenten el relato de la ruta.

Tras cambiar el archivo, regenerar la caché de rutas: abrir `mapa_marte.html#eva`, esperar a las tres rutas,
ejecutar `marswalk.exportarCache()` en la consola y guardar el JSON en `data/ruta/cache_pares.json`.

## 4. Paula: condiciones ambientales

Hoy el planificador lee del repositorio la opacidad de polvo (MCD) y el viento (EMARS) del punto más cercano a la
base, y usa una climatología diurna tipo MEDA para la temperatura (mínimo ≈ −85 °C al amanecer, máximo ≈ −19 °C a
las 14 h). Interfaz para sustituirlo, sin tocar el planificador:

```js
window.marsConditions = {
  // utcMs: instante de salida de la EVA
  async en(lon, lat, utcMs) {
    return { tempMediaC, amplitudC, tau, vientoMs, tormentaSolar };   // números; tormentaSolar booleano
  },
};
```

El planificador llama a esta interfaz con el `utcMs` de la fecha y hora de salida seleccionadas.
Si el usuario cambia cualquiera de las dos, vuelve a cargar las condiciones antes de recalcular la ruta;
la fuente mostrada conserva la referencia UTC usada.
`js/ambiental.js` expone el proveedor y espera a que sus capas terminen de cargar; la temperatura
es una climatología diurna tipo MEDA, mientras que polvo y viento proceden de los ficheros MCD/EMARS
incluidos en `data/`. No son lecturas en tiempo real.

`tau > 2` o viento > 30 m/s dan NO-GO; `tau > 1` o viento > 20 m/s, precaución. Nota: en
`data/datos_ambientales_marte.geojson` hay velocidades de viento de cientos de miles de m/s cerca de los polos
(probable error de unidades); el planificador las ignora.

## 5. Roberto: arquitectura

- MapLibre pasa de `^4.0` a **5.24.0** (fijada). Hace falta para el cielo, el anclaje de la cámara al terreno y la
  dirección real del Sol en el sombreado. El modo Explorar se ha probado con la nueva versión.
- `main.js` solo añade `initRutaModule(map)` al final; el planificador crea su propio DOM y sus capas.
- No hay backend: el cálculo corre en Web Workers con un núcleo WebAssembly (`js/ruta/ruta_kernel.wasm`, 12 kB,
  ya compilado). Para recompilar: `sudo dnf install clang lld binaryen && make wasm`.

## 6. Marta: frontend y demo

- La navegación paso a paso cubre el «modo astronauta»: banner de maniobra, flechas sobre el terreno, cámara en
  tercera persona y hoja inferior.
- Guion sugerido para el vídeo (90 s): abrir en «Ruta a pie en Jezero» → opciones y recomendación → Iniciar →
  «Tormenta de polvo» a mitad de camino → regreso automático → «Comparar con Perseverance».
- Atajos útiles: `mapa_marte.html#eva` abre directamente el planificador; `Espacio` pausa; `Esc` sale de la
  navegación.
