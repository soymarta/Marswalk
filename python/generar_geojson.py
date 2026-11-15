import xarray as xr
import fsspec
import json
import numpy as np

# --- 1. Conectar con ARCO-EMARS ---
print("Conectando con ARCO-EMARS...")
fs = fsspec.filesystem("hf")
store = fs.get_mapper("datasets/ananyo01/ARCO-EMARS/emars_combined.zarr")
ds = xr.open_zarr(store, decode_times=False)
print(f"Dataset abierto. Dimensiones: {dict(ds.sizes)}")

# --- 2. Elegir un instante de tiempo ---
TIME_IDX = 0
ds_snap = ds.isel(time=TIME_IDX)
print(f"\n--- Instantánea time={TIME_IDX} ---")
print(f"Año marciano (MY): {ds_snap['anal_mean_MY'].values}")

# --- 3. Elegir nivel vertical ---
LEVEL_IDX = -1
print(f"Nivel pfull seleccionado: {ds_snap['pfull'].values[LEVEL_IDX]:.4f}")

# --- 4. Extraer variables ---
print("\nDescargando datos (solo el nivel e instante seleccionados)...")
temp_k      = ds_snap['anal_mean_T'].isel(pfull=LEVEL_IDX).compute().values
u_wind      = ds_snap['anal_mean_U'].isel(pfull=LEVEL_IDX).compute().values
v_wind      = ds_snap['anal_mean_V'].isel(pfull=LEVEL_IDX).compute().values
pressure_pa = ds_snap['anal_mean_ps'].compute().values
geopotential = ds_snap['anal_mean_Surface_geopotential'].compute().values

lat  = ds_snap['lat'].values
lon  = ds_snap['lon'].values
latu = ds_snap['latu'].values
lonv = ds_snap['lonv'].values

print(f"Formas → temp={temp_k.shape}, U={u_wind.shape}, V={v_wind.shape}, ps={pressure_pa.shape}, geopot={geopotential.shape}")
print(f"Rangos → temp=[{np.nanmin(temp_k):.1f}, {np.nanmax(temp_k):.1f}] K")
print(f"          ps=[{np.nanmin(pressure_pa):.1f}, {np.nanmax(pressure_pa):.1f}] Pa")
print(f"          |U|max={np.nanmax(np.abs(u_wind)):.1f}, |V|max={np.nanmax(np.abs(v_wind)):.1f} m/s")
print(f"          geopotential=[{np.nanmin(geopotential):.1f}, {np.nanmax(geopotential):.1f}] m²/s²")

# --- 5. Interpolar U y V a la rejilla de temperatura ---
u_da = xr.DataArray(u_wind, coords={'latu': latu, 'lon': lon}, dims=['latu', 'lon'])
v_da = xr.DataArray(v_wind, coords={'lat': lat, 'lonv': lonv}, dims=['lat', 'lonv'])

u_interp = u_da.interp(latu=lat, method='linear', kwargs={'fill_value': 'extrapolate'}).values

lonv_ext = np.append(lonv, 360.0)
v_ext = np.concatenate([v_wind, v_wind[:, :1]], axis=1)
v_da_ext = xr.DataArray(v_ext, coords={'lat': lat, 'lonv': lonv_ext}, dims=['lat', 'lonv'])
v_interp = v_da_ext.interp(lonv=lon, method='linear').values

print(f"Interpolación completada → U={u_interp.shape}, V={v_interp.shape}")

# --- 6. Calcular velocidad y dirección del viento ---
wind_speed = np.sqrt(u_interp**2 + v_interp**2)
wind_dir = (np.degrees(np.arctan2(-u_interp, -v_interp)) + 360) % 360

# --- 7. Generar el GeoJSON ---
print("\nGenerando GeoJSON...")
features = []
for i, lat_val in enumerate(lat):
    for j, lon_val in enumerate(lon):
        t_val = float(temp_k[i, j])
        if np.isnan(t_val):
            continue

        lon_norm = lon_val if lon_val <= 180 else lon_val - 360

        # Geopotencial: usar 0.0 si es NaN, y float() para JSON serializable
        g_val = geopotential[i, j]
        g_out = float(g_val) if not np.isnan(g_val) else 0.0

        feat = {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [float(lon_norm), float(lat_val)]
            },
            "properties": {
                "lat": float(lat_val),
                "lon": float(lon_norm),
                "tempK": t_val,
                "windSpeed": float(wind_speed[i, j]) if not np.isnan(wind_speed[i, j]) else 0.0,
                "windDir": float(wind_dir[i, j]) if not np.isnan(wind_dir[i, j]) else 0.0,
                "pressure": float(pressure_pa[i, j]) if not np.isnan(pressure_pa[i, j]) else 600.0,
                "geopotential": g_out,
                "dust": 0.5,
                "rad": 0.25
            }
        }
        features.append(feat)

geojson = {"type": "FeatureCollection", "features": features}

with open('./data/datos_ambientales_marte.geojson', 'w') as f:
    json.dump(geojson, f)

print(f"Archivo 'datos_ambientales_marte.geojson' generado con {len(features)} puntos.")