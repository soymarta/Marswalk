"""
Capas de terreno para el planificador de rutas (contrato de Hani).

Genera en data/terreno/, sobre la rejilla exacta del DTM CTX de Mars 2020
(20 m, 1596 x 1512 px, equirectangular, esfera IAU Mars 2000):

  pendiente.tif  grados (0-90), Horn 3x3 (gdaldem slope), con la escala
                 este-oeste corregida por la latitud (ver escala_x)
  rugosidad.tif  metros, desviación típica del residuo respecto a un plano
                 ajustado en ventana 5x5 (100 m)
  peligro.tif    fracción de área de obstáculo 0-1 (1 = prohibido),
                 a partir del DTM HiRISE de 1 m
  confianza.tif  1 = verificado con HiRISE 1 m, 0.5 = solo CTX 20 m,
                 0 = sin datos

Todas: 1 banda float32, no-data = NaN, formato COG.

Uso (con el entorno venv-marte activado y GDAL instalado):
  python python/generar_capas_ruta_jezero.py --ctx RUTA_DTM_CTX.tif [--hirise RUTA_DTM_HIRISE.tif]

Datos de entrada (USGS, Mars 2020 Terrain Relative Navigation):
  CTX:    JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0.tif
  HiRISE: JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif
"""
import argparse
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import rasterio
from scipy import ndimage

# --- Parámetros de la capa de peligro (ajustables con Hani) ---
UMBRAL_OBSTACULO_GRADOS = 30.0  # pendiente a 1 m a partir de la cual un píxel es obstáculo
CELDA_INTERMEDIA_M = 5          # la fracción de área se mide en subceldas de 5 m
VENTANA_RUGOSIDAD = 5           # 5 x 5 píxeles de 20 m = 100 m


def run(*cmd):
    subprocess.run([str(c) for c in cmd], check=True)


def guardar_cog(ruta, datos, perfil_ref):
    """Guarda un array float32 como COG con no-data NaN."""
    perfil = dict(
        driver="GTiff", dtype="float32", count=1, nodata=float("nan"),
        width=perfil_ref["width"], height=perfil_ref["height"],
        crs=perfil_ref["crs"], transform=perfil_ref["transform"],
    )
    with tempfile.TemporaryDirectory() as tmp:
        plano = Path(tmp) / "plano.tif"
        with rasterio.open(plano, "w", **perfil) as dst:
            dst.write(datos.astype("float32"), 1)
        run("gdal_translate", "-q", "-of", "COG", "-co", "COMPRESS=DEFLATE",
            "-co", "PREDICTOR=3", plano, ruta)


def leer(ruta):
    """Lee la banda 1 como float64 con el no-data convertido a NaN."""
    with rasterio.open(ruta) as src:
        datos = src.read(1).astype("float64")
        if src.nodata is not None and not np.isnan(src.nodata):
            datos[datos == src.nodata] = np.nan
        return datos, src.profile


def escala_x(ruta):
    """Metros reales por cada metro de mapa en dirección este-oeste.

    La proyección es equirectangular con lat_ts = 0, así que el eje x está
    estirado: a la latitud de Jezero (18,5° N) un píxel de 20 m mide en realidad
    20 * cos(lat) = 18,97 m. Sin esta corrección las pendientes este-oeste
    salen un ~5 % bajas. Se usa la latitud del centro del ráster (dentro de la
    rejilla el factor varía menos de un 0,2 %).
    """
    with rasterio.open(ruta) as src:
        b = src.bounds
        radio = src.crs.to_dict().get("R") or src.crs.to_dict().get("a")
    return float(np.cos((b.top + b.bottom) / 2 / radio))


def gdaldem_pendiente(entrada, salida, *extra):
    run("gdaldem", "slope", "-q", "-alg", "Horn",
        "-xscale", escala_x(entrada), "-yscale", 1, *extra, entrada, salida)


def pendiente(ctx, salida, tmp):
    bruto = Path(tmp) / "pendiente_bruta.tif"
    gdaldem_pendiente(ctx, bruto)
    datos, perfil = leer(bruto)
    guardar_cog(salida, datos, perfil)


