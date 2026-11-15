/**
 * @module busqueda
 * @author Hani
 * @description Búsqueda de caminos sobre la rejilla de terreno:
 *  - vecindad de 16 direcciones (incluye saltos de caballo → rumbos cada ~26,6°, rutas menos en zigzag),
 *  - A* con heurística admisible (distancia × coste mínimo por metro),
 *  - Dijkstra completo o acotado (campos de coste "ida desde la base" y "vuelta a la base"),
 *  - acumulación de tiempo, energía metabólica y calor a lo largo del árbol de caminos,
 *  - post-suavizado por línea de visión (string pulling) sin empeorar el coste.
 *
 * Rendimiento: el bucle interno solo toca arrays tipados y enteros (índice de movimiento k), y el
 * modelo metabólico está tabulado por (rasante, rugosidad). Un campo completo de 600 k celdas
 * y 16 vecinos (~10 M aristas) tarda del orden de medio segundo.
 */
import { velocidadMarcha, potenciaMetabolica, PERFILES } from './eva.js';
import { kernelActivo, dijkstraWasm, aEstrellaWasm } from './kernel.js';

// [di, dj, ...celdas intermedias atravesadas (relativas a la salida)]
const MOVS = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
    [1, 2, 0, 1, 1, 1], [-1, 2, 0, 1, -1, 1], [1, -2, 0, -1, 1, -1], [-1, -2, 0, -1, -1, -1],
    [2, 1, 1, 0, 1, 1], [2, -1, 1, 0, 1, -1], [-2, 1, -1, 0, -1, 1], [-2, -1, -1, 0, -1, -1],
];
/** Movimiento opuesto de MOVS[k] evaluado desde la celda de llegada (campos inversos): índice k + 16. */
const INV = MOVS.map(m => m.length > 2 ? [-m[0], -m[1], m[2] - m[0], m[3] - m[1], m[4] - m[0], m[5] - m[1]] : [-m[0], -m[1]]);
const TODOS = [...MOVS, ...INV];
const DI = Int8Array.from(TODOS, m => m[0]), DJ = Int8Array.from(TODOS, m => m[1]);
const CABALLO = Uint8Array.from(TODOS, m => m.length > 2 ? 1 : 0);
/** Índice k del movimiento (di, dj) con |di|,|dj| ≤ 2. */
const K_DE = new Int8Array(25).fill(-1);
MOVS.forEach((m, k) => { K_DE[(m[1] + 2) * 5 + m[0] + 2] = k; });
export const kDe = (di, dj) => K_DE[(dj + 2) * 5 + di + 2];

/** Montículo binario mínimo con claves Float64 e ids Int32 (duplicados permitidos, borrado perezoso). */
class Monticulo {
    constructor(cap = 1 << 16) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
    push(key, val) {
        if (this.n === this.k.length) {
            const k = new Float64Array(this.n * 2); k.set(this.k); this.k = k;
            const v = new Int32Array(this.n * 2); v.set(this.v); this.v = v;
        }
        let i = this.n++;
        const K = this.k, V = this.v;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (K[p] <= key) break;
            K[i] = K[p]; V[i] = V[p]; i = p;
        }
        K[i] = key; V[i] = val;
    }
    pop() {
        const K = this.k, V = this.v, top = V[0];
        const n = --this.n, key = K[n], val = V[n];
        let i = 0;
        for (;;) {
            let c = 2 * i + 1;
            if (c >= n) break;
            if (c + 1 < n && K[c + 1] < K[c]) c++;
            if (K[c] >= key) break;
            K[i] = K[c]; V[i] = V[c]; i = c;
        }
        K[i] = key; V[i] = val;
        return top;
    }
}

/**
 * Evaluador de aristas de una rejilla para un perfil y un traje.
 * `arista(a, k, j)`: coste del movimiento k (0-15 directo, 16-31 inverso) desde la celda `a` en la fila `j`.
 * Deja en `sal` el tiempo (s) y la potencia metabólica (W) del paso. Infinity = intransitable.
 */
export function crearEvaluador(g, perfil, traje) {
    const W = g.W, { elev, pend, rug, peligro } = g;
    const esRover = !!perfil.esRover;
    const sal = { t: 0, M: 0 };
    const rasMax = Math.tan(perfil.rasanteMax * Math.PI / 180);
    const pMax = perfil.pendienteMax, invPMax = 1 / pMax, pesoR = perfil.pesoRiesgo, pesoU = perfil.pesoRugosidad;

    // Tablas por (rasante, rugosidad): tiempo por metro horizontal, potencia y coste base por metro.
    const PR = 0.004, NR = Math.ceil(rasMax / PR), PU = 0.04, NU = 64;
    const filas = 2 * NR + 1, n = filas * NU;
    const tabT = new Float32Array(n), tabM = new Float32Array(n), tabC = new Float32Array(n);
    for (let a = 0; a < filas; a++) for (let u = 0; u < NU; u++) {
        const ras = (a - NR) * PR, r = u * PU;
        const v = velocidadMarcha(ras, r), t = Math.sqrt(1 + ras * ras) / v;
        const M = esRover ? 0 : potenciaMetabolica(v, ras, r, traje);
        const k = a * NU + u;
        tabT[k] = t; tabM[k] = M; tabC[k] = t * (0.5 + M / 800);
    }
    // Desplazamientos lineales de cada movimiento y distancia horizontal por fila.
    const OFF = Int32Array.from(TODOS, m => m[1] * W + m[0]);
    const OFF1 = Int32Array.from(TODOS, m => m.length > 2 ? m[3] * W + m[2] : 0);
    const OFF2 = Int32Array.from(TODOS, m => m.length > 2 ? m[5] * W + m[4] : 0);
    const dTab = new Float32Array(g.H * 32);
    for (let j = 0; j < g.H; j++) for (let k = 0; k < 32; k++) {
        const x = DI[k] * g.dx[j], y = DJ[k] * g.dy;
        dTab[j * 32 + k] = Math.sqrt(x * x + y * y);
    }
    const PRinv = 1 / PR, PUinv = 1 / PU;

    function arista(a, k, j) {
        const b = a + OFF[k];
        let p = pend[a], r = rug[a], h = peligro[a];
        const pb = pend[b], rb = rug[b], hb = peligro[b];
        if (pb > p) p = pb; if (rb > r) r = rb; if (hb > h) h = hb;
        if (CABALLO[k] === 1) {
            const c1 = a + OFF1[k], c2 = a + OFF2[k];
            if (pend[c1] > p) p = pend[c1]; if (pend[c2] > p) p = pend[c2];
            if (rug[c1] > r) r = rug[c1]; if (rug[c2] > r) r = rug[c2];
            if (peligro[c1] > h) h = peligro[c1]; if (peligro[c2] > h) h = peligro[c2];
        }
        if (!(p <= pMax) || h >= 1) return Infinity;
        const d = dTab[j * 32 + k];
        const ras = (elev[b] - elev[a]) / d;
        if (ras > rasMax || ras < -rasMax) return Infinity;
        let ia = ((ras * PRinv + 0.5) | 0) + NR; if (ras < 0) ia = NR - ((-ras * PRinv + 0.5) | 0);
        if (ia < 0) ia = 0; else if (ia >= filas) ia = filas - 1;
        let iu = (r * PUinv + 0.5) | 0; if (iu >= NU) iu = NU - 1;
        const ti = ia * NU + iu;
        sal.t = d * tabT[ti];
        if (esRover) {
            sal.M = 0;
            const q = p * 0.1;
            return d * (1 + pesoR * q * q + pesoU * r + 6 * h);
        }
        sal.M = tabM[ti];
        const q = p * invPMax, q2 = q * q;
        return d * tabC[ti] * (1 + pesoR * q2 * q2 + pesoU * r + 4 * h);
    }
    let cmin = Infinity;
    if (esRover) cmin = 1;
    else for (let a = 0; a < filas; a++) cmin = Math.min(cmin, tabC[a * NU] * 0.999);
    const tablas = { esRover, pMax, rasMax, pesoR, pesoU, NR, PR, NU, PU, tabT, tabM, tabC };
    return { arista, sal, cmin, tablas };
}

/** Estado reutilizable por rejilla para A* (evita reservar memoria en cada búsqueda). */
const estados = new WeakMap();
function estado(g) {
    let s = estados.get(g);
    if (!s) {
        const n = g.W * g.H;
        s = { coste: new Float64Array(n), padre: new Int32Array(n), sello: new Int32Array(n), cerrado: new Int32Array(n), gen: 0 };
        estados.set(g, s);
    }
    s.gen++;
    return s;
}

/**
 * Dijkstra desde `fuente`. Con `inverso` calcula el coste de ir DESDE cada celda HASTA la fuente
 * (campo de "vuelta a la base"). Devuelve campos completos: coste, tiempo, energía metabólica, calor y padre.
 * `objetivos` (opcional) detiene la búsqueda cuando todos están cerrados.
 */
export function dijkstra(g, fuente, ev, { inverso = false, objetivos = null, radioM = Infinity } = {}) {
    if (kernelActivo()) return dijkstraWasm(g, fuente, ev, { inverso, objetivos, radioM });
    const n = g.W * g.H, W = g.W, H = g.H;
    const coste = new Float64Array(n).fill(Infinity);
    const T = new Float32Array(n), E = new Float32Array(n), Q = new Float32Array(n);
    const padre = new Int32Array(n).fill(-1);
    const cerrado = new Uint8Array(n);
    const heap = new Monticulo(1 << 18);
    const objetivo = objetivos ? new Uint8Array(n) : null;
    let pendientes = 0;
    if (objetivos) for (const k of objetivos) if (k >= 0 && !objetivo[k]) { objetivo[k] = 1; pendientes++; }
    coste[fuente] = 0;
    heap.push(0, fuente);
    const { arista, sal } = ev;
    const kInv = inverso ? 16 : 0;
    // Poda física exacta: fuera de este radio ninguna celda puede formar parte de una EVA factible.
    const fj0 = (fuente / W) | 0, fi0 = fuente - fj0 * W, dxm = g.dxMedio, dy = g.dy, r2 = radioM * radioM;
    const podar = Number.isFinite(radioM);
    while (heap.n) {
        const u = heap.pop();
        if (cerrado[u]) continue;
        cerrado[u] = 1;
        if (objetivo && objetivo[u] && --pendientes === 0) break;
        const uj = (u / W) | 0, ui = u - uj * W, cu = coste[u];
        for (let k = 0; k < 16; k++) {
            const vi = ui + DI[k], vj = uj + DJ[k];
            if (vi < 0 || vj < 0 || vi >= W || vj >= H) continue;
            if (podar) { const x = (vi - fi0) * dxm, y = (vj - fj0) * dy; if (x * x + y * y > r2) continue; }
            const v = vj * W + vi;
            if (cerrado[v]) continue;
            // inverso: se evalúa el paso v → u (movimiento opuesto, desde la fila de v)
            const c = inverso ? arista(v, k + kInv, vj) : arista(u, k, uj);
            if (c === Infinity) continue;
            const nc = cu + c;
            if (nc < coste[v]) {
                coste[v] = nc; padre[v] = u;
                const t = sal.t, M = sal.M;
                T[v] = T[u] + t; E[v] = E[u] + M * t;
                const calor = 0.8 * M - 90;
                Q[v] = calor > 0 ? Q[u] + calor * t : Q[u];
                heap.push(nc, v);
            }
        }
    }
    return { coste, T, E, Q, padre, fuente, inverso };
}

/**
 * A* entre dos celdas. Devuelve la lista de celdas, el coste y el número de nodos expandidos, o null.
 *
 * Heurística = máx(distancia recta × coste mínimo por metro, cotas ALT). Con `hitos` (campos de Dijkstra
 * de un punto L en la MISMA rejilla y con el MISMO evaluador) la desigualdad triangular da dos cotas inferiores
 * exactas del coste restante (Goldberg & Harrelson 2005):
 *     d(v,t) ≥ d(L→t) − d(L→v)      (campo de ida desde L)
 *     d(v,t) ≥ d(v→L) − d(t→L)      (campo de vuelta hacia L)
 * El máximo de heurísticas consistentes es consistente → el camino sigue siendo óptimo.
 */
export function aEstrella(g, ini, fin, ev, { hitos = [] } = {}) {
    if (ini < 0 || fin < 0) return null;
    if (kernelActivo()) return aEstrellaWasm(g, ini, fin, ev, { hitos });
    const s = estado(g), W = g.W, H = g.H, gen = s.gen;
    const { coste, padre, sello, cerrado } = s;
    const heap = new Monticulo(1 << 14);
    const fj = (fin / W) | 0, fi = fin - fj * W, dxm = g.dxMedio, dy = g.dy, cmin = ev.cmin;
    // Cotas ALT con el primer hito (la base): arrays locales para que el bucle caliente no reserve memoria.
    const L = hitos[0] || {};
    const ic = L.ida?.coste, vc = L.vuelta?.coste;
    const it = ic ? ic[fin] : Infinity, vt = vc ? vc[fin] : Infinity;
    const usaI = it !== Infinity, usaV = vt !== Infinity;
    const h = (i, j, v) => {
        const x = (i - fi) * dxm, y = (j - fj) * dy;
        let best = Math.sqrt(x * x + y * y) * cmin;
        if (usaV) { const d = vc[v]; if (d !== Infinity && d - vt > best) best = d - vt; }
        if (usaI) { const d = ic[v]; if (d !== Infinity && it - d > best) best = it - d; }
        return best;
    };
    let expandidos = 0;
    coste[ini] = 0; padre[ini] = -1; sello[ini] = gen;
    heap.push(0, ini);
    const { arista } = ev;
    let ok = false;
    while (heap.n) {
        const u = heap.pop();
        if (cerrado[u] === gen) continue;
        cerrado[u] = gen;
        expandidos++;
        if (u === fin) { ok = true; break; }
        const uj = (u / W) | 0, ui = u - uj * W, cu = coste[u];
        for (let k = 0; k < 16; k++) {
            const vi = ui + DI[k], vj = uj + DJ[k];
            if (vi < 0 || vj < 0 || vi >= W || vj >= H) continue;
            const v = vj * W + vi;
            if (cerrado[v] === gen) continue;
            const c = arista(u, k, uj);
            if (c === Infinity) continue;
            const nc = cu + c;
            if (sello[v] !== gen || nc < coste[v]) {
                sello[v] = gen; coste[v] = nc; padre[v] = u;
                heap.push(nc + h(vi, vj, v), v);
            }
        }
    }
    if (!ok) return null;
    const celdas = [];
    for (let k = fin; k !== -1; k = padre[k]) celdas.push(k);
    celdas.reverse();
    return { celdas, coste: coste[fin], expandidos };
}

/** Tiempo, energía metabólica y calor acumulados a lo largo de una secuencia de celdas vecinas. */
export function acumular(g, ev, celdas) {
    const W = g.W;
    let c = 0, T = 0, E = 0, Q = 0;
    for (let n = 1; n < celdas.length; n++) {
        const a = celdas[n - 1], b = celdas[n];
        const aj = (a / W) | 0, k = kDe((b % W) - (a % W), ((b / W) | 0) - aj);
        const x = k >= 0 ? ev.arista(a, k, aj) : Infinity;
        if (x === Infinity) return null;
        const { t, M } = ev.sal;
        c += x; T += t; E += M * t; Q += Math.max(0, 0.8 * M - 90) * t;
    }
    return { c, T, E, Q };
}

/** Recorre el árbol de un campo de Dijkstra desde `celda` hasta la fuente (en campos inversos: camino de vuelta). */
export function caminoDesdeCampo(campo, celda) {
    const out = [];
    for (let k = celda, guard = 0; k !== -1 && guard < 1e6; k = campo.padre[k], guard++) out.push(k);
    return out;
}

/**
 * Coste de un segmento recto entre dos celdas, recorriéndolo por celdas vecinas (paso de media celda)
 * con el mismo modelo que las aristas. Infinity si cruza terreno intransitable.
 */
function costeRecto(g, ev, ka, kb) {
    const W = g.W;
    const ai = ka % W, aj = (ka / W) | 0, bi = kb % W, bj = (kb / W) | 0;
    const pasos = Math.max(1, Math.ceil(2 * Math.max(Math.abs(bi - ai), Math.abs(bj - aj))));
    let total = 0, cur = ka, ci = ai, cj = aj;
    for (let s = 1; s <= pasos; s++) {
        const qi = Math.round(ai + (bi - ai) * s / pasos), qj = Math.round(aj + (bj - aj) * s / pasos);
        if (qi === ci && qj === cj) continue;
        const k = kDe(qi - ci, qj - cj);
        if (k < 0) return Infinity;
        const c = ev.arista(cur, k, cj);
        if (c === Infinity) return Infinity;
        total += c;
        cur = qj * W + qi; ci = qi; cj = qj;
    }
    return total;
}

/**
 * Suavizado por línea de visión: une vértices lejanos si el tramo recto es transitable y no
 * cuesta más que el camino original (tolerancia 1 %). Devuelve las celdas conservadas.
 */
export function suavizar(g, ev, celdas) {
    if (celdas.length < 3) return celdas.slice();
    const W = g.W;
    const acum = [0];
    for (let n = 1; n < celdas.length; n++) {
        const a = celdas[n - 1], b = celdas[n];
        const k = kDe((b % W) - (a % W), ((b / W) | 0) - ((a / W) | 0));
        const c = k >= 0 ? ev.arista(a, k, (a / W) | 0) : Infinity;
        acum.push(acum[n - 1] + (Number.isFinite(c) ? c : 1e9));
    }
    const out = [celdas[0]];
    let i = 0;
    while (i < celdas.length - 1) {
        let mejor = i + 1;
        for (let j = Math.min(celdas.length - 1, i + 80); j > i + 1; j--) {
            if (costeRecto(g, ev, celdas[i], celdas[j]) <= (acum[j] - acum[i]) * 1.01) { mejor = j; break; }
        }
        out.push(celdas[mejor]);
        i = mejor;
    }
    return out;
}

export { MOVS };
