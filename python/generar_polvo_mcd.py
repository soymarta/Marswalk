import xarray as xr
import json
import numpy as np
import urllib.request
import os

# --- 1. Descargar el archivo de escenario de polvo del MCD si no existe ---
url = "https://www-mars.lmd.jussieu.fr/mars/dust_scenarios/dataset/dust_clim.nc"
filepath = "./data/dust_clim.nc"

if not os.path.exists(filepath):
    print("Descargando dust_clim.nc desde el MCD...")
    urllib.request.urlretrieve(url, filepath)
    print("Descarga completada.")
else:
    print("El archivo dust_clim.nc ya existe.")

# --- 2. Abrir el NetCDF ---
ds = xr.open_dataset(filepath, decode_times=False)

# --- 3. Extraer la variable 'cdod' (column dust optical depth) ---
# Seleccionamos el primer paso temporal (Time=0)
print("Extrayendo datos de polvo (cdod)...")
dust_da = ds['cdod'].isel(Time=0)

lat = ds['latitude'].values
lon = ds['longitude'].values

dust_values = dust_da.values

print(f"Dimensiones de la rejilla de polvo: {dust_values.shape}")
print(f"Rango de valores de polvo (τ): {np.nanmin(dust_values):.2f} - {np.nanmax(dust_values):.2f}")

# --- 4. Generar el GeoJSON ---
print("\nGenerando GeoJSON de polvo...")
features = []
for i, lat_val in enumerate(lat):
    for j, lon_val in enumerate(lon):
        dust_val = float(dust_values[i, j])
        if np.isnan(dust_val):
            continue

        # Normalizar longitud a [-180, 180] (por si acaso)
        lon_norm = lon_val if lon_val <= 180 else lon_val - 360

        feat = {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [float(lon_norm), float(lat_val)]
            },
            "properties": {
                "lat": float(lat_val),
                "lon": float(lon_norm),
                "dust": dust_val
            }
        }
        features.append(feat)

geojson = {"type": "FeatureCollection", "features": features}

with open('./data/polvo_marte.geojson', 'w') as f:
    json.dump(geojson, f)

print(f"Archivo 'polvo_marte.geojson' generado con {len(features)} puntos.")