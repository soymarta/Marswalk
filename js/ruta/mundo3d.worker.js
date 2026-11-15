/**
 * @module mundo3d.worker
 * @author Hani (módulo 5: rutas y seguridad)
 * @description Trabajo pesado del mundo 3D (js/ruta/mundo3d.js) fuera del hilo de la página:
 *  - descarga y guarda en memoria las teselas (relieve HiRISE de 1 m, ortoimagen HiRISE de 0,6 m, ortoimagen CTX):
 *    lo que se precarga con la ruta no vuelve a pedirse a la red mientras se camina;
 *  - decodifica cada tesela de relieve y construye la malla del trozo de terreno (posiciones, normales, faldones),
 *    compone su textura y reparte las rocas (deterministas: siempre las mismas en el mismo sitio).
 * La página solo recibe arrays e imágenes listos para subir a la GPU.
 *
 * Coordenadas de la escena (metros reales): x = este, z = sur, y = altura sobre la cota del origen × exageración.
 */

let C = null;                     // { lonO, latO, elevO, R, exag, urlDem, urlOrto, zOrto, rangosOrto, rutaCeldas }
const blobs = new Map();          // url → Promise<Blob|null>
const RAD = Math.PI / 180;

function pedir(url) {
    let p = blobs.get(url);
    if (!p) {
        p = fetch(url).then(r => (r.ok ? r.blob() : null)).catch(() => null);
        blobs.set(url, p);
        // Tope de memoria (~80 MB): al cambiar muchas veces de ruta se sueltan las teselas más antiguas.
        if (blobs.size > 3200) { let n = 0; for (const k of blobs.keys()) { blobs.delete(k); if (++n >= 800) break; } }
        p.then(b => { if (!b) blobs.delete(url); });
    }
    return p;
}

const url = (plantilla, z, x, y) => plantilla.replace('{z}', z).replace('{x}', x).replace('{y}', y);
const lonTesela = (x, z) => x / 2 ** z * 360 - 180;
const latTesela = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) / RAD;
const aX = lon => (lon - C.lonO) * RAD * C.R * Math.cos(C.latO * RAD);
const aZ = lat => -(lat - C.latO) * RAD * C.R;

function hash(i, j, k = 0) {  // entero → [0, 1), estable entre equipos
    let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

async function alturasDe(blob) {
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const c = new OffscreenCanvas(256, 256), g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0, 256, 256); bmp.close();
    const px = g.getImageData(0, 0, 256, 256).data, h = new Float32Array(65536);
    for (let i = 0, p = 0; i < 65536; i++, p += 4) h[i] = -10000 + (px[p] * 65536 + px[p + 1] * 256 + px[p + 2]) * 0.1;
    return h;
}

/** Textura del trozo: 4 teselas hijas de la ortoimagen (512 px) o, lejos, la tesela de su mismo zoom (256 px). */
async function texturaDe(z, x, y, fina) {
    const lado = fina ? 512 : 256;
    const c = new OffscreenCanvas(lado, lado), g = c.getContext('2d');
    g.fillStyle = '#b98a62'; g.fillRect(0, 0, lado, lado);
    const dibujar = async (zz, xx, yy, dx, dy, tam) => {
        const b = await pedir(url(C.urlOrto, zz, xx, yy));
        if (!b) return false;
        const bmp = await createImageBitmap(b);
        g.drawImage(bmp, dx, dy, tam, tam); bmp.close();
        return true;
    };
    const base = await dibujar(z, x, y, 0, 0, lado);
    if (fina && z + 1 <= C.zOrto) {
        await Promise.all([[0, 0], [1, 0], [0, 1], [1, 1]].map(([i, j]) => dibujar(z + 1, 2 * x + i, 2 * y + j, i * 256, j * 256, 256)));
    }
    return base || fina ? c.transferToImageBitmap() : null;
}

