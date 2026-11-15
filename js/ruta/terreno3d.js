/**
 * @module terreno3d
 * @author Hani
 * @description Terreno 3D fundido para MapLibre mediante el protocolo `marsdem://{z}/{x}/{y}`:
 *  - z7-13 dentro de Jezero: teselas del DTM CTX de 20 m (tiles/jezero_dem, ya fundidas con MOLA en el borde);
 *  - resto: MOLA (tiles/marte_xyz) recodificado con la base correcta y, por encima de z6, remuestreado
 *    bilinealmente desde la tesela antecesora de z6 (sin escalones al hacer zoom).
 * Todas las teselas se sirven en la codificación estándar 'mapbox' (-10000 + v·0,1 m) con elevaciones reales.
 * Jezero queda a −2,5 km (−4 km con la exageración): MapLibre 5 solo recoloca la cámara sobre el terreno en
 * las interacciones del usuario, así que ruta.js llama a `anclarCamara` tras cada movimiento programado.
 */
export const DESPLAZAMIENTO_3D = 0;

const MOLA_BASE = -12000; // base con la que se generaron tiles/marte_xyz (rio rgbify)

function decodificar(px, base) {
    const n = px.length / 4, h = new Float32Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) h[i] = base + (px[p] * 65536 + px[p + 1] * 256 + px[p + 2]) * 0.1;
    return h;
}

async function pixeles(url, signal) {
    const resp = await fetch(url, { signal });
    if (!resp.ok) throw new Error(`${resp.status} ${url}`);
    const bmp = await createImageBitmap(await resp.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const c = new OffscreenCanvas(256, 256);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, 256, 256);
    return ctx.getImageData(0, 0, 256, 256).data;
}

