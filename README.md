# Guía de instalación y puesta en marcha rápida
## Inicio rápido (para ver el mapa ya generado)
Si solo quieres ver el mapa y las teselas ya están generadas (los directorios `tiles/` existen), solo necesitas Python 3 instalado. No hace falta instalar GDAL ni nada más.

```bash
# 1. Clonar o copiar el proyecto a tu máquina
cd /ruta/al/proyecto/marte

# 2. Arrancar el servidor HTTP
python3 -m http.server 8000

# 3. Abrir en el navegador
http://localhost:8000/mapa_marte.html
```

## Estructura del proyecto
El proyecto ha sido modularizado para separar el código frontend, los scripts de procesamiento y los datos:

```bash
/marte/
│
├── css/
│   └── style.css                 # Estilos visuales de la interfaz
│
├── js/
│   ├── main.js                   # Lógica del mapa base, topografía y marcadores
│   └── ambiental.js              # Módulo de capas ambientales, viento y cursor (Paula)
│
├── data/
│   ├── datos_ambientales_marte.geojson  # Datos EMARS (Temp, Presión, Viento)
│   ├── polvo_marte.geojson              # Datos MCD (Polvo)
│   └── mars_nomenclature.geojson        # Nomenclatura USGS
│
├── python/
│   ├── generar_geojson.py        # Script para generar datos EMARS
│   └── generar_polvo_mcd.py      # Script para generar datos de polvo MCD
│
├── tiles/
│   ├── color_xyz/                # Teselas de color topográfico (XYZ)
│   └── marte_xyz/                # Teselas DEM Terrain-RGB (XYZ)
│
├── mapa_marte.html               # Archivo de entrada (Visor)
├── Makefile                      # Automatización de GDAL
├── requirements.txt              # Dependencias de Python
├── setup.sh                      # Script de instalación automatizada
└── README.md                     
```

## Instalación completa (para regenerar las teselas desde cero)
Si necesitas reprocesar los datos (regenerar teselas, cambiar la paleta de colores, aumentar el zoom, etc.), necesitas instalar las herramientas geoespaciales y de Python.

Requisitos previos del sistema:
- Linux (probado en Ubuntu/Debian) o macOS con Homebrew

- Python 3.10+

- ~10 GB de espacio libre en disco para archivos intermedios

- ~8 GB de RAM recomendados para procesar el DEM global completo


## Automatización con Makefile

```bash
make          # procesa todo
make serve    # arranca el servidor
```

## Guía rápida para nuevos miembros del equipo
### Escenario A: "Solo quiero ver el mapa"
Requisitos: Python 3.

```bash
# 1. Copiar el proyecto (por ejemplo, desde un USB o git clone)
git clone <url-del-repo> marte
cd marte

# 2. Comprobar que las teselas existen
ls teselas_color_xyz/ teselas_marte_xyz/
# Deberías ver directorios 0/ 1/ 2/ 3/ 4/ 5/ 6/

# 3. Arrancar el servidor
python3 -m http.server 8000

# 4. Abrir en el navegador
#    http://localhost:8000/mapa_marte.html
```


### Escenario B: "Quiero modificar el HTML (colores, capas, puntos de interés)"
Requisitos: Python 3 + editor de texto.

Sigue los pasos del Escenario A, pero edita mapa_marte.html con tu editor favorito (VS Code, Vim, etc.). Los cambios se aplican al recargar el navegador con Ctrl+Shift+R.

### Escenario C: "Quiero regenerar las teselas (cambiar zoom, paleta, DEM)"
Requisitos: Linux/macOS, GDAL, Python 3.10+, ~10 GB de disco libre.

```bash
# 1. Instalar dependencias
./setup.sh
source venv-marte/bin/activate

# 2. Regenerar las teselas (ejemplo: aumentar zoom a 7)
gdal2tiles.py -p mercator -z 0-7 -w none --xyz mola_dem_color.tif tiles/color_xyz
gdal2tiles.py -p mercator -z 0-7 -w none --xyz mola_dem_rgb.tif tiles/marte_xyz

# 3. Servir
python3 -m http.server 8000
```