const indices = new Map();
/** Triángulos de una rejilla de (n+1)² vértices más un faldón por lado (tapa las juntas entre trozos). */
function indicesDe(n) {
    if (indices.has(n)) return indices.get(n);
    const m = n + 1, out = new Uint32Array(n * n * 6 + 4 * n * 6);
    let k = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const a = j * m + i, b = a + 1, c = a + m, d = c + 1;
        out[k++] = a; out[k++] = c; out[k++] = b; out[k++] = b; out[k++] = c; out[k++] = d;
    }
    // Faldones: los vértices extra van tras la rejilla, en el orden norte, sur, oeste, este.
    const base = m * m;
    const lado = (borde, extra, invertir) => {
        for (let i = 0; i < n; i++) {
            const a = borde(i), b = borde(i + 1), c = extra + i, d = extra + i + 1;
            if (invertir) { out[k++] = a; out[k++] = b; out[k++] = c; out[k++] = b; out[k++] = d; out[k++] = c; }
            else { out[k++] = a; out[k++] = c; out[k++] = b; out[k++] = b; out[k++] = c; out[k++] = d; }
        }
    };
    lado(i => i, base, true); lado(i => n * m + i, base + m, false);
    lado(i => i * m, base + 2 * m, false); lado(i => i * m + n, base + 3 * m, true);
    indices.set(n, out);
    return out;
}

async function trozo({ z, x, y, res, rocas }) {
    const [demBlob, tex] = await Promise.all([pedir(url(C.urlDem, z, x, y)), texturaDe(z, x, y, res >= 96)]);
    if (!demBlob) return null;
    const h = await alturasDe(demBlob);
    const n = res, m = n + 1, nv = m * m + 4 * m;
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
    const lonW = lonTesela(x, z), lonE = lonTesela(x + 1, z);
    const x0 = aX(lonW), x1 = aX(lonE), zN = aZ(latTesela(y, z)), zS = aZ(latTesela(y + 1, z));
    const mPx = (x1 - x0) / 256, mPz = (zS - zN) / 256;      // metros por píxel de relieve
    const alt = (fx, fy) => {                                // bilineal sobre los centros de píxel, sin salirse
        const sx = Math.min(255, Math.max(0, fx)), sy = Math.min(255, Math.max(0, fy));
        const i = Math.min(254, sx | 0), j = Math.min(254, sy | 0), a = sx - i, b = sy - j, k = j * 256 + i;
        return (h[k] * (1 - a) + h[k + 1] * a) * (1 - b) + (h[k + 256] * (1 - a) + h[k + 257] * a) * b;
    };
    let yMin = Infinity, yMax = -Infinity;
    for (let j = 0; j <= n; j++) {
        const v = j / n, zz = aZ(latTesela(y + v, z)), fy = v * 256 - 0.5;
        for (let i = 0; i <= n; i++) {
            const u = i / n, fx = u * 256 - 0.5, k = j * m + i;
            const e = (alt(fx, fy) - C.elevO) * C.exag;
            pos[k * 3] = x0 + (x1 - x0) * u; pos[k * 3 + 1] = e; pos[k * 3 + 2] = zz;
            // Normal por diferencias centrales a ±1,5 píxeles (≈ 2 m): relieve fino sin ruido de cuantización.
            const dx = (alt(fx + 1.5, fy) - alt(fx - 1.5, fy)) * C.exag / (3 * mPx), dz = (alt(fx, fy + 1.5) - alt(fx, fy - 1.5)) * C.exag / (3 * mPz);
            const l = 1 / Math.hypot(dx, 1, dz);
            nor[k * 3] = -dx * l; nor[k * 3 + 1] = l; nor[k * 3 + 2] = -dz * l;
            uv[k * 2] = u; uv[k * 2 + 1] = v;
            if (e < yMin) yMin = e; if (e > yMax) yMax = e;
        }
    }
    // Faldones: copia del borde, 14 m más abajo.
    const base = m * m, copiar = (dst, src) => {
        pos[dst * 3] = pos[src * 3]; pos[dst * 3 + 1] = pos[src * 3 + 1] - 14; pos[dst * 3 + 2] = pos[src * 3 + 2];
        nor[dst * 3] = nor[src * 3]; nor[dst * 3 + 1] = nor[src * 3 + 1]; nor[dst * 3 + 2] = nor[src * 3 + 2];
        uv[dst * 2] = uv[src * 2]; uv[dst * 2 + 1] = uv[src * 2 + 1];
    };
    for (let i = 0; i <= n; i++) {
        copiar(base + i, i); copiar(base + m + i, n * m + i);
        copiar(base + 2 * m + i, i * m); copiar(base + 3 * m + i, i * m + n);
    }
    const out = { z, x, y, res, pos, nor, uv, idx: indicesDe(n), tex, alturas: h, x0, x1, zN, zS, yMin: yMin - 14, yMax };
    if (rocas) Object.assign(out, repartirRocas(x0, x1, zN, zS, alt));
    return out;
}