async function codificar(alturas) {
    const c = new OffscreenCanvas(256, 256);
    const ctx = c.getContext('2d', { willReadFrequently: true });   // lienzo en CPU: codificar no espera a la GPU
    const img = ctx.createImageData(256, 256);
    const d = img.data;
    for (let i = 0, p = 0; i < alturas.length; i++, p += 4) {
        const v = Math.max(0, Math.round((alturas[i] + DESPLAZAMIENTO_3D + 10000) * 10));
        d[p] = (v >> 16) & 255; d[p + 1] = (v >> 8) & 255; d[p + 2] = v & 255; d[p + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return (await c.convertToBlob({ type: 'image/png' })).arrayBuffer();
}

const cacheMola = new Map();
async function alturasMola(z, x, y, signal) {
    const k = `${z}/${x}/${y}`;
    if (!cacheMola.has(k)) {
        cacheMola.set(k, pixeles(`tiles/marte_xyz/${k}.png`, signal).then(px => decodificar(px, MOLA_BASE)));
        if (cacheMola.size > 64) cacheMola.delete(cacheMola.keys().next().value);
    }
    try { return await cacheMola.get(k); } catch (e) { cacheMola.delete(k); throw e; }
}

/** Remuestreo bilineal de la sub-región (dx, dy) de una tesela antecesora ampliada f veces. */
export function remuestrear(src, f, dx, dy) {
    const out = new Float32Array(256 * 256);
    const tam = 256 / f, ox = dx * tam, oy = dy * tam;
    for (let j = 0; j < 256; j++) {
        const sy = Math.min(255, Math.max(0, oy + (j + 0.5) * tam / 256 - 0.5));
        const y0 = sy | 0, y1 = Math.min(255, y0 + 1), b = sy - y0;
        for (let i = 0; i < 256; i++) {
            const sx = Math.min(255, Math.max(0, ox + (i + 0.5) * tam / 256 - 0.5));
            const x0 = sx | 0, x1 = Math.min(255, x0 + 1), a = sx - x0;
            out[j * 256 + i] = (src[y0 * 256 + x0] * (1 - a) + src[y0 * 256 + x1] * a) * (1 - b)
                + (src[y1 * 256 + x0] * (1 - a) + src[y1 * 256 + x1] * a) * b;
        }
    }
    return out;
}

let rangosJezero = {};
/** Alturas reales (m) de la tesela z/x/y del relieve fundido: DTM CTX dentro de Jezero, MOLA fuera. */
export async function alturasMarsdem(z, x, y, signal) {
    const r = rangosJezero[z];
    if (r && x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) {
        try {
            return decodificar(await pixeles(`tiles/jezero_dem/${z}/${x}/${y}.png`, signal), -10000);
        } catch (e) { if (signal?.aborted) throw e; }
    }
    const z6 = Math.min(z, 6), f = 2 ** (z - z6);
    const ax = Math.floor(x / f), ay = Math.floor(y / f);
    const src = await alturasMola(z6, ax, ay, signal);
    // Por encima de z6, remuestreo bilineal de la sub-región correspondiente de la tesela de z6.
    return f === 1 ? src : remuestrear(src, f, x - ax * f, y - ay * f);
}
/** Codifica alturas (m) como tesela Terrain-RGB 'mapbox' en PNG. */
export const codificarAlturas = alturas => codificar(alturas);
/** Decodifica una tesela Terrain-RGB 'mapbox' (PNG en una URL) a alturas en metros. */
export const alturasDeUrl = async (url, signal) => decodificar(await pixeles(url, signal), -10000);

let registrado = false;
export function registrarTerreno3D(maplibregl, meta) {
    if (registrado) return;
    registrado = true;
    rangosJezero = meta?.teselas?.rangos || {};
    // Las teselas de Jezero ya están en la codificación 'mapbox' que espera MapLibre: se entregan tal cual, sin
    // decodificar y volver a codificar en el hilo de la página. Las de MOLA (hay que cambiarles la base y
    // remuestrearlas) se codifican una vez y se guardan.
    const codificadas = new Map();
    maplibregl.addProtocol('marsdem', async (params, abort) => {
        const k = params.url.replace('marsdem://', ''), [z, x, y] = k.split('/').map(Number);
        const r = rangosJezero[z];
        if (r && x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) {
            try {
                const resp = await fetch(`tiles/jezero_dem/${k}.png`, { signal: abort.signal });
                if (resp.ok) return { data: await resp.arrayBuffer() };
            } catch (e) { if (abort.signal.aborted) throw e; }
        }
        if (!codificadas.has(k)) {
            const p = alturasMarsdem(z, x, y).then(codificar);
            codificadas.set(k, p); p.catch(() => codificadas.delete(k));
            if (codificadas.size > 160) codificadas.delete(codificadas.keys().next().value);
        }
        return { data: (await codificadas.get(k)).slice(0) };
    });
}

/** Fuentes y capas de terreno de alta resolución (ortoimagen + sombreado del DTM de 20 m). */
export function anadirCapasTerreno(map, meta, antesDe) {
    if (!map.getSource('marsdem')) {
        map.addSource('marsdem', { type: 'raster-dem', tiles: ['marsdem://{z}/{x}/{y}'], tileSize: 256, encoding: 'mapbox', maxzoom: 13 });
    }
    if (meta?.orto && !map.getSource('jezero-orto')) {
        map.addSource('jezero-orto', { type: 'raster', tiles: [meta.orto.url], tileSize: 256,
            minzoom: meta.orto.zoom_min, maxzoom: meta.orto.zoom_max, bounds: meta.orto.bounds });
        map.addLayer({ id: 'ruta-orto', type: 'raster', source: 'jezero-orto', minzoom: 7,
            layout: { visibility: 'none' },
            paint: { 'raster-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0, 8.5, 1], 'raster-fade-duration': 150 } }, antesDe);
    }
    // Relieve "ambiente": sombreado multidireccional suave para que crestas y laderas se lean aunque el Sol esté
    // alto. Va debajo del sombreado del Sol real. Si la versión de MapLibre no lo soporta, se omite.
    if (!map.getLayer('ruta-relieve-ambiente')) {
        try {
            map.addLayer({ id: 'ruta-relieve-ambiente', type: 'hillshade', source: 'marsdem', minzoom: 7,
                layout: { visibility: 'none' },
                paint: { 'hillshade-method': 'multidirectional', 'hillshade-exaggeration': 0.35,
                    'hillshade-illumination-direction': [270, 315, 0, 45], 'hillshade-illumination-altitude': [30, 30, 30, 30],
                    'hillshade-highlight-color': ['#fff3e0', '#fff3e0', '#fff3e0', '#fff3e0'],
                    'hillshade-shadow-color': ['#2a1408', '#2a1408', '#2a1408', '#2a1408'] } }, antesDe);
        } catch (e) { console.warn('[ruta] sombreado multidireccional no disponible:', e.message); }
    }
    if (!map.getLayer('ruta-relieve')) {
        map.addLayer({ id: 'ruta-relieve', type: 'hillshade', source: 'marsdem', minzoom: 7,
            layout: { visibility: 'none' },
            paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#1a0d07', 'hillshade-highlight-color': '#fff2dc',
                'hillshade-accent-color': '#3a2116', 'hillshade-illumination-anchor': 'map' } }, antesDe);
    }
}

/** Fija la elevación del centro de la cámara a la del terreno bajo ella (evita "mirar desde 4 km de altura"). */
export function anclarCamara(map) {
    if (!map.setCenterElevation) return;
    // Sin terreno el suelo es el plano z = 0: si se queda la elevación de antes (−4,5 km en Jezero) la cámara
    // acaba debajo del mapa y la vista sale en negro.
    if (!map.getTerrain()) { if (map.getCenterElevation() !== 0) map.setCenterElevation(0); return; }
    const e = map.queryTerrainElevation(map.getCenter());
    // Mientras el terreno carga, MapLibre devuelve null o exactamente 0: se conserva la estimación previa
    // (en Jezero, 2,5 km bajo el datum, una lectura real nunca es 0).
    if (e != null && e !== 0 && Number.isFinite(e) && Math.abs(e - map.getCenterElevation()) > 3) map.setCenterElevation(e);
}