def rugosidad(ctx, salida):
    """Desviación típica del residuo respecto a un plano ajustado en ventana n x n.

    Con coordenadas centradas (x, y en -2..2) el ajuste por mínimos cuadrados es
    separable: a = media(z), b = sum(x z)/Sxx, c = sum(y z)/Syy, y
    SS_residuo = sum(z^2) - n a^2 - b^2 Sxx - c^2 Syy.
    """
    z, perfil = leer(ctx)
    z = z - np.nanmean(z)  # mejora la precisión numérica; no cambia el residuo
    n = VENTANA_RUGOSIDAD
    r = n // 2
    eje = np.arange(-r, r + 1, dtype="float64")
    kx = np.tile(eje, (n, 1))        # x crece por columnas
    ky = kx.T                        # y crece por filas
    unos = np.ones((n, n))
    N = n * n
    Sxx = float((kx ** 2).sum())

    conv = lambda a, k: ndimage.correlate(a, k, mode="constant", cval=np.nan)
    s_z = conv(z, unos)
    s_zz = conv(z * z, unos)
    s_xz = conv(z, kx)
    s_yz = conv(z, ky)

    ss = s_zz - s_z ** 2 / N - s_xz ** 2 / Sxx - s_yz ** 2 / Sxx
    rug = np.sqrt(np.clip(ss, 0, None) / N)  # NaN donde la ventana no está completa
    guardar_cog(salida, rug, perfil)


def peligro(ctx, hirise, salida, tmp):
    """Fracción de área de obstáculo por celda de 20 m, a partir del DTM de 1 m.

    1. Pendiente Horn a 1 m.
    2. Obstáculo = píxel de 1 m con pendiente > umbral (escarpes, bloques, caras de duna).
    3. Fracción de obstáculo en subceldas de 5 m alineadas con la rejilla CTX (media).
    4. Celda de 20 m = MÁXIMO de sus subceldas, para que un obstáculo pequeño no desaparezca.
    Fuera de la cobertura de HiRISE queda NaN.
    """
    tmp = Path(tmp)
    with rasterio.open(ctx) as src:
        perfil = src.profile
        b = src.bounds
    extension = [b.left, b.bottom, b.right, b.top]

    pend1m = tmp / "pendiente_1m.tif"
    gdaldem_pendiente(hirise, pend1m, "-co", "COMPRESS=DEFLATE",
                      "-co", "TILED=YES", "-co", "BIGTIFF=YES")

    mascara = tmp / "obstaculo_1m.tif"
    with rasterio.open(pend1m) as src:
        p = src.profile.copy()
        p.update(dtype="uint8", nodata=255, compress="deflate", tiled=True, bigtiff="YES")
        with rasterio.open(mascara, "w", **p) as dst:
            for _, ventana in src.block_windows(1):
                s = src.read(1, window=ventana)
                m = (s > UMBRAL_OBSTACULO_GRADOS).astype("uint8")
                m[(s == src.nodata) | np.isnan(s)] = 255
                dst.write(m, 1, window=ventana)

    fraccion = tmp / "fraccion_5m.tif"
    run("gdalwarp", "-q", "-overwrite", "-r", "average", "-ot", "Float32", "-dstnodata", "nan",
        "-te", *extension, "-tr", CELDA_INTERMEDIA_M, CELDA_INTERMEDIA_M,
        "-co", "COMPRESS=DEFLATE", mascara, fraccion)

    final = tmp / "peligro_20m.tif"
    run("gdalwarp", "-q", "-overwrite", "-r", "max", "-ot", "Float32", "-dstnodata", "nan",
        "-te", *extension, "-tr", 20, 20, fraccion, final)

    datos, _ = leer(final)
    guardar_cog(salida, np.clip(datos, 0, 1), perfil)


def confianza(ctx, peligro_tif, salida):
    """1 donde hay peligro medido con HiRISE, 0.5 donde solo hay CTX, 0 sin datos."""
    z, perfil = leer(ctx)
    conf = np.where(np.isnan(z), 0.0, 0.5)
    if Path(peligro_tif).exists():
        p, _ = leer(peligro_tif)
        conf[~np.isnan(p)] = 1.0
    guardar_cog(salida, conf, perfil)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ctx", required=True, help="DTM CTX de 20 m (plantilla de la rejilla)")
    ap.add_argument("--hirise", help="DTM HiRISE de 1 m (necesario para peligro.tif)")
    ap.add_argument("--salida", default="data/terreno", help="carpeta de salida")
    ap.add_argument("--tmp", help="carpeta para intermedios (se conservan); por defecto, temporal")
    args = ap.parse_args()

    out = Path(args.salida)
    out.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp_auto:
        tmp = args.tmp or tmp_auto
        Path(tmp).mkdir(parents=True, exist_ok=True)
        print("pendiente.tif ...")
        pendiente(args.ctx, out / "pendiente.tif", tmp)
        print("rugosidad.tif ...")
        rugosidad(args.ctx, out / "rugosidad.tif")
        if args.hirise:
            print("peligro.tif ... (tarda unos minutos)")
            peligro(args.ctx, args.hirise, out / "peligro.tif", tmp)
        print("confianza.tif ...")
        confianza(args.ctx, out / "peligro.tif", out / "confianza.tif")
    print("Hecho:", out)