### Escenario D: "Quiero procesar todo desde el DEM original"
Requisitos: Los del Escenario C.

```bash
# 1. Instalar dependencias
./setup.sh
source venv-marte/bin/activate

# 2. Descargar el DEM original de USGS (~500 MB)
wget https://astrogeology.usgs.gov/.../Mars_MGS_MOLA_DEM_mosaic_global_463m.tif

# 3. Procesar todo y generar teselas
make all

# 4. Servir
make serve
```

### Escenario E: "Quiero el mapa en color real (mosaico Viking en vez de MOLA coloreado)"
El visor usa `tiles/viking_xyz` si existe y, si no, cae en `tiles/color_xyz`. Hay dos
caminos: probar la estética sin gastar disco o generar el mosaico completo.

```bash
# Opción rápida: prototipo a 1 km (~36 MB de descarga, ~420 MB de teselas)
make viking-prototype        # descarga, reproyecta y tesela en data/viking_prototype/
make serve                   # el visor detecta las teselas y lo indica en el panel

# Opción completa: mosaico 232 m (12,7 GB de descarga, ~75 min en total)
make viking-download         # reanudable si se corta
make viking-master           # 50 % → 463 m/px, ~3,2 GB (puedes borrar el original)
make viking-warp             # Web Mercator 32768², JPEG
make viking-tiles            # teselas en tiles/viking_xyz, zoom 0-7

# Si quieres recuperar los 12,7 GB del original (el master de 3,2 GB basta):
rm Mars_Viking_MDIM21_ClrMosaic_global_232m.tif
```

Tamaños medidos en esta máquina: master 3,0 GiB (3,19 GB), Web Mercator 103 MB,
teselas 1,4 GB (21.845 PNG, z0-7). Total mínimo sin el original: ~4,5 GB.

Con el mosaico en color real la leyenda deja de mostrar la rampa de elevación
(el color ya no codifica altura): la altura se lee en las curvas de nivel y el
sombreado. El resto de capas (DEM, condiciones ambientales, ruta EVA) no cambia.

## Regenerar datos ambientales (EMARS y MCD)
```bash
# Asegúrate de tener el entorno virtual activado
source venv-marte/bin/activate

# 1. Generar datos de EMARS (Temperatura, Presión, Viento, Geopotencial)
python python/generar_geojson.py

# 2. Generar datos de Polvo (MCD)
python python/generar_polvo_mcd.py

# Ambos scripts guardarán automáticamente los archivos .geojson resultantes dentro de la carpeta data/, que es donde el mapa web los busca.
```


## Solución de problemas comunes
| Síntoma | Causa probable | Solución |
|---|---|---|
| `command not found: gdalwarp` | GDAL no instalado | `sudo apt install gdal-bin` |
| Failed to fetch o capas vacías | HTML y datos en puertos distintos o ruta incorrecta | Servir todo desde el mismo puerto (`python3 -m http.server`) y verificar que los GeoJSON están en `data/`. |
| Teselas invertidas verticalmente | `gdal2tiles.py` genera TMS por defecto | Añadir `--xyz` al comando de teselado. |
| Mapa en negro | Codificación DEM incorrecta | Asegurar `encoding: 'mapbox'` en la configuración de `raster-dem` en `main.js`. |
| La capa ambiental (ej. Polvo) no aparece | Archivo GeoJSON no encontrado en `data/` | Revisar la consola (F12). El código usará datos sintéticos si falla, pero es mejor verificar la ruta. |
| `PROJ: proj_create_operations` | PROJ bloquea mezcla de cuerpos celestes | Anteponer `PROJ_IGNORE_CELESTIAL_BODY=YES` en comandos de GDAL. |


## Resumen ejecutivo
| Perfil | Necesita instalar | Comando para empezar |
|---|---|---|
| Solo ver el mapa | Python 3 | `python3 -m http.server 8000` |
| Editar el frontend | Python 3 + editor | `python3 -m http.server 8000` |
| Regenerar teselas | GDAL + Python + rio-rgbify | `./setup.sh && make all` |
| Actualizar clima/polvo | Python + xarray + netCDF4 | `./setup.sh && python python/generar_geojson.py` |
