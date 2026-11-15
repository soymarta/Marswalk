# Fuentes de datos del proyecto Marswalk

Inventario de las fuentes externas usadas para generar o justificar los datos que aparecen
en el visor, el planificador EVA y las panorámicas. Los archivos producidos dentro del
repositorio son derivados; cuando es posible se indica el archivo local y su fuente
original. Los enlaces de las tablas de datasets apuntan a descargas, APIs o archivos
oficiales; las publicaciones y páginas narrativas no se presentan como datasets.

## Datos y fuentes de NASA

### Mars 2020 / Perseverance

| Dataset o recurso | Uso en el proyecto | Enlace |
|---|---|---|
| MMGIS Mars 2020: traza del rover | `data/ruta/m20_traverse.geojson`, validación de rutas y posiciones de las paradas | [M20 traverse](https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json) |
| MMGIS Mars 2020: waypoints | `data/raw/M20_waypoints.json`, asociación de sol, site y drive para imágenes/panorámicas | [M20 waypoints](https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json) |
| API de imágenes raw de Mars 2020 | Descarga de imágenes Navcam/Mastcam-Z en `python/generar_panoramas.py` | [NASA Mars raw-images API](https://mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&feedtype=json) |
| Consulta paginada de imágenes raw | Plantilla exacta usada por el generador de panoramas, con cámara y rango de soles | [`raw_images` query template](https://mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&feedtype=json&num=100&page={page}&order=sol%20desc&search=%7C{cam}&condition_2={sol}:sol:gte&condition_3={sol}:sol:lte) |
| Datos SHERLOC de Mars 2020 | Resultados instrumentales asociados a Wildcat Ridge y otros puntos de muestreo | [SHERLOC PDS archive](https://pds-geosciences.wustl.edu/missions/mars2020/sherloc.htm) |
| Datos de muestras de Mars 2020 | Identificación de muestras Hazeltop/Bearwallow y operaciones de Perseverance | [Perseverance Analyst's Notebook](https://an.rsl.wustl.edu/m20) |
| Colección PDS de datos del depósito Three Forks | Identificación persistente y acceso a los datos del depósito | [Three Forks Data Collection](https://pds.nasa.gov/ds-view/pds/viewCollection.jsp?identifier=urn:nasa:pds:mars2020_sample_depot_three_forks:data) |
| Archivo PDS del depósito Three Forks | Registros y productos del depósito de tubos, soles 653–690 | [Three Forks PDS archive](https://pds-geosciences.wustl.edu/missions/mars2020/three_forks_depot.htm) |

### Datos de misión y modelos NASA usados en el cálculo corporal

Estas fuentes no son capas del mapa, pero sus medidas se usan para calibrar
`data/ruta/calibracion_metabolica.json` y el modelo de `js/ruta/eva.js`.

| Dataset o publicación | Uso | Enlace |
|---|---|---|
| Caminata de 10 km con traje MKIII en gravedad lunar | Punto de calibración de energía, VO₂ y O₂ | [NASA NTRS 20080014853](https://ntrs.nasa.gov/citations/20080014853) |
| Costes metabólicos de caminar con traje planetario | Costes de locomoción y pendiente | [NASA/TP-2010-216125, NTRS 20110003409](https://ntrs.nasa.gov/citations/20110003409) |
| Metabolismo y disipación térmica durante EVA Apollo | Consumo de O₂, agua y umbrales de refrigeración | [NASA SP-368, NTRS 19760005584](https://ntrs.nasa.gov/citations/19760005584) |
| Mars 2020 Terrain Relative Navigation, documentación de productos | Contexto de los productos CTX/HiRISE usados en Jezero | [NASA NTRS 20230000582](https://ntrs.nasa.gov/citations/20230000582) |

### MOLA y productos alojados por USGS

MOLA es un instrumento de NASA (Mars Global Surveyor), aunque los productos que
descarga el proyecto están distribuidos por USGS. Se listan también en la sección
de USGS para mantener la procedencia de descarga.

| Dataset | Uso | Enlace |
|---|---|---|
| Mars Orbiter Laser Altimeter global DEM, 463 m/px | `tiles/marte_xyz` y `tiles/color_xyz`, relieve/color global y relleno fuera de Jezero | [Descarga MOLA DEM 463 m (GeoTIFF)](https://planetarymaps.usgs.gov/mosaic/Mars_MGS_MOLA_DEM_mosaic_global_463m.tif) |

## Datos de otras agencias espaciales y socios

### USGS Astrogeology

| Dataset | Uso en el proyecto | Enlace |
|---|---|---|
| Mars 2020 TRN CTX DTM, `JEZ_ctx_B_soc_008` (20 m) | `data/ruta/jezero_dem.png`, `tiles/jezero_dem`, rejilla de ruta | [Descarga directa del CTX DTM](https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0.tif) |
| Catálogo de productos CTX de Mars 2020 TRN | Índice y metadatos del DTM CTX | [USGS Mars 2020 TRN CTX](https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/CTX/index.html) |
| Ortoimagen CTX `JEZ_ctx_B_soc_008` (6 m) | `tiles/jezero_orto`, textura del frente del delta | [Descarga directa de la ortoimagen CTX](https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0.tif) |
| DTM HiRISE de Mars 2020 TRN (1 m) | `data/terreno/pendiente.tif`, `rugosidad.tif`, `peligro.tif` y `confianza.tif` | [Descarga directa del DTM HiRISE](https://planetarymaps.usgs.gov/mosaic/mars2020_trn/HiRISE/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif) |
| Catálogo de productos HiRISE de Mars 2020 TRN | Índice de descarga de los productos HiRISE | [Índice de descarga HiRISE](https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/HiRISE/index.html) |
| Nomenclatura planetaria de Marte (Shapefile) | `data/mars_nomenclature.geojson` | [Descarga directa MARS nomenclature (ZIP)](https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MARS_nomenclature_center_pts.zip) |
| Nomenclatura planetaria de Marte (KML) | Formato alternativo del mismo inventario de nombres | [Descarga directa MARS nomenclature (KMZ)](https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MARS_nomenclature_center_pts.kmz) |

### Mars Climate Database / LMD

| Dataset | Uso | Enlace |
|---|---|---|
| MCD `dust_clim.nc`, variable `cdod` | `data/polvo_marte.geojson`, opacidad de polvo y regla provisional GO/NO-GO | [MCD dust climatology NetCDF](https://www-mars.lmd.jussieu.fr/mars/dust_scenarios/dataset/dust_clim.nc) |
| Mars Climate Database | Documentación del modelo climático que origina la climatología de polvo | [Mars Climate Database](https://www-mars.lmd.jussieu.fr/) |

### EMARS / reanálisis atmosférico

| Dataset | Uso | Enlace |
|---|---|---|
| ARCO-EMARS (`emars_combined.zarr`) | `data/datos_ambientales_marte.geojson`: temperatura, viento, presión y geopotencial | [ARCO-EMARS en Hugging Face](https://huggingface.co/datasets/ananyo01/ARCO-EMARS) |
| Identificador DOI de ARCO-EMARS | Referencia persistente del dataset | [DOI 10.57967/hf/8859](https://doi.org/10.57967/hf/8859) |

El reanálisis EMARS integra observaciones de instrumentos de distintas misiones
(por ejemplo TES, THEMIS y MCS), pero el proyecto consume el producto de
reanálisis ARCO-EMARS, no esos archivos instrumentales por separado.

### USGS / Viking MDIM y base de color opcional

Estas capas son opcionales: `js/main.js` las usa si existen y, si no, vuelve a
`tiles/color_xyz` generado a partir de MOLA.

| Dataset | Uso | Enlace |
|---|---|---|
| Viking MDIM21 color global, 232 m | `tiles/viking_xyz`, base de color real de Marte | [USGS Viking MDIM21 color mosaic](https://planetarymaps.usgs.gov/mosaic/Mars_Viking_MDIM21_ClrMosaic_global_232m.tif) |
| Viking MDIM21 color, prototipo 1 km | `data/viking_prototype/tiles/viking_1km_xyz`, prueba ligera de la base de color | [USGS Astrogeology 1 km Viking mosaic](https://astrogeology.usgs.gov/ckan/dataset/7131d503-cdc9-45a5-8f83-5126c0fd397e/resource/5ea881c6-01b3-41fa-a7af-42d2131b54f1/download/mars_viking_mdim21_clrmosaic_1km.jpg) |

### Mastcam-Z / ASU, MSSS y JPL-Caltech

| Dataset o recurso | Uso | Enlace |
|---|---|---|
| Colección de panorámicas 360° oficiales Mastcam-Z | `data/ruta/panoramas/panoramas.json` y panorámicas de Wildcat Ridge, Three Forks y Rockytop | [Colección Mastcam-Z 360](https://mastcamz.asu.edu/mastcam-zs-360-panorama-collection/) |
| Archivos L0 de las panorámicas | Descarga en `python/preparar_panoramas_oficiales.py` | [Wildcat Ridge](https://mcz-images.sese.asu.edu/Mastcam-Z_360_Wildcat_Ridge_Sols518-534_L0_natural.jpg), [Three Forks](https://mcz-images.sese.asu.edu/Mastcam-Z_360_Three_Forks_Depot_1_Sol670_L0_natural.jpg), [Rockytop](https://mcz-images.sese.asu.edu/Mastcam-Z_360_Rockytop_Scarp_Sols466-474_L0_natural_2x.jpg) |
| Productos PDS de Mastcam-Z | Datos instrumentales y productos de fotometría que respaldan las imágenes | [Mastcam-Z PDS archive](https://pds-geosciences.wustl.edu/missions/mars2020/m2020_mastcamz_photometry.htm) |

Crédito de las panorámicas: NASA/JPL-Caltech/ASU/MSSS; cita indicada por el
proyecto: Bell et al., LPSC 2025, resumen #1719.

### Referencias científicas no descargadas como datasets

La estratigrafía de Hawksbill Gap se usa como contexto científico, no como una capa
descargada por el código. La publicación original se conserva en `science/jezero-demo.md`
como referencia, pero no se mezcla con los enlaces finales de datasets de esta lista.

## Datos derivados y fuentes locales del repositorio

Estos archivos no son datasets externos adicionales: son productos generados o
curados a partir de las fuentes anteriores.

| Archivo local | Derivado de |
|---|---|
| `tiles/marte_xyz/` | MOLA global, Terrain-RGB |
| `tiles/color_xyz/` | MOLA global, color-relief |
| `tiles/jezero_dem/`, `data/ruta/jezero_dem.png` | CTX 20 m fundido con MOLA |
| `tiles/jezero_orto/` | Ortoimagen CTX 6 m |
| `data/terreno/*.tif` | DTM CTX 20 m y DTM HiRISE 1 m |
| `data/ruta/m20_traverse.geojson` | MMGIS Mars 2020 |
| `data/ruta/puntos_eva.json` | Catálogo provisional basado en posiciones MMGIS y fuentes científicas enlazadas por parada |
| `data/datos_ambientales_marte.geojson` | ARCO-EMARS |
| `data/polvo_marte.geojson` | Mars Climate Database |
| `data/mars_nomenclature.geojson` | USGS Gazetteer of Planetary Nomenclature |
| `data/ruta/panoramas/*.jpg` | Colección oficial Mastcam-Z o, en el script experimental, imágenes raw de NASA/JPL |
| `data/ruta/calibracion_metabolica.json` | Medidas de EVA NASA/NTRS y supuestos documentados en `docs/modelo_cuerpo.md` |

## Recursos de software, no datasets científicos

Se cargan desde CDN para ejecutar el visor, pero no son fuentes de datos
planetarios:

- [MapLibre GL JS](https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js)
- [maplibre-contour](https://unpkg.com/maplibre-contour@0.1.0/dist/index.min.js)
- [Pannellum](https://cdn.jsdelivr.net/npm/pannellum@2.5.6/build/)
- [Three.js](https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.min.js)
- [OpenMapTiles glyphs](https://fonts.openmaptiles.org/{fontstack}/{range}.pbf)
- [Roboto de Google Fonts](https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap)

## Fuentes mencionadas pero no consumidas directamente

`info.md` menciona MEDA, REMS, MARCI, MCS y RAD como posibles fuentes de
condiciones ambientales. La implementación actual no descarga esos datasets de
forma independiente: usa ARCO-EMARS, MCD y una climatología térmica tipo MEDA
como estimación. No deben presentarse como lecturas directas de esos
instrumentos.