/**
 * Rocas del trozo. Decorativas (ningún DTM ve rocas sueltas): posición y tamaño salen de una semilla por celda del
 * terreno, así que son siempre las mismas en el mismo sitio. Más densas en manchas, como los campos de bloques de
 * Séítah; ley de potencias en el tamaño (muchas piedras, pocos bloques). Se deja libre el camino de la ruta.
 */
const CELDA = 5;
function repartirRocas(x0, x1, zN, zS, alt) {
    const i0 = Math.floor(x0 / CELDA), i1 = Math.ceil(x1 / CELDA), j0 = Math.floor(zN / CELDA), j1 = Math.ceil(zS / CELDA);
    const max = 900, mat = new Float32Array(max * 16), col = new Float32Array(max * 3), som = new Float32Array(max * 4);
    let nr = 0;
    for (let j = j0; j < j1 && nr < max; j++) for (let i = i0; i < i1 && nr < max; i++) {
        const mancha = hash(Math.floor(i / 7), Math.floor(j / 7), 21);
        if (hash(i, j, 11) > 0.035 + 0.3 * mancha * mancha * mancha) continue;
        const px = (i + hash(i, j, 14)) * CELDA, pz = (j + hash(i, j, 15)) * CELDA;
        if (px < x0 || px >= x1 || pz < zN || pz >= zS) continue;
        if (C.rutaCeldas?.has(`${Math.round(px / 4)},${Math.round(pz / 4)}`)) continue;
        const t = hash(i, j, 12), d = Math.min(0.22 * Math.pow(1 - t, -0.62), 2.6);  // radio: 0,22 m … 2,6 m
        const fx = (px - x0) / (x1 - x0) * 256 - 0.5, fz = (pz - zN) / (zS - zN) * 256 - 0.5;
        const suelo = (alt(fx, fz) - C.elevO) * C.exag;
        // Rotación: giro libre en vertical y una inclinación pequeña (la roca descansa en el suelo).
        const yaw = hash(i, j, 16) * 6.2832, incl = (hash(i, j, 17) - 0.5) * 0.7, eje = hash(i, j, 18) * 6.2832;
        const sx = d * (0.75 + hash(i, j, 22) * 0.7), sy = d * (0.45 + hash(i, j, 23) * 0.5), sz = d * (0.75 + hash(i, j, 24) * 0.7);
        const cy = Math.cos(yaw), syw = Math.sin(yaw), ci = Math.cos(incl), si = Math.sin(incl), ax = Math.cos(eje), az = Math.sin(eje);
        // R = Rot(eje horizontal, incl) · RotY(yaw)
        const r = [
            [ci + ax * ax * (1 - ci), -az * si, ax * az * (1 - ci)],
            [az * si, ci, -ax * si],
            [ax * az * (1 - ci), ax * si, ci + az * az * (1 - ci)],
        ];
        const ry = [[cy, 0, syw], [0, 1, 0], [-syw, 0, cy]];
        const o = nr * 16, s = [sx, sy, sz];
        for (let c = 0; c < 3; c++) for (let f = 0; f < 3; f++) {
            mat[o + c * 4 + f] = (r[f][0] * ry[0][c] + r[f][1] * ry[1][c] + r[f][2] * ry[2][c]) * s[c];
        }
        mat[o + 12] = px; mat[o + 13] = suelo + sy * 0.18; mat[o + 14] = pz; mat[o + 15] = 1;
        const tono = hash(i, j, 19), rojo = hash(i, j, 20);  // basalto gris oscuro con más o menos polvo rojizo
        col[nr * 3] = 0.30 + tono * 0.20 + rojo * 0.10; col[nr * 3 + 1] = 0.21 + tono * 0.14 + rojo * 0.03; col[nr * 3 + 2] = 0.16 + tono * 0.10;
        som[nr * 4] = px; som[nr * 4 + 1] = suelo + 0.06; som[nr * 4 + 2] = pz; som[nr * 4 + 3] = Math.max(sx, sz);
        nr++;
    }
    return { nRocas: nr, rocaMat: mat.slice(0, nr * 16), rocaCol: col.slice(0, nr * 3), rocaSom: som.slice(0, nr * 4) };
}

