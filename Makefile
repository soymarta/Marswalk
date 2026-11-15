# Makefile — Automatización del procesamiento del DEM de Marte
#
# Uso:
#   make all          → genera todo (color + DEM + teselas + datos ambientales)
#   make tiles        → solo genera las teselas topográficas
#   make data         → solo ejecuta los scripts de Python para regenerar datos
#   make serve        → arranca el servidor HTTP
#   make clean        → borra archivos intermedios (.tif)
#   make distclean    → borra todo lo generado (incluyendo teselas)

DEM_ORIGINAL := Mars_MGS_MOLA_DEM_mosaic_global_463m.tif
DEM_WEBMERC  := mola_dem_webmercator.tif
DEM_NONODATA := mola_dem_webmercator_nonodata.tif
DEM_RGB      := mola_dem_rgb.tif
DEM_COLOR    := mola_dem_color.tif
DEM_HILLSH   := mola_dem_hillshade.tif

# ─── Viking Colorized Global Mosaic 232m (mosaico en color real de Marte) ───
VIKING_URL      := https://planetarymaps.usgs.gov/mosaic/Mars_Viking_MDIM21_ClrMosaic_global_232m.tif
VIKING_ORIGINAL := Mars_Viking_MDIM21_ClrMosaic_global_232m.tif
# Master ligero: el original a 50 % (463 m/px, ~3,2 GB en vez de 12,7 GB).
# Se puede borrar el original tras generarlo y el resultado sigue siendo de sobra
# para teselas z0-7 (32768 px de ancho).
VIKING_MASTER     := viking_232m_half.tif
VIKING_MASTER_PCT := 50
VIKING_WEBMERC  := viking_webmercator.tif
VIKING_ZOOM_MAX := 7
# Resolución del ráster reproyectado. 256 px × 2^7 = 32768 px cubre toda la
# pirámide z0-7; pedir más solo produciría un archivo mayor que nadie consume.
VIKING_OUT_RES  := 32768

# Prototipo ligero: mismo mosaico a 1 km (~36 MB en vez de 12,7 GB).
# Sirve para validar colores y teselado antes de descargar el 232 m completo.
# El JPEG vive como «ancillary data» del dataset, no en planetarymaps.
VIKING_1KM_URL   := https://astrogeology.usgs.gov/ckan/dataset/7131d503-cdc9-45a5-8f83-5126c0fd397e/resource/5ea881c6-01b3-41fa-a7af-42d2131b54f1/download/mars_viking_mdim21_clrmosaic_1km.jpg
VIKING_PROTO_DIR := data/viking_prototype
VIKING_PROTO_SRC := $(VIKING_PROTO_DIR)/mars_viking_mdim21_clrmosaic_1km.jpg
VIKING_PROTO_VRT := $(VIKING_PROTO_DIR)/viking_1km_georef.vrt
VIKING_PROTO_TIF := $(VIKING_PROTO_DIR)/viking_1km_webmerc.tif
VIKING_PROTO_XYZ := $(VIKING_PROTO_DIR)/tiles/viking_1km_xyz
VIKING_PROTO_RES := 16384

ZOOM_MIN := 0
ZOOM_MAX := 6

.PHONY: all tiles data color dem serve clean distclean help ruta wasm viking-download viking-master viking-warp viking-tiles viking-prototype

help:
	@echo "Objetivos disponibles:"
	@echo "  all             — Procesa el DEM completo y regenera los datos ambientales"
	@echo "  tiles           — Genera las teselas XYZ en la carpeta tiles/"
	@echo "  data            — Ejecuta los scripts de Python para generar los GeoJSON"
	@echo "  color           — Genera el ráster coloreado (mola_dem_color.tif)"
	@echo "  dem             — Genera el DEM codificado como Terrain-RGB (mola_dem_rgb.tif)"
	@echo "  ruta            — Terreno de Jezero para el planificador EVA (DTM CTX 20 m, teselas 3D, ortoimagen, traza M20)"
	@echo "  wasm            — Compila el núcleo de búsqueda C → WebAssembly (requiere clang, lld y binaryen)"
	@echo "  viking-download — Descarga el mosaico en color real Viking 232m (~12,7 GB)"
	@echo "  viking-master   — Reduce el 232m a un master de 463 m/px (~3,2 GB)"
	@echo "  viking-warp     — Reproyecta el master a Web Mercator con compresión JPEG"
	@echo "  viking-tiles    — Genera teselas XYZ del mosaico Viking en color (tiles/viking_xyz, zoom 0-7)"
	@echo "  viking-prototype— Prueba ligera del mosaico Viking a 1 km (data/viking_prototype, zoom 0-6)"
	@echo "  serve           — Arranca el servidor HTTP en el puerto 8000"
	@echo "  clean           — Borra archivos intermedios (.tif)"
	@echo "  distclean       — Borra todo lo generado (incluye carpeta tiles/)"

all: color dem tiles data

# ─── Regeneración de datos ambientales (Python) ───
data:
	@echo "Generando datos ambientales con Python..."
	python python/generar_geojson.py
	python python/generar_polvo_mcd.py

# ─── Procesamiento del DEM con GDAL ───
$(DEM_WEBMERC): $(DEM_ORIGINAL)
	PROJ_IGNORE_CELESTIAL_BODY=YES gdalwarp -t_srs EPSG:3857 -r bilinear \
		$(DEM_ORIGINAL) $(DEM_WEBMERC)

$(DEM_NONODATA): $(DEM_WEBMERC)
	gdalwarp -dstnodata None -co TILED=YES -co COMPRESS=DEFLATE \
		$(DEM_WEBMERC) $(DEM_NONODATA)

dem: $(DEM_RGB)

$(DEM_RGB): $(DEM_NONODATA)
	rio rgbify $(DEM_NONODATA) $(DEM_RGB) --base-val -12000 --interval 0.1

color: $(DEM_COLOR)

$(DEM_COLOR): $(DEM_WEBMERC) colores_marte.txt
	gdaldem color-relief $(DEM_WEBMERC) colores_marte.txt $(DEM_COLOR) -alpha

# ─── Generación de teselas ───
tiles: $(DEM_COLOR) $(DEM_RGB)
	@echo "Generando teselas en la carpeta tiles/..."
	mkdir -p tiles/color_xyz tiles/marte_xyz
	gdal2tiles.py -p mercator -z $(ZOOM_MIN)-$(ZOOM_MAX) -w none --xyz \
		$(DEM_COLOR) tiles/color_xyz
	gdal2tiles.py -p mercator -z $(ZOOM_MIN)-$(ZOOM_MAX) -w none --xyz \
		$(DEM_RGB) tiles/marte_xyz

# ─── Planificador de rutas EVA (módulo 5) ───
ruta:
	python python/preparar_terreno_jezero.py

wasm:
	wasm/build.sh

# ─── Servidor y limpieza ───
serve:
	@echo "Abriendo servidor en http://localhost:8000"
	@echo "Abre http://localhost:8000/mapa_marte.html en el navegador"
	python3 -m http.server 8000

clean:
	rm -f $(DEM_WEBMERC) $(DEM_NONODATA) $(DEM_RGB) $(DEM_COLOR) $(DEM_HILLSH)

distclean: clean
	rm -rf tiles/color_xyz tiles/marte_xyz

# ─── Viking Colorized Global Mosaic 232m ────────────────────────────────────
# Mosaico en color real de Marte (Viking MDIM 2.1 coloreado, 232 m/px, 12,7 GB).
# Sustituye tiles/color_xyz por tiles/viking_xyz: colores naturales de la
# superficie marciana en lugar del degradado topográfico de MOLA.
# El DEM (tiles/marte_xyz) y el modo astronauta (Jezero) no se ven afectados.
#
# Tiempo estimado en esta máquina (4 núcleos, ~6 MB/s de bajada):
#   viking-download:  ~35 min   (12,7 GB, reanudable con curl -C -)
#   viking-master:    ~3 min    (50 % → 46080×23040 px, ~3,2 GB)
#   viking-warp:      ~10 min   (gdalwarp multithread, salida 32768²)
#   viking-tiles:     ~25 min   (gdal2tiles z0-7, 4 procesos)
#   TOTAL:            ~73 min
#
# Notas:
#   * No ejecutar durante la demo: las teselas antiguas (color_xyz) se mantienen.
#   * El visor usa 'viking_xyz' si está presente; si no, cae en 'color_xyz'.
#   * Para ahorrar disco: `rm $(VIKING_ORIGINAL)` tras viking-master (12,7 GB);
#     el master de 3,2 GB ya cubre toda la pirámide de teselas.
#   * Para probar la estética sin descargar 12,7 GB: make viking-prototype.

viking-download: $(VIKING_ORIGINAL)

# -C - reanuda una descarga cortada; -f evita guardar una página de error como
# si fuera el TIFF si el servidor responde 4xx/5xx.
$(VIKING_ORIGINAL):
	@echo "Descargando Viking 232m (~12,7 GB) desde USGS/S3 (reanudable)..."
	curl -fL --retry 3 --retry-delay 5 -C - --progress-bar -o $(VIKING_ORIGINAL) $(VIKING_URL)

