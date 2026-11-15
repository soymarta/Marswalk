/**
 * @module terreno
 * @description Rejilla de terreno del planificador: carga del DTM (PNG 16 bits), derivadas
 * (pendiente de Horn, rugosidad), remuestreo a la rejilla de búsqueda y muestreo bilineal.
 * Se ejecuta dentro del worker.
 */

/** Rejilla regular en lon/lat (esfera de Marte). Fila 0 = norte. */
export class Rejilla {
    constructor({ ancho, alto, lon0, lat0, dlon, dlat, resM, elev, pend, rug, peligro }) {
        Object.assign(this, { W: ancho, H: alto, lon0, lat0, dlon, dlat, resM, elev, pend, rug });
        this.peligro = peligro || new Float32Array(ancho * alto);
        this.dy = resM;
        this.dx = new Float32Array(alto);
        for (let j = 0; j < alto; j++) this.dx[j] = resM * Math.cos(this.latDe(j) * Math.PI / 180);
        this.dxMedio = this.dx[alto >> 1];
    }
    lonDe(i) { return this.lon0 + (i + 0.5) * this.dlon; }
    latDe(j) { return this.lat0 - (j + 0.5) * this.dlat; }
    /** Índices continuos (i, j) de un punto lon/lat. */
    ij(lon, lat) { return [(lon - this.lon0) / this.dlon - 0.5, (this.lat0 - lat) / this.dlat - 0.5]; }
    celda(lon, lat) {
        const [fi, fj] = this.ij(lon, lat);
        const i = Math.round(fi), j = Math.round(fj);
        if (i < 0 || j < 0 || i >= this.W || j >= this.H) return -1;
        return j * this.W + i;
    }
    dentro(lon, lat) { return this.celda(lon, lat) >= 0; }
    lonlat(k) { return [this.lonDe(k % this.W), this.latDe((k / this.W) | 0)]; }
    /** Muestreo bilineal de un campo en lon/lat. */
    muestrear(campo, lon, lat) {
        let [fi, fj] = this.ij(lon, lat);
        fi = Math.max(0, Math.min(this.W - 1.001, fi));
        fj = Math.max(0, Math.min(this.H - 1.001, fj));
        const i = fi | 0, j = fj | 0, a = fi - i, b = fj - j, W = this.W, k = j * W + i;
        return (campo[k] * (1 - a) + campo[k + 1] * a) * (1 - b) + (campo[k + W] * (1 - a) + campo[k + W + 1] * a) * b;
    }
    elevEn(lon, lat) { return this.muestrear(this.elev, lon, lat); }
    bounds() {
        return [this.lon0, this.lat0 - this.H * this.dlat, this.lon0 + this.W * this.dlon, this.lat0];
    }
}

/** Distancia sobre la esfera de Marte (m) entre dos puntos lon/lat. */
export function distancia(R, lon1, lat1, lon2, lat2) {
    const r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Rumbo inicial (°, desde el norte en sentido horario). */
export function rumbo(lon1, lat1, lon2, lat2) {
    const r = Math.PI / 180;
    const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
    const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
    return (Math.atan2(y, x) / r + 360) % 360;
}

async function decodificarPNG16(url, W, H, offset) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`No se pudo cargar ${url} (${resp.status})`);
    const bmp = await createImageBitmap(await resp.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const c = new OffscreenCanvas(W, H);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, W, H).data;
    const out = new Float32Array(W * H);
    for (let k = 0, p = 0; k < out.length; k++, p += 4) {
        const v = px[p] * 256 + px[p + 1];
        out[k] = v === 65535 ? NaN : v / 10 - offset;
    }
    return out;
}

/** Pendiente de Horn (grados) con dx dependiente de la latitud. */
function pendienteHorn(elev, W, H, dxFila, dy) {
    const out = new Float32Array(W * H);
    const g = (i, j) => elev[Math.min(H - 1, Math.max(0, j)) * W + Math.min(W - 1, Math.max(0, i))];
    for (let j = 0; j < H; j++) {
        const dx = dxFila[j];
        for (let i = 0; i < W; i++) {
            const a = g(i - 1, j - 1), b = g(i, j - 1), c = g(i + 1, j - 1);
            const d = g(i - 1, j), f = g(i + 1, j);
            const gg = g(i - 1, j + 1), h = g(i, j + 1), ii = g(i + 1, j + 1);
            const zx = ((c + 2 * f + ii) - (a + 2 * d + gg)) / (8 * dx);
            const zy = ((gg + 2 * h + ii) - (a + 2 * b + c)) / (8 * dy);
            out[j * W + i] = Math.atan(Math.hypot(zx, zy)) * 57.29578;
        }
    }
    return out;
}

/** Media en ventana (2r+1)² con imagen integral. */
function mediaCaja(src, W, H, r) {
    const S = new Float64Array((W + 1) * (H + 1));
    for (let j = 0; j < H; j++) {
        let fila = 0;
        for (let i = 0; i < W; i++) {
            fila += src[j * W + i];
            S[(j + 1) * (W + 1) + i + 1] = S[j * (W + 1) + i + 1] + fila;
        }
    }
    const out = new Float32Array(W * H);
    for (let j = 0; j < H; j++) {
        const j0 = Math.max(0, j - r), j1 = Math.min(H, j + r + 1);
        for (let i = 0; i < W; i++) {
            const i0 = Math.max(0, i - r), i1 = Math.min(W, i + r + 1);
            const s = S[j1 * (W + 1) + i1] - S[j0 * (W + 1) + i1] - S[j1 * (W + 1) + i0] + S[j0 * (W + 1) + i0];
            out[j * W + i] = s / ((j1 - j0) * (i1 - i0));
        }
    }
    return out;
}

/** Rugosidad (m): desviación típica del residuo de alta frecuencia en ventana 5×5 (100 m a 20 m/px). */
function rugosidad(elev, W, H) {
    const m = mediaCaja(elev, W, H, 2);
    const r2 = new Float32Array(W * H);
    for (let k = 0; k < r2.length; k++) { const r = elev[k] - m[k]; r2[k] = r * r; }
    const v = mediaCaja(r2, W, H, 2);
    for (let k = 0; k < v.length; k++) v[k] = Math.sqrt(v[k]);
    return v;
}

/**
 * Carga el terreno. Si existen capas del módulo de terreno (meta.capas: pendiente/rugosidad/peligro,
 * entregadas por la persona 2 según el contrato de datos), sustituyen a las calculadas aquí.
 */
export async function cargarTerreno(base) {
    const meta = await (await fetch(new URL('data/ruta/jezero_meta.json', base))).json();
    const { ancho: W, alto: H } = meta;
    const elev = await decodificarPNG16(new URL('data/ruta/jezero_dem.png', base), W, H, meta.offset);
    const tmp = new Rejilla({ ...meta, resM: meta.res_m, elev, pend: null, rug: null });
    // Si el módulo de terreno entrega pendiente/rugosidad no se calculan aquí (2,4 M celdas cada una por worker).
    const capas = meta.capas || {};
    let pend = capas.pendiente ? null : pendienteHorn(elev, W, H, tmp.dx, tmp.dy);
    let rug = capas.rugosidad ? null : rugosidad(elev, W, H);
    let peligro = null, T_confianza = null;
    const fuentes = { pendiente: 'Horn 3×3 sobre DTM CTX 20 m (calculado en el navegador)',
        rugosidad: 'σ del residuo 5×5 sobre DTM CTX 20 m (calculado en el navegador)', peligro: 'sin datos' };
    for (const [nombre, capa] of Object.entries(meta.capas || {})) {
        try {
            const v = await decodificarPNG16(new URL(capa.url, base), W, H, capa.offset);
            if (capa.escala && capa.escala !== 1) for (let k = 0; k < v.length; k++) v[k] *= capa.escala;
            if (nombre === 'pendiente') pend = v;
            else if (nombre === 'rugosidad') rug = v;
            else if (nombre === 'peligro') peligro = v;
            else if (nombre === 'confianza') T_confianza = v;
            fuentes[nombre] = capa.fuente || capa.url;
        } catch (e) { console.warn('[ruta] capa de terreno no disponible:', nombre, e); }
    }
    // Respaldo si una capa externa declarada no se pudo cargar
    if (!pend) { pend = pendienteHorn(elev, W, H, tmp.dx, tmp.dy); fuentes.pendiente = 'Horn 3×3 sobre DTM CTX 20 m (calculado en el navegador)'; }
    if (!rug) { rug = rugosidad(elev, W, H); fuentes.rugosidad = 'σ del residuo 5×5 sobre DTM CTX 20 m (calculado en el navegador)'; }
    // no-data en capas externas → intransitable
    // Terreno no verificado con HiRISE: penalización suave (equivale a un 10 % de obstáculo) para que el
    // planificador prefiera lo comprobado a 1 m, sin prohibir lo que solo se conoce a 20 m.
    if (T_confianza) {
        peligro = peligro || new Float32Array(W * H);
        for (let k = 0; k < W * H; k++) {
            const c = Number.isFinite(T_confianza[k]) ? T_confianza[k] : 0;
            if (!Number.isFinite(peligro[k])) peligro[k] = 0;   // sin HiRISE ≠ prohibido
            peligro[k] = Math.max(peligro[k], 0.1 * (1 - c));
        }
        fuentes.confianza = 'cobertura HiRISE del módulo de terreno';
    }
    for (let k = 0; k < W * H; k++) {
        if (!Number.isFinite(pend[k])) pend[k] = 90;
        if (!Number.isFinite(rug[k])) rug[k] = 5;
        if (peligro && !Number.isFinite(peligro[k])) peligro[k] = 1;
    }
    const g20 = new Rejilla({ ...meta, resM: meta.res_m, elev, pend, rug, peligro });
    return { meta, g20, g40: reducir(g20, 2), fuentes };
}

/** Rejilla de búsqueda más gruesa (factor f): elevación media, pendiente/rugosidad/peligro máximos (conservador). */
export function reducir(g, f) {
    const W = Math.floor(g.W / f), H = Math.floor(g.H / f), n = W * H;
    const elev = new Float32Array(n), pend = new Float32Array(n), rug = new Float32Array(n), pel = new Float32Array(n);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        let s = 0, p = 0, r = 0, h = 0;
        for (let b = 0; b < f; b++) for (let a = 0; a < f; a++) {
            const k = (j * f + b) * g.W + i * f + a;
            s += g.elev[k]; p = Math.max(p, g.pend[k]); r = Math.max(r, g.rug[k]); h = Math.max(h, g.peligro[k]);
        }
        const k = j * W + i;
        elev[k] = s / (f * f); pend[k] = p; rug[k] = r; pel[k] = h;
    }
    return new Rejilla({ ancho: W, alto: H, lon0: g.lon0, lat0: g.lat0, dlon: g.dlon * f, dlat: g.dlat * f,
        resM: g.resM * f, elev, pend, rug, peligro: pel });
}

/** Reconstruye el terreno a partir de arrays ya decodificados por otro worker (sin volver a leer los PNG). */
export function terrenoDesde({ meta, fuentes, elev, pend, rug, peligro }) {
    const g20 = new Rejilla({ ...meta, resM: meta.res_m, elev, pend, rug, peligro });
    return { meta, g20, g40: reducir(g20, 2), fuentes };
}