/** Mosaico de la ortoimagen CTX para el terreno lejano (una sola textura). */
async function mosaico({ plantilla, z, rango, maxLado }) {
    const [xa, ya, xb, yb] = rango, nx = xb - xa + 1, ny = yb - ya + 1;
    const esc = Math.min(1, maxLado / (256 * Math.max(nx, ny))), t = Math.floor(256 * esc);
    const c = new OffscreenCanvas(nx * t, ny * t), g = c.getContext('2d');
    g.fillStyle = '#b98a62'; g.fillRect(0, 0, c.width, c.height);
    const cola = [];
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) cola.push([x, y]);
    await Promise.all(Array.from({ length: 8 }, async () => {
        for (let p; (p = cola.pop());) {
            const b = await fetch(url(plantilla, z, p[0], p[1])).then(r => (r.ok ? r.blob() : null)).catch(() => null);
            if (!b) continue;
            const bmp = await createImageBitmap(b);
            g.drawImage(bmp, (p[0] - xa) * t, (p[1] - ya) * t, t, t); bmp.close();
        }
    }));
    return { img: c.transferToImageBitmap(), rango, z };
}

/** Descarga a memoria, de 8 en 8, todo lo que hará falta por el camino. */
async function precargar(id, urls) {
    const cola = urls.filter(u => !blobs.has(u));
    const total = cola.length;
    let hechas = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
        for (let u; (u = cola.pop());) {
            await pedir(u);
            if (++hechas % 40 === 0) postMessage({ id, progreso: hechas / total });
        }
    }));
    return { total, enMemoria: blobs.size };
}

const transferibles = r => {
    const out = [];
    for (const v of Object.values(r || {})) {
        if (ArrayBuffer.isView(v) && v !== indices.get(r.res)) out.push(v.buffer);
        else if (typeof ImageBitmap !== 'undefined' && v instanceof ImageBitmap) out.push(v);
    }
    return out;
};

self.onmessage = async ({ data }) => {
    const { id, tipo } = data;
    try {
        let res = null;
        if (tipo === 'config') { C = { ...(C || {}), ...data.config }; res = { ok: true }; }
        else if (tipo === 'ruta') {
            // Celdas de 4 m ocupadas por el camino (y sus vecinas): ahí no se ponen rocas.
            const s = new Set(), p = data.puntos;
            for (let k = 0; k + 3 < p.length; k += 2) {
                const ax = p[k], az = p[k + 1], bx = p[k + 2], bz = p[k + 3], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 3));
                for (let q = 0; q <= n; q++) {
                    const cx = Math.round((ax + (bx - ax) * q / n) / 4), cz = Math.round((az + (bz - az) * q / n) / 4);
                    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) s.add(`${cx + dx},${cz + dz}`);
                }
            }
            C.rutaCeldas = s; res = { ok: true };
        }
        else if (tipo === 'trozo') res = await trozo(data);
        else if (tipo === 'mosaico') res = await mosaico(data);
        else if (tipo === 'precargar') res = await precargar(id, data.urls);
        postMessage({ id, ok: true, res }, transferibles(res));
    } catch (e) {
        postMessage({ id, ok: false, error: String(e?.stack || e) });
    }
};