viking-master: $(VIKING_MASTER)

# 50 % lineal del 232m = 463 m/px. Cubre las teselas z0-7 (32768 px) sin
# almacenar los 12,7 GB del original. Sin compresión para no perder color.
$(VIKING_MASTER): $(VIKING_ORIGINAL)
	@echo "Reduciendo Viking 232m al $(VIKING_MASTER_PCT) % ($(VIKING_MASTER), ~3,2 GB)..."
	gdal_translate -q \
		-outsize $(VIKING_MASTER_PCT)% $(VIKING_MASTER_PCT)% \
		-r average \
		-co TILED=YES -co BIGTIFF=YES -co COMPRESS=NONE \
		$(VIKING_ORIGINAL) $(VIKING_MASTER)

viking-warp: $(VIKING_WEBMERC)

# -ts acota la salida a lo que consumen las teselas z0-7 (32768 px) y -r lanczos
# promedia al reducir: bilinear se salta píxeles y pierde detalle.
# -overwrite permite repetir el objetivo sin borrar el archivo a mano.
$(VIKING_WEBMERC): $(VIKING_MASTER)
	@echo "Reproyectando Viking → Web Mercator ($(VIKING_OUT_RES)², JPEG)..."
	PROJ_IGNORE_CELESTIAL_BODY=YES gdalwarp -overwrite \
		-t_srs EPSG:3857 \
		-te -20037508.34 -20037508.34 20037508.34 20037508.34 \
		-ts $(VIKING_OUT_RES) $(VIKING_OUT_RES) \
		-r lanczos \
		-multi -wo NUM_THREADS=ALL_CPUS \
		-co TILED=YES -co BIGTIFF=YES -co COMPRESS=JPEG -co PHOTOMETRIC=YCBCR \
		$(VIKING_MASTER) $(VIKING_WEBMERC)

viking-tiles: $(VIKING_WEBMERC)
	@echo "Generando teselas Viking en tiles/viking_xyz (zoom 0-$(VIKING_ZOOM_MAX))..."
	mkdir -p tiles/viking_xyz
	gdal2tiles.py -p mercator -z $(ZOOM_MIN)-$(VIKING_ZOOM_MAX) -w none --xyz \
		--processes=4 \
		$(VIKING_WEBMERC) tiles/viking_xyz

# ─── Prototipo Viking 1 km (sin descargar el mosaico completo) ──────────────
# El JPEG de USGS no trae georreferencia: el VRT la añade con el globo marciano
# exacto (2π·3396190 m de circunferencia → 21339 px de ancho a 1000 m/px).
# Mismo esquema que el 232 m, así el visor y el resto del Makefile no cambian.
viking-prototype: $(VIKING_PROTO_XYZ)

$(VIKING_PROTO_SRC):
	@echo "Descargando Viking 1 km (~36 MB) desde USGS/S3..."
	mkdir -p $(VIKING_PROTO_DIR)
	curl -fL --retry 3 --retry-delay 5 -C - --progress-bar -o $@ $(VIKING_1KM_URL)

$(VIKING_PROTO_VRT): $(VIKING_PROTO_SRC)
	gdal_translate -q -of VRT \
		-a_srs "+proj=eqc +lat_ts=0 +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 +a=3396190 +b=3396190 +units=m +no_defs" \
		-a_ullr -10669486.5 5334743.25 10669486.5 -5334743.25 \
		$(VIKING_PROTO_SRC) $@

$(VIKING_PROTO_TIF): $(VIKING_PROTO_VRT)
	@echo "Reproyectando Viking 1 km → Web Mercator ($(VIKING_PROTO_RES)², JPEG)..."
	PROJ_IGNORE_CELESTIAL_BODY=YES gdalwarp -overwrite \
		-t_srs EPSG:3857 \
		-te -20037508.34 -20037508.34 20037508.34 20037508.34 \
		-ts $(VIKING_PROTO_RES) $(VIKING_PROTO_RES) \
		-r lanczos \
		-multi -wo NUM_THREADS=ALL_CPUS \
		-co TILED=YES -co COMPRESS=JPEG -co PHOTOMETRIC=YCBCR \
		$(VIKING_PROTO_VRT) $(VIKING_PROTO_TIF)

$(VIKING_PROTO_XYZ): $(VIKING_PROTO_TIF)
	@echo "Generando teselas del prototipo en $(VIKING_PROTO_XYZ) (zoom 0-$(ZOOM_MAX))..."
	mkdir -p $@
	gdal2tiles.py -p mercator -z $(ZOOM_MIN)-$(ZOOM_MAX) -w none --xyz \
		--processes=4 \
		$(VIKING_PROTO_TIF) $@