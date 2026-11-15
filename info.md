# Marswalk Planner — Visor Topográfico y Ambiental de Marte

> [!info] Información del proyecto
> **Proyecto:** Marswalk Planner — Mapa interactivo de Marte y planificador de rutas EVA
> **Fuentes de datos:** MOLA (Mars Orbiter Laser Altimeter), EMARS (Reanálisis Atmosférico), MCD (Mars Climate Database), USGS Nomenclature
> **Misiones:** Mars Global Surveyor (NASA), Mars Express (ESA), Mars Reconnaissance Orbiter (NASA)
> **Motor cartográfico:** MapLibre GL JS
> **Última actualización:** 2026-11-08

---

## Tabla de contenidos

- [Descripción general](#-descripción-general)
- [Estructura del proyecto](#-estructura-del-proyecto)
- [Roles y módulos del equipo](#-roles-y-módulos-del-equipo)
- [Procedimiento paso a paso (Topografía)](#-procedimiento-paso-a-paso-topografía)
- [Procedimiento paso a paso (Datos Ambientales)](#-procedimiento-paso-a-paso-datos-ambientales)
- [El Planificador de Rutas (Marswalk)](#-el-planificador-de-rutas-marswalk)
- [Herramientas utilizadas](#️-herramientas-utilizadas)
- [Enlaces de interés](#-enlaces-de-interés)
- [Cómo expandir el proyecto](#-cómo-expandir-el-proyecto)
- [Problemas conocidos y soluciones](#-problemas-conocidos-y-soluciones)

---

## Descripción general

Este proyecto transforma Marte en un entorno web interactivo diseñado para la exploración y la planificación de misiones. No se limita a mostrar la topografía, sino que integra múltiples capas de datos científicos para simular las condiciones reales a las que se enfrentaría un astronauta en una caminata espacial (EVA).

El visor (desarrollado con MapLibre GL JS) permite:
1. **Explorar el terreno:** Topografía global mediante el DEM de MOLA, sombreado del relieve y curvas de nivel.
2. **Analizar el clima:** Capas ambientales dinámicas con datos de temperatura, presión, viento (con animación de partículas) y polvo atmosférico, generadas a partir de datos de reanálisis (EMARS) y modelos climáticos (MCD).
3. **Planificar rutas:** Un algoritmo de planificación que evalúa la pendiente del terreno y las condiciones meteorológicas actuales para trazar rutas seguras y eficientes entre puntos de interés científico.

El objetivo final es proporcionar una herramienta de apoyo a la decisión para futuras misiones tripuladas, validando la viabilidad de las rutas en función del riesgo ambiental.

---

## Estructura del proyecto

El proyecto ha sido modularizado para separar el frontend, los datos procesados y los scripts de generación.

```text
/marte/
│
├── css/
│   └── style.css                 # Estilos visuales de la interfaz y paneles
│
├── js/
│   ├── main.js                   # Lógica del mapa base, topografía y marcadores
│   └── ambiental.js              # Módulo de capas ambientales, viento, cursor y leyenda
│
├── data/
│   ├── datos_ambientales_marte.geojson  # Datos EMARS (Temperatura, Presión, Viento, Geopotencial)
│   ├── polvo_marte.geojson              # Datos MCD (Profundidad óptica de polvo)
│   └── mars_nomenclature.geojson        # Nomenclatura oficial de accidentes geográficos
│
├── python/
│   ├── generar_geojson.py        # Script para extraer y procesar datos de EMARS
│   └── generar_polvo_mcd.py      # Script para descargar y procesar datos del MCD
│
├── tiles/
│   ├── color_xyz/                # Teselas de color topográfico (XYZ)
│   └── marte_xyz/                # Teselas DEM Terrain-RGB (XYZ)
│
├── mapa_marte.html               # Archivo de entrada (Visor)
├── Makefile                      # Automatización del pipeline de GDAL y Python
├── requirements.txt              # Dependencias de Python
├── setup.sh                      # Script de instalación automatizada
└── README.md                     # Guía de instalación y uso rápido
```

## Roles y módulos del equipo
El desarrollo del proyecto se dividió en seis áreas interconectadas, documentadas en organizacion.md:

1. Arquitectura e Integración (Tech Lead): Definición de la pila técnica, contrato de datos, repositorio y API.

2. Terreno e Imágenes Orbitales: Adquisición y procesamiento del DEM de MOLA, generación de teselas y cálculo de pendientes/rugosidad para el planificador.

3. Ciencia y Puntos de Interés: Integración de datos geológicos (CRISM, THEMIS) y definición de los objetivos científicos (cráteres, deltas).

4. Condiciones Ambientales: Integración de datos de MEDA, REMS, MARCI, MCS y RAD para crear las capas climáticas y el indicador de seguridad "Go/No-Go".

5. Planificación de Rutas y Seguridad: Algoritmo de coste (A*/Dijkstra) que cruza la topografía con la meteorología para calcular rutas EVA seguras.

6. Frontend y Experiencia de Usuario: Interfaz de usuario, selector de capas, panel de condiciones y presentación final.

## Procedimiento paso a paso (Topografía)
### Fase 1: Obtención del DEM
El DEM global de MOLA (463 m/píxel) se descarga desde el USGS Astrogeology Science Center.

### Fase 2: Preprocesamiento con GDAL
Para que MapLibre pueda renderizar el terreno, el DEM original se procesa:

1. Reproyección a Web Mercator (EPSG:3857): Con gdalwarp (usando PROJ_IGNORE_CELESTIAL_BODY=YES).

2. Codificación Terrain-RGB: Con rio rgbify (base -12000, intervalo 0.1) para que MapLibre lo lea como fuente raster-dem.

3. Color-relief y Hillshade: Con gdaldem para generar el mapa base visual y el sombreado del relieve.

### Fase 3: Generación de Teselas
Se utiliza gdal2tiles.py para generar la pirámide de teselas (zoom 0-6) en formato XYZ, dividiendo los archivos .tif en imágenes pequeñas listas para la web.

### Procedimiento paso a paso (Datos Ambientales)
El módulo de condiciones ambientales (desarrollado en Python y JS) genera capas GeoJSON para el visor:

1. Datos de Reanálisis (EMARS): El script generar_geojson.py se conecta a la nube, extrae las variables de temperatura, viento, presión y geopotencial, las interpola y genera datos_ambientales_marte.geojson.

2. Modelo Climático (MCD): El script generar_polvo_mcd.py descarga el archivo NetCDF de la Mars Climate Database y extrae la opacidad de polvo (cdod) para generar polvo_marte.geojson.

3. Renderizado en el mapa: El módulo ambiental.js lee estos archivos y los dibuja como capas de calor (circle con gran radio y desenfoque) que se fusionan visualmente para crear un mapa continuo. Incluye animación de partículas para el viento.


###  El Planificador de Rutas (Marswalk)
El objetivo es trazar rutas entre puntos de interés científico evaluando la viabilidad en tiempo real:

- Coste del terreno: El algoritmo A* penaliza las pendientes pronunciadas y las zonas de alta rugosidad.

- Condiciones meteorológicas: La ruta se bloquea o se replanifica si la capa de polvo detecta una tormenta (τ > 2.0) o si el viento supera los límites de seguridad.

- Seguridad EVA: Cálculo del punto de no retorno, consumo de O₂ y batería, y retorno seguro al hábitat.

### Herramientas utilizadas
Herramienta	      Función
GDAL	            Reproyección, generación de teselas y procesamiento del DEM topográfico.
rio-rgbify	      Codificación de elevaciones en Terrain-RGB.
xarray / fsspec	  Lectura y procesamiento de datos de reanálisis atmosférico (EMARS) y archivos NetCDF (MCD).
MapLibre GL JS	  Motor de renderizado del visor web interactivo.
maplibre-contour	Generación dinámica de curvas de nivel en el navegador.
Python	          Servidor HTTP local y scripts de extracción de datos científicos.