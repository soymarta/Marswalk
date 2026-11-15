/**
 * @module planificador.worker
 * @author Hani (módulo 5: rutas y seguridad)
 * @description Worker del planificador EVA. Toda la computación pesada vive aquí para que el mapa
 * no se congele: terreno, campos de coste, selección y orden de paradas, simulación de la EVA,
 * replanificación de emergencia, capas derivadas (pendiente, alcance seguro, sombras, cobertura)
 * y validación contra la traza real de Perseverance.
 *
 * Protocolo: postMessage({ id, tipo, ...args }) → { id, ok, res } | { id, ok:false, error } | { id, progreso }
 */
import { cargarTerreno, terrenoDesde, distancia, rumbo } from './terreno.js';
import { crearEvaluador, dijkstra, aEstrella, suavizar, caminoDesdeCampo, acumular } from './busqueda.js';
import { PERFILES, TRAJE_DEFECTO, velocidadMarcha, potenciaMetabolica, potenciaTraje, DOSIS_BASE_MSV_H, REFERENCIAS_CUERPO } from './eva.js';
import { sunPosition, ltst } from './marsTime.js';
import { cargarKernel, kernelActivo, usarKernel, sincronizarPeligro } from './kernel.js';

const BASE = new URL('../../', import.meta.url);
let T = null;               // { meta, g20, g40, fuentes }
const cache = new Map();    // campos de la base por perfil
let R = 3396190;

const progreso = (id, txt, frac) => postMessage({ id, progreso: { txt, frac } });

// ───────────────────────── utilidades ─────────────────────────

/** Celda transitable más cercana (búsqueda en espiral hasta `radio` celdas). */
function ajustarCelda(g, lon, lat, perfil, radio = 12) {
    const k0 = g.celda(lon, lat);
    if (k0 < 0) return -1;
    const libre = k => g.pend[k] <= perfil.pendienteMax && g.peligro[k] < 1;
    if (libre(k0)) return k0;
    const i0 = k0 % g.W, j0 = (k0 / g.W) | 0;
    for (let r = 1; r <= radio; r++) {
        let mejor = -1, md = Infinity;
        for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
            if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
            const i = i0 + di, j = j0 + dj;
            if (i < 0 || j < 0 || i >= g.W || j >= g.H) continue;
            const k = j * g.W + i;
            if (libre(k) && di * di + dj * dj < md) { md = di * di + dj * dj; mejor = k; }
        }
        if (mejor >= 0) return mejor;
    }
    return k0;
}

const claveTraje = t => [t.masaCorporal, t.masaTraje, t.carga].join('/');

/**
 * Radio físico máximo de una EVA de ida y vuelta (m): v_max · T_útil / 2. Fuera de él ninguna celda
 * puede pertenecer a una ruta factible, así que los campos se podan ahí sin perder exactitud.
 */
function radioEVA(traje, perfil) {
    let vmax = 0;
    for (let r = -0.5; r <= 0.5; r += 0.001) vmax = Math.max(vmax, velocidadMarcha(r, 0));
    return vmax * traje.duracionMaxH * 3600 * (1 - perfil.reserva) / 2 + 200;
}

/**
 * Campos de la base para un perfil (cacheados): el de VUELTA (coste de cada celda → base) se calcula
 * siempre; el de IDA (base → celda) solo cuando se pide (capa de alcance). Ambos sirven de hitos ALT.
 */
function camposBase(perfilId, hab, traje, { conIda = false } = {}) {
    const perfil = PERFILES[perfilId];
    const g = T.g40;
    const k = ajustarCelda(g, hab.lon, hab.lat, perfil);
    const clave = `${perfilId}|${k}|${claveTraje(traje)}|${traje.duracionMaxH}|${T.version || 0}`;
    let c = cache.get(clave);
    if (!c) {
        const ev = crearEvaluador(g, perfil, traje);
        const radioM = radioEVA(traje, perfil);
        const t0 = performance.now();
        c = { celda: k, ev, perfil, radioM, vuelta: dijkstra(g, k, ev, { inverso: true, radioM }), ida: null, pares: new Map() };
        c.msVuelta = performance.now() - t0;
        cache.set(clave, c);
        if (cache.size > 8) cache.delete(cache.keys().next().value);
    }
    if (conIda && !c.ida) c.ida = dijkstra(g, k, c.ev, { radioM: c.radioM });
    return c;
}

// ───────────────────────── condiciones ─────────────────────────

/** Temperatura del aire (°C) según la hora solar: climatología diurna tipo MEDA en Jezero. */
function temperatura(cond, horaLtst) {
    const media = cond.tempMediaC ?? -52, amp = cond.amplitudC ?? 33;
    return media + amp * Math.cos(2 * Math.PI * (horaLtst - 14) / 24);
}

function condicionesEn(cond, utc, lon, lat) {
    const sol = sunPosition(utc, lon, lat);
    const h = ltst(utc, lon);
    // La opacidad del polvo atenúa la radiación directa (Beer-Lambert con masa de aire).
    const masaAire = sol.elev > 0 ? 1 / Math.max(0.05, Math.sin(sol.elev * Math.PI / 180)) : Infinity;
    const directa = sol.elev > 0 ? sol.toa * Math.exp(-(cond.tau ?? 0.5) * masaAire) : 0;
    return { sol, horaLtst: h, tempC: temperatura(cond, h), directa,
        dosisMsvH: DOSIS_BASE_MSV_H * (cond.factorDosis ?? 1) };
}

/** ¿Está el punto a la sombra del relieve? Marcha hacia el Sol sobre la rejilla de 20 m. */
function enSombra(g, lon, lat, sol, alturaOjo = 1.7) {
    if (sol.elev <= 0) return true;
    const z0 = g.elevEn(lon, lat) + alturaOjo;
    const tanE = Math.tan(sol.elev * Math.PI / 180);
    const az = sol.az * Math.PI / 180;
    const paso = 30, maxElev = T.meta.elev_max;
    const dLon = Math.sin(az) * paso / (R * Math.cos(lat * Math.PI / 180)) * 180 / Math.PI;
    const dLat = Math.cos(az) * paso / R * 180 / Math.PI;
    for (let s = 1; s < 400; s++) {
        const alt = z0 + s * paso * tanE;
        if (alt > maxElev) return false;
        const lo = lon + dLon * s, la = lat + dLat * s;
        if (!g.dentro(lo, la)) return false;
        if (g.elevEn(lo, la) > alt) return true;
    }
    return false;
}

/** Línea de visión radio entre el astronauta (2 m) y el mástil de la base (10 m). */
function lineaVision(g, lon, lat, hab, hMastil = 10) {
    const z0 = g.elevEn(lon, lat) + 2, z1 = g.elevEn(hab.lon, hab.lat) + hMastil;
    const L = distancia(R, lon, lat, hab.lon, hab.lat);
    const n = Math.ceil(L / 30);
    for (let s = 1; s < n; s++) {
        const f = s / n;
        if (g.elevEn(lon + (hab.lon - lon) * f, lat + (hab.lat - lat) * f) > z0 + (z1 - z0) * f) return false;
    }
    return true;
}

// ───────────────────────── geometría de rutas ─────────────────────────

function celdasALineas(g, celdas) {
    return celdas.map(k => { const [lo, la] = g.lonlat(k); return [lo, la]; });
}

/** Densifica una polilínea a ≤ `maxM` m por tramo y añade la elevación del DTM de 20 m. */
function densificar(pts, maxM = 25) {
    const g = T.g20, out = [];
    for (let n = 0; n < pts.length; n++) {
        const [lo, la] = pts[n];
        if (n > 0) {
            const [lo0, la0] = pts[n - 1];
            const L = distancia(R, lo0, la0, lo, la);
            const k = Math.ceil(L / maxM);
            for (let s = 1; s < k; s++) {
                const f = s / k, x = lo0 + (lo - lo0) * f, y = la0 + (la - la0) * f;
                out.push([x, y, g.elevEn(x, y), 0]);
            }
        }
        out.push([lo, la, g.elevEn(lo, la), 1]); // 1 = vértice de maniobra
    }
    return out;
}

/** Camino fino (20 m) entre dos puntos con sus acumulados exactos; null si a 20 m no hay paso. */
function tramoFino(a, b, perfil, traje, ev20) {
    const g = T.g20;
    const ka = ajustarCelda(g, a[0], a[1], perfil, 20), kb = ajustarCelda(g, b[0], b[1], perfil, 20);
    const r = aEstrella(g, ka, kb, ev20);
    if (!r) return null;
    const ac = acumular(g, ev20, r.celdas);
    const linea = celdasALineas(g, suavizar(g, ev20, r.celdas));
    linea[0] = [a[0], a[1]]; linea[linea.length - 1] = [b[0], b[1]];
    return { linea, coste: r.coste, ...(ac || { T: 0, E: 0, Q: 0 }) };
}

// ───────────────────────── simulación de la EVA ─────────────────────────

/**
 * Simula la EVA a lo largo de la polilínea: tiempos, consumibles, sol, sombra, cobertura y margen de
 * retorno (con el campo de vuelta a la base). `paradas` = [{ idx, trabajoS, ... }] sobre los puntos.
 */
function simular(pts, paradas, { traje, cond, inicioUTC, perfil, hab, campos, usoInicial }) {
    const g = T.g20, n = pts.length;
    const A = k => new Float32Array(k);
    const s = {
        lon: new Float64Array(n), lat: new Float64Array(n), elev: A(n), dist: A(n), t: A(n), pend: A(n),
        o2: A(n), bat: A(n), agua: A(n), dosis: A(n), margen: A(n), solElev: A(n), sombra: new Uint8Array(n),
        cobertura: new Uint8Array(n), ltst: A(n), tempC: A(n), vertice: new Uint8Array(n),
        met: A(n), ener: A(n), dtm: A(n),   // tramo que llega a k: potencia metabólica (W), segundos andando; energía acumulada (kJ)
    };
    const reserva = perfil.reserva;
    let uso = { o2: 0, bat: 0, agua: 0, dosis: 0, t: 0, E: 0, ...(usoInicial || {}) };
    uso.E = uso.E || 0;
    let dist = 0;
    const porIdx = new Map(paradas.map(p => [p.idx, p]));
    const cap = traje;
    const fr = u => Math.max(u.o2 / cap.o2Kg, u.bat / cap.bateriaWh, u.agua / cap.aguaKg, u.t / (cap.duracionMaxH * 3600));
    const vuelta = campos?.vuelta;

    const registrar = (k, c, sombra) => {
        s.t[k] = uso.t - (usoInicial?.t || 0);
        s.ener[k] = (uso.E - (usoInicial?.E || 0)) / 1000;
        s.o2[k] = uso.o2 / cap.o2Kg; s.bat[k] = uso.bat / cap.bateriaWh; s.agua[k] = uso.agua / cap.aguaKg;
        s.dosis[k] = uso.dosis; s.solElev[k] = c.sol.elev; s.ltst[k] = c.horaLtst; s.tempC[k] = c.tempC;
        s.sombra[k] = sombra ? 1 : 0;
        // Margen: lo que queda tras volver a la base desde aquí, por encima de la reserva.
        let m = 1 - reserva - fr(uso);
        if (vuelta) {
            const kc = T.g40.celda(s.lon[k], s.lat[k]);
            if (kc >= 0 && Number.isFinite(vuelta.coste[kc])) {
                const tR = vuelta.T[kc];
                const ret = {
                    o2: uso.o2 + vuelta.E[kc] / 20100 * 1.429e-3,
                    bat: uso.bat + potenciaTraje(traje, c.tempC, false) * tR / 3600,
                    agua: uso.agua + vuelta.Q[kc] / 2.45e6,
                    t: uso.t + tR,
                };
                m = 1 - reserva - fr(ret);
            } else m = -1;
        }
        s.margen[k] = m;
    };

    for (let k = 0; k < n; k++) {
        const [lo, la, z, vert] = pts[k];
        s.lon[k] = lo; s.lat[k] = la; s.elev[k] = z; s.vertice[k] = vert;
        const kc = g.celda(lo, la);
        s.pend[k] = kc >= 0 ? g.pend[kc] : 0;
        let c = condicionesEn(cond, inicioUTC + uso.t * 1000, lo, la);
        if (k > 0) {
            const d = distancia(R, s.lon[k - 1], s.lat[k - 1], lo, la);
            const dz = z - s.elev[k - 1];
            const ras = d > 0.01 ? dz / d : 0;
            const rug = kc >= 0 ? g.rug[kc] : 0;
            const v = velocidadMarcha(ras, rug);
            const dt = Math.hypot(d, dz) / v;
            const M = potenciaMetabolica(v, ras, rug, traje);
            const somb = enSombra(g, lo, la, c.sol);
            uso.o2 += M * dt / 20100 * 1.429e-3;
            uso.E += M * dt;
            s.met[k] = M; s.dtm[k] = dt;
            uso.bat += potenciaTraje(traje, c.tempC, somb) * dt / 3600;
            uso.agua += Math.max(0, 0.8 * M - 90) * dt / 2.45e6;
            uso.dosis += c.dosisMsvH * dt / 3600;
            uso.t += dt;
            dist += d;
            c = condicionesEn(cond, inicioUTC + uso.t * 1000, lo, la);
        }
        s.dist[k] = dist;
        const somb = enSombra(g, lo, la, c.sol);
        s.cobertura[k] = hab ? (lineaVision(g, lo, la, hab) ? 1 : 0) : 1;
        registrar(k, c, somb);
        const parada = porIdx.get(k);
        if (parada) {
            parada.llegadaS = s.t[k];
            parada.llegadaLtst = c.horaLtst;
            parada.margenLlegada = s.margen[k];
            parada.o2Llegada = 1 - s.o2[k];
            if (parada.trabajoS > 0) {
                const Mw = REFERENCIAS_CUERPO.trabajoParadaW; // trabajo de campo; medias de EVA del Apolo 200-250 kcal/h
                uso.o2 += Mw * parada.trabajoS / 20100 * 1.429e-3;
                uso.E += Mw * parada.trabajoS;
                uso.bat += potenciaTraje(traje, c.tempC, somb) * parada.trabajoS / 3600;
                uso.agua += Math.max(0, 0.8 * Mw - 90) * parada.trabajoS / 2.45e6;
                uso.dosis += c.dosisMsvH * parada.trabajoS / 3600;
                uso.t += parada.trabajoS;
            }
            parada.salidaS = uso.t - (usoInicial?.t || 0);
            parada.margenSalida = 1 - reserva - fr(uso);
        }
    }
    const fin = { ...uso };
    return { s, fin, fraccionFinal: fr(fin) };
}

/** Agrupa tramos contiguos que cumplen una condición en alertas con su intervalo. */
function tramos(s, cond, minPuntos = 2) {
    const out = [];
    let ini = -1;
    for (let k = 0; k <= s.t.length; k++) {
        const c = k < s.t.length && cond(k);
        if (c && ini < 0) ini = k;
        if (!c && ini >= 0) { if (k - ini >= minPuntos) out.push([ini, k - 1]); ini = -1; }
    }
    return out;
}

function evaluar(sim, perfil, cond, paradas) {
    const { s } = sim;
    const alertas = [];
    const n = s.t.length;
    const add = (tipo, nivel, texto, rango) => alertas.push({ tipo, nivel, texto, ini: rango?.[0] ?? 0, fin: rango?.[1] ?? 0 });

    for (const r of tramos(s, k => s.pend[k] > perfil.pendienteMax * 0.8))
        add('pendiente', 'precaucion', `Pendiente de hasta ${Math.max(...s.pend.slice(r[0], r[1] + 1)).toFixed(0)}° (${(s.dist[r[1]] - s.dist[r[0]]).toFixed(0)} m)`, r);
    for (const r of tramos(s, k => s.sombra[k] && s.solElev[k] > 0, 3))
        add('sombra', 'info', `Tramo en sombra del relieve: más frío y sin aporte solar (${((s.t[r[1]] - s.t[r[0]]) / 60).toFixed(0)} min)`, r);
    for (const r of tramos(s, k => !s.cobertura[k], 3))
        add('cobertura', 'precaucion', `Sin línea de visión con la base: solo relé orbital (${((s.t[r[1]] - s.t[r[0]]) / 60).toFixed(0)} min)`, r);
    for (const r of tramos(s, k => s.solElev[k] <= 0, 1))
        add('noche', 'critica', 'El Sol se pone antes de volver a la base', r);
    for (const r of tramos(s, k => s.solElev[k] > 0 && s.solElev[k] < 10, 2))
        add('solBajo', 'precaucion', `Sol bajo (<10°): sombras largas, poca luz y frío`, r);
    let pnr = -1, minM = Infinity, minK = 0;
    for (let k = 0; k < n; k++) {
        if (s.margen[k] < minM) { minM = s.margen[k]; minK = k; }
        if (pnr < 0 && s.margen[k] < 0) pnr = k;
    }
    if (pnr >= 0) add('pnr', 'critica', 'Punto de no retorno superado: los consumibles no alcanzan para volver con reserva', [pnr, n - 1]);
    if ((cond.tau ?? 0) > 2) add('polvo', 'critica', `Tormenta de polvo (τ = ${cond.tau.toFixed(2)} > 2)`);
    else if ((cond.tau ?? 0) > 1) add('polvo', 'precaucion', `Atmósfera muy cargada de polvo (τ = ${cond.tau.toFixed(2)})`);
    if ((cond.vientoMs ?? 0) > 30) add('viento', 'critica', `Viento de ${cond.vientoMs.toFixed(0)} m/s: riesgo de levantamiento de polvo`);
    else if ((cond.vientoMs ?? 0) > 20) add('viento', 'precaucion', `Viento fuerte (${cond.vientoMs.toFixed(0)} m/s)`);
    if (cond.tormentaSolar) add('radiacion', 'critica', 'Evento de partículas solares: refugio inmediato');
    if (sim.fraccionFinal > 1 - perfil.reserva + 1e-6) add('reserva', 'critica', `Se vuelve con menos de la reserva del ${(perfil.reserva * 100).toFixed(0)} %`);

    const criticas = alertas.filter(a => a.nivel === 'critica').length;
    const prec = alertas.filter(a => a.nivel === 'precaucion').length + (minM < 0.1 ? 1 : 0);
    const veredicto = criticas ? 'NO-GO' : prec ? 'PRECAUCIÓN' : 'GO';
    return { alertas, veredicto, pnr, puntoCompromiso: minK, margenMin: minM };
}

// ───────────────────────── planificación ─────────────────────────

/**
 * Selección y orden de paradas: DP exacta sobre subconjuntos (n ≤ 12) que maximiza el valor científico
 * con la EVA dentro de los límites de consumibles + reserva del perfil (problema de orientación).
 */
function elegirParadas(nodos, M, traje, perfil, tempC, usoInicial = null) {
    const n = nodos.length - 1; // nodo 0 = inicio; destino final = base (fila `vuelta` de M)
    const lim = 1 - perfil.reserva;
    const S = 1 << n;
    const best = new Float64Array(S * n).fill(Infinity);
    const acum = new Array(S * n);
    const prev = new Int32Array(S * n).fill(-1);
    const pBat = potenciaTraje(traje, tempC, false);
    // Consumibles ya gastados (replanificación a mitad de EVA) + los del recorrido candidato.
    const U0 = { o2: 0, bat: 0, agua: 0, t: 0, ...(usoInicial || {}) };
    const fr = u => Math.max((u.E / 20100 * 1.429e-3 + U0.o2) / traje.o2Kg, (pBat * u.T / 3600 + U0.bat) / traje.bateriaWh,
        (u.Q / 2.45e6 + U0.agua) / traje.aguaKg, (u.T + U0.t) / (traje.duracionMaxH * 3600));
    const suma = (u, p, j) => {
        const w = nodos[j + 1].trabajoS, Mw = REFERENCIAS_CUERPO.trabajoParadaW;
        return { T: u.T + p.T + w, E: u.E + p.E + Mw * w, Q: u.Q + p.Q + Math.max(0, 0.8 * Mw - 90) * w, c: u.c + p.c };
    };
    const ini = { T: 0, E: 0, Q: 0, c: 0 };
    for (let j = 0; j < n; j++) {
        const p = M.ida[0][j + 1];
        if (!p) continue;
        const u = suma(ini, p, j);
        if (fr(u) > lim) continue;
        best[(1 << j) * n + j] = u.c; acum[(1 << j) * n + j] = u;
    }
    for (let m = 1; m < S; m++) for (let j = 0; j < n; j++) {
        const id = m * n + j;
        if (!(m & (1 << j)) || best[id] === Infinity) continue;
        for (let k = 0; k < n; k++) {
            if (m & (1 << k)) continue;
            const p = M.ida[j + 1][k + 1];
            if (!p) continue;
            const u = suma(acum[id], p, k);
            if (fr(u) > lim) continue;
            const id2 = (m | (1 << k)) * n + k;
            if (u.c < best[id2]) { best[id2] = u.c; acum[id2] = u; prev[id2] = j; }
        }
    }
    // Cierre: volver a la base. Valor = Σ ciencia; desempate por coste.
    const obligatorias = nodos.slice(1).reduce((a, nd, j) => nd.obligatoria ? a | (1 << j) : a, 0);
    let mejor = { valor: -1, coste: Infinity, m: 0, j: -1, u: null };
    const valorDe = m => { let v = 0; for (let j = 0; j < n; j++) if (m & (1 << j)) v += nodos[j + 1].valor; return v; };
    for (let m = 0; m < S; m++) {
        if ((m & obligatorias) !== obligatorias) continue;
        const candidatos = m === 0 ? [{ u: ini, j: -1 }] : [];
        for (let j = 0; j < n && m; j++) if (best[m * n + j] < Infinity) candidatos.push({ u: acum[m * n + j], j });
        for (const { u, j } of candidatos) {
            const r = M.vuelta[j + 1];
            if (!r) continue;
            const tot = { T: u.T + r.T, E: u.E + r.E, Q: u.Q + r.Q, c: u.c + r.c };
            if (fr(tot) > lim) continue;
            const v = valorDe(m);
            if (v > mejor.valor || (v === mejor.valor && tot.c < mejor.coste)) mejor = { valor: v, coste: tot.c, m, j, u: tot };
        }
    }
    if (mejor.valor < 0) return null;
    const orden = [];
    for (let m = mejor.m, j = mejor.j; j >= 0;) { orden.push(j + 1); const pj = prev[m * n + j]; m &= ~(1 << j); j = pj; }
    orden.reverse();
    return { orden, valor: mejor.valor, fraccion: fr(mejor.u), estimado: mejor.u };
}

/**
 * `inicio` y `fin` son opcionales (por defecto, la base). El fin es el refugio de llegada (la base u otro, p. ej. un
 * rover presurizado): de él salen el campo de vuelta, el margen de retorno y la ruta de emergencia. El mástil de
 * radio sigue en la base (`habitat`).
 */
function planificar(id, { habitat, inicio, fin, paradas, perfil: perfilId, traje: trajeIn, cond = {}, inicioUTC, usoInicial, paresCache }) {
    const destino = fin || habitat;
    const perfil = PERFILES[perfilId];
    const traje = { ...TRAJE_DEFECTO, ...trajeIn, reserva: perfil.reserva };
    const g = T.g40;
    progreso(id, 'Campos de coste de la base', 0.1);
    const campos = camposBase(perfilId, destino, traje);
    const origen = inicio || habitat;
    const kOrigen = inicio ? ajustarCelda(g, origen.lon, origen.lat, perfil) : campos.celda;
    const validas = paradas.filter(p => g.dentro(p.lon, p.lat)).slice(0, 12);
    const nodos = [{ ...origen, celda: kOrigen, trabajoS: 0, valor: 0 },
        ...validas.map(p => ({ ...p, celda: ajustarCelda(g, p.lon, p.lat, perfil), trabajoS: (p.trabajoMin || 0) * 60 }))];
    const celdas = nodos.map(nd => nd.celda);
    // Matriz de costes por pares en la rejilla de 40 m: ida[i][j] (i→j) por A* con hitos ALT
    // (los campos de la base) y vuelta[i] (i→base) leída directamente del campo de vuelta.
    const M = { ida: nodos.map(() => new Array(nodos.length).fill(null)), vuelta: [], exacto: new Set() };
    const pack = (f, k) => Number.isFinite(f.coste[k]) ? { c: f.coste[k], T: f.T[k], E: f.E[k], Q: f.Q[k] } : null;
    const hitos = [{ ida: campos.ida, vuelta: campos.vuelta }];
    // Caché exacta de costes por pares (la página la guarda entre sesiones; la clave incluye la versión del terreno)
    if (paresCache) for (const [k, v] of Object.entries(paresCache)) if (!campos.pares.has(k)) campos.pares.set(k, v);
    const paresNuevos = {};
    let expandidos = 0;
    const t0 = performance.now();
    for (let i = 0; i < nodos.length; i++) M.vuelta[i] = pack(campos.vuelta, celdas[i]);
    for (let i = 0; i < nodos.length; i++) {
        progreso(id, `Costes entre paradas ${i + 1}/${nodos.length}`, 0.15 + 0.4 * i / nodos.length);
        for (let j = 1; j < nodos.length; j++) {
            if (j === i || !M.vuelta[j]) continue;  // una parada sin vuelta posible nunca es elegible
            // Caché por (perfil, celdas): al replanificar con las mismas paradas el coste es inmediato.
            const clave = `${celdas[i]}>${celdas[j]}`;
            if (!campos.pares.has(clave)) {
                const r = aEstrella(g, celdas[i], celdas[j], campos.ev, { hitos });
                if (r) expandidos += r.expandidos;
                campos.pares.set(clave, r ? acumular(g, campos.ev, r.celdas) : null);
                paresNuevos[clave] = campos.pares.get(clave);
            }
            M.ida[i][j] = campos.pares.get(clave);
        }
    }
    const msPares = performance.now() - t0;
    const tempMedia = cond.tempMediaC ?? -52;
    const inalcanzables = nodos.slice(1).filter((nd, j) => !M.ida[0][j + 1] || !M.vuelta[j + 1]).map(nd => nd.id);

    // Refinamiento exacto perezoso: los tramos del recorrido elegido se recalculan a 20 m y se
    // reinyectan en la matriz; se re-optimiza hasta que el recorrido no cambia (o 4 iteraciones).
    progreso(id, 'Optimizando paradas y refinando a 20 m', 0.6);
    const ev20 = crearEvaluador(T.g20, perfil, traje);
    const finos = new Map();
    const puntoDe = i => i === 'base' ? [destino.lon, destino.lat] : [nodos[i].lon, nodos[i].lat];
    const tramoExacto = (a, b) => {
        const clave = `${a}>${b}`;
        if (!finos.has(clave)) finos.set(clave, tramoFino(puntoDe(a), puntoDe(b), perfil, traje, ev20));
        return finos.get(clave);
    };
    let sel = null, iteraciones = 0, previo = '';
    for (; iteraciones < 4; iteraciones++) {
        sel = elegirParadas(nodos, M, traje, perfil, tempMedia + 15, usoInicial);
        if (!sel) break;
        const firma = sel.orden.join(',');
        if (firma === previo) break;
        previo = firma;
        const seq = [0, ...sel.orden, 'base'];
        for (let n = 0; n + 1 < seq.length; n++) {
            const a = seq[n], b = seq[n + 1];
            const f = tramoExacto(a, b);
            if (!f) { if (b === 'base') M.vuelta[a] = null; else M.ida[a][b] = null; continue; }
            const ex = { c: f.coste, T: f.T, E: f.E, Q: f.Q };
            if (b === 'base') M.vuelta[a] = ex; else M.ida[a][b] = ex;
        }
    }
    if (!sel) return { factible: false, motivo: 'Ninguna combinación de paradas cabe en los consumibles con la reserva exigida.', inalcanzables, paresNuevos };

    const secuencia = [0, ...sel.orden];
    const pts = [];
    const paradasRuta = [];
    const tramosOut = [];
    const legs = secuencia.map((a, n) => [a, n + 1 < secuencia.length ? secuencia[n + 1] : 'base']);
    for (const [a, b] of legs) {
        const f = tramoExacto(a, b);
        let linea = f?.linea;
        if (!linea) { // respaldo: camino de 40 m (solo si a 20 m no hay paso, p. ej. por el ajuste de celdas)
            const destino = b === 'base' ? campos.celda : nodos[b].celda;
            const r = aEstrella(g, nodos[a].celda, destino, campos.ev, { hitos });
            linea = r ? celdasALineas(g, suavizar(g, campos.ev, r.celdas)) : [puntoDe(a), puntoDe(b)];
        }
        const d = densificar(linea);
        const offset = pts.length ? pts.length - 1 : 0;
        if (pts.length) d.shift();
        pts.push(...d);
        tramosOut.push({ desde: a === 0 ? 'inicio' : nodos[a].id, hasta: b === 'base' ? 'base' : nodos[b].id, ini: offset, fin: pts.length - 1 });
        if (b !== 'base') paradasRuta.push({ id: nodos[b].id, nombre: nodos[b].nombre, idx: pts.length - 1, trabajoS: nodos[b].trabajoS, valor: nodos[b].valor });
    }
    const rendimiento = { motor: kernelActivo() ? 'wasm' : 'js', msVuelta: campos.msVuelta, msPares, expandidosPares: expandidos, iteraciones,
        radioKm: campos.radioM / 1000, celdas40: g.W * g.H, celdas20: T.g20.W * T.g20.H };
    progreso(id, 'Simulando la EVA', 0.85);
    const sim = simular(pts, paradasRuta, { traje, cond, inicioUTC, perfil, hab: habitat, campos, usoInicial });
    const ev = evaluar(sim, perfil, cond, paradasRuta);
    const omitidas = validas.filter(p => !paradasRuta.some(r => r.id === p.id)).map(p => p.id);
    const res = {
        factible: true, perfil: perfilId, valorCiencia: sel.valor,
        valorMaximo: validas.reduce((a, p) => a + p.valor, 0),
        paradas: paradasRuta, tramos: tramosOut, omitidas, inalcanzables,
        muestras: sim.s, fin: sim.fin, fraccionFinal: sim.fraccionFinal,
        ...ev,
        distancia: sim.s.dist[sim.s.dist.length - 1], duracion: sim.s.t[sim.s.t.length - 1],
        desnivelPositivo: sim.s.elev.reduce((a, z, k) => k && z > sim.s.elev[k - 1] ? a + z - sim.s.elev[k - 1] : a, 0),
        pendienteMax: Math.max(...sim.s.pend),
        traje, rendimiento, paresNuevos,
    };
    return res;
}

/** Ruta de vuelta inmediata a la base desde una posición (sigue el árbol del campo de vuelta). */
function abortar(id, { habitat, fin, posicion, perfil: perfilId, traje: trajeIn, cond = {}, utc, usoInicial }) {
    const destino = fin || habitat;
    const perfil = PERFILES[perfilId];
    const traje = { ...TRAJE_DEFECTO, ...trajeIn, reserva: perfil.reserva };
    const campos = camposBase(perfilId, destino, traje);
    const g = T.g40;
    let k = ajustarCelda(g, posicion.lon, posicion.lat, perfil);
    if (!Number.isFinite(campos.vuelta.coste[k])) {
        // Intenta con el perfil más permisivo antes de rendirse
        const c2 = camposBase('ciencia', destino, traje);
        if (!Number.isFinite(c2.vuelta.coste[k])) return { factible: false, motivo: 'Sin camino transitable a la base' };
        return abortar(id, { habitat, fin, posicion, perfil: 'ciencia', traje: trajeIn, cond, utc, usoInicial });
    }
    const celdas = caminoDesdeCampo(campos.vuelta, k);
    const suave = suavizar(g, campos.ev, celdas);
    const linea = celdasALineas(g, suave);
    linea[0] = [posicion.lon, posicion.lat];
    linea[linea.length - 1] = [destino.lon, destino.lat];
    const pts = densificar(linea);
    const sim = simular(pts, [], { traje, cond, inicioUTC: utc, perfil, hab: habitat, campos, usoInicial });
    const ev = evaluar(sim, perfil, cond, []);
    return { factible: true, perfil: perfilId, muestras: sim.s, fin: sim.fin, fraccionFinal: sim.fraccionFinal, ...ev,
        distancia: sim.s.dist[sim.s.dist.length - 1], duracion: sim.s.t[sim.s.t.length - 1] };
}

// ───────────────────────── capas derivadas (RGBA) ─────────────────────────

function capaPendiente(perfilId) {
    const g = T.g40, p = PERFILES[perfilId], n = g.W * g.H, px = new Uint8ClampedArray(n * 4);
    for (let k = 0; k < n; k++) {
        const q = g.pend[k] / p.pendienteMax;
        let c = null;
        if (q > 1) c = [255, 40, 110, 165];
        else if (q > 0.75) c = [255, 110, 40, 115];
        else if (q > 0.5) c = [255, 200, 60, 55];
        if (c) px.set(c, k * 4);
    }
    return { ancho: g.W, alto: g.H, px, bounds: g.bounds() };
}

/**
 * Límite de vuelta a pie (walkback limit): celdas a las que se puede llegar y volver a la base andando sin bajar de
 * la reserva del perfil en O₂, batería, agua ni tiempo. Sin `desde`, con los consumibles llenos y saliendo de la base;
 * con `desde` (posición actual) y `usado` (fracciones ya gastadas), lo que queda alcanzable desde aquí y ahora:
 * coste(aquí → celda) + coste(celda → base) + lo gastado ≤ 1 − reserva. Las celdas con ≤ la mitad de ese
 * presupuesto se marcan aparte (borde interior).
 */
function capaAlcance(perfilId, habitat, trajeIn, cond = {}, desde = null, usado = null) {
    const perfil = PERFILES[perfilId];
    const traje = { ...TRAJE_DEFECTO, ...trajeIn };
    const c = camposBase(perfilId, habitat, traje, { conIda: !desde });
    const g = T.g40, n = g.W * g.H, ok = new Uint8Array(n);
    const u = { o2: 0, bat: 0, agua: 0, t: 0, ...(usado || {}) };
    const lim = 1 - perfil.reserva;
    const tMax = traje.duracionMaxH * 3600;
    const gastado = Math.max(u.o2, u.bat, u.agua, u.t / tMax), libre = lim - gastado;
    let ida = c.ida, kDesde = c.celda;
    if (desde) {
        kDesde = ajustarCelda(g, desde.lon, desde.lat, perfil);
        let vmax = 0;
        for (let r = -0.5; r <= 0.5; r += 0.001) vmax = Math.max(vmax, velocidadMarcha(r, 0));
        ida = dijkstra(g, kDesde, c.ev, { radioM: Math.min(c.radioM * 2, vmax * Math.max(0, libre) * tMax + 200) });
    }
    const pBat = potenciaTraje(traje, (cond.tempMediaC ?? -52) + 15, false);
    for (let k = 0; k < n; k++) {
        if (!Number.isFinite(ida.coste[k]) || !Number.isFinite(c.vuelta.coste[k])) continue;
        const Tt = ida.T[k] + c.vuelta.T[k], E = ida.E[k] + c.vuelta.E[k], Q = ida.Q[k] + c.vuelta.Q[k];
        const f = Math.max(u.o2 + E / 20100 * 1.429e-3 / traje.o2Kg, u.bat + pBat * Tt / 3600 / traje.bateriaWh,
            u.agua + Q / 2.45e6 / traje.aguaKg, (u.t + Tt) / tMax);
        if (f <= lim) ok[k] = f - gastado <= libre * 0.5 ? 2 : 1;
    }
    let area = 0;
    for (let j = 0; j < g.H; j++) for (let i = 0; i < g.W; i++) if (ok[j * g.W + i]) area += g.dx[j] * g.dy;
    return { ...dibujarLimite(g, ok), bounds: g.bounds(), areaKm2: area / 1e6, desde: !!desde };
}

/**
 * Dibujo del límite de vuelta: fuera, una veladura oscura; dentro, limpio; una sola línea suave en el borde y otra
 * más tenue en el de la mitad del presupuesto. Los huecos interiores (cantiles, rocas: no se pisan, pero se rodean)
 * no se perfilan uno a uno. Se dibuja a 3× la rejilla de 40 m con el contorno suavizado, sin escalones de píxel.
 */
function dibujarLimite(g, ok) {
    const W = g.W, H = g.H, n = W * H;
    // Huecos: celdas no alcanzables que no tocan el exterior por otras no alcanzables.
    const fuera = new Uint8Array(n), pila = [];
    for (let i = 0; i < W; i++) { pila.push(i, (H - 1) * W + i); }
    for (let j = 0; j < H; j++) { pila.push(j * W, j * W + W - 1); }
    while (pila.length) {
        const k = pila.pop();
        if (fuera[k] || ok[k]) continue;
        fuera[k] = 1;
        const i = k % W;
        if (i > 0) pila.push(k - 1); if (i < W - 1) pila.push(k + 1);
        if (k >= W) pila.push(k - W); if (k < n - W) pila.push(k + W);
    }
    // Campos 0-1 (dentro del límite, dentro de la mitad) suavizados con una caja de 3 × 3, dos pasadas.
    const suave = f => {
        let a = Float32Array.from(f), b = new Float32Array(n);
        for (let pasada = 0; pasada < 2; pasada++) {
            for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
                let s = 0, c = 0;
                for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
                    const x = i + di, y = j + dj;
                    if (x < 0 || y < 0 || x >= W || y >= H) continue;
                    s += a[y * W + x]; c++;
                }
                b[j * W + i] = s / c;
            }
            [a, b] = [b, a];
        }
        return a;
    };
    const dentro = suave(Array.from(fuera, v => 1 - v));
    const mitad = suave(Array.from(ok, v => v === 2 ? 1 : 0));
    const E = 3, AW = W * E, AH = H * E, px = new Uint8ClampedArray(AW * AH * 4);
    const muestra = (f, x, y) => {
        const x0 = Math.min(W - 2, Math.max(0, x | 0)), y0 = Math.min(H - 2, Math.max(0, y | 0));
        const fx = Math.min(1, Math.max(0, x - x0)), fy = Math.min(1, Math.max(0, y - y0));
        const k = y0 * W + x0;
        return (f[k] * (1 - fx) + f[k + 1] * fx) * (1 - fy) + (f[k + W] * (1 - fx) + f[k + W + 1] * fx) * fy;
    };
    for (let y = 0; y < AH; y++) {
        const gy = (y + 0.5) / E - 0.5;
        for (let x = 0; x < AW; x++) {
            const gx = (x + 0.5) / E - 0.5;
            const v = muestra(dentro, gx, gy), h = muestra(mitad, gx, gy);
            // Distancia aproximada al contorno 0,5 en píxeles de salida: |v − 0,5| / |∇v|, con |∇v| ≈ 1/3 por celda.
            const dBorde = Math.abs(v - 0.5) * E * 3, dMitad = Math.abs(h - 0.5) * E * 3;
            const o = (y * AW + x) * 4;
            let r = 20, gg = 12, b = 8, a = v < 0.5 ? 105 : 0;                              // veladura fuera del límite
            const lMitad = Math.max(0, 1 - Math.abs(dMitad - 0) / 1.6) * 0.55;
            if (lMitad > 0 && v >= 0.5) { r = 140; gg = 235; b = 255; a = Math.max(a, 255 * lMitad); }
            const lBorde = Math.max(0, 1 - Math.max(0, dBorde - 1.2) / 1.4);                // línea de ~2,5 px
            if (lBorde > 0) { r = 90; gg = 240; b = 255; a = Math.max(a * (1 - lBorde), 255 * lBorde); }
            px[o] = r; px[o + 1] = gg; px[o + 2] = b; px[o + 3] = a;
        }
    }
    return { ancho: AW, alto: AH, px };
}

function capaSombra(utc) {
    const g = T.g40, n = g.W * g.H, px = new Uint8ClampedArray(n * 4);
    const [lo0, la0, lo1, la1] = g.bounds();
    const sol = sunPosition(utc, (lo0 + lo1) / 2, (la0 + la1) / 2);
    if (sol.elev <= 0) {
        for (let k = 0; k < n; k++) px.set([6, 6, 18, 175], k * 4);
        return { ancho: g.W, alto: g.H, px, bounds: g.bounds(), sol };
    }
    const tanE = Math.tan(sol.elev * Math.PI / 180), az = sol.az * Math.PI / 180;
    const si = Math.sin(az), sj = -Math.cos(az); // fila crece hacia el sur
    const paso = 0.75, maxZ = T.meta.elev_max;
    for (let j = 0; j < g.H; j++) {
        const pasoM = paso * Math.hypot(si * g.dx[j], sj * g.dy);
        for (let i = 0; i < g.W; i++) {
            const k = j * g.W + i, z0 = g.elev[k] + 1.7;
            let sombra = false;
            for (let s = 1; s < 600; s++) {
                const alt = z0 + s * pasoM * tanE;
                if (alt > maxZ) break;
                const x = i + si * paso * s, y = j + sj * paso * s;
                if (x < 0 || y < 0 || x > g.W - 1 || y > g.H - 1) break;
                if (g.elev[(y | 0) * g.W + (x | 0)] > alt) { sombra = true; break; }
            }
            if (sombra) px.set([14, 7, 4, 150], k * 4);
        }
    }
    return { ancho: g.W, alto: g.H, px, bounds: g.bounds(), sol };
}

function capaCobertura(habitat, hMastil = 10) {
    const g = T.g40, n = g.W * g.H, vis = new Uint8Array(n);
    const [hi, hj] = g.ij(habitat.lon, habitat.lat);
    const z0 = g.elevEn(habitat.lon, habitat.lat) + hMastil;
    const Rmax = Math.hypot(g.W, g.H);
    const rayos = Math.ceil(2 * Math.PI * Rmax * 1.2);
    for (let r = 0; r < rayos; r++) {
        const a = 2 * Math.PI * r / rayos, ci = Math.cos(a), cj = Math.sin(a);
        let maxPend = -Infinity;
        for (let s = 0.5; s < Rmax; s += 0.5) {
            const x = hi + ci * s, y = hj + cj * s;
            if (x < 0 || y < 0 || x > g.W - 1 || y > g.H - 1) break;
            const k = Math.round(y) * g.W + Math.round(x);
            const d = Math.hypot(ci * s * g.dxMedio, cj * s * g.dy);
            const pTerreno = (g.elev[k] - z0) / d;
            if ((g.elev[k] + 2 - z0) / d >= maxPend) vis[k] = 1;
            if (pTerreno > maxPend) maxPend = pTerreno;
        }
    }
    const px = new Uint8ClampedArray(n * 4);
    let visibles = 0;
    for (let j = 0; j < g.H; j++) for (let i = 0; i < g.W; i++) {
        const k = j * g.W + i;
        if (vis[k]) { visibles++; continue; }
        if ((i + j) % 6 < 2) px.set([190, 90, 255, 120], k * 4);
        else px.set([120, 60, 200, 38], k * 4);
    }
    return { ancho: g.W, alto: g.H, px, bounds: g.bounds(), fraccionVisible: visibles / n };
}

// ───────────────────────── zonas prohibidas ─────────────────────────

function dentroPoligono(x, y, anillo) {
    let c = false;
    for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
        const [xi, yi] = anillo[i], [xj, yj] = anillo[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
}

function fijarZonasProhibidas(poligonos) {
    const g = T.g20;
    if (!T.peligroBase) T.peligroBase = g.peligro.slice();
    g.peligro.set(T.peligroBase);
    for (const anillo of poligonos) {
        const lons = anillo.map(p => p[0]), lats = anillo.map(p => p[1]);
        const [i0, j0] = g.ij(Math.min(...lons), Math.max(...lats)), [i1, j1] = g.ij(Math.max(...lons), Math.min(...lats));
        for (let j = Math.max(0, Math.floor(j0)); j <= Math.min(g.H - 1, Math.ceil(j1)); j++)
            for (let i = Math.max(0, Math.floor(i0)); i <= Math.min(g.W - 1, Math.ceil(i1)); i++)
                if (dentroPoligono(g.lonDe(i), g.latDe(j), anillo)) g.peligro[j * g.W + i] = 1;
    }
    const g40 = T.g40;
    for (let j = 0; j < g40.H; j++) for (let i = 0; i < g40.W; i++) {
        let h = 0;
        for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) h = Math.max(h, g.peligro[(j * 2 + b) * g.W + i * 2 + a]);
        g40.peligro[j * g40.W + i] = h;
    }
    sincronizarPeligro(g); sincronizarPeligro(g40);
    T.version = (T.version || 0) + 1;
    cache.clear();
}

// ───────────────────────── validación con Perseverance ─────────────────────────

function distPuntoSegmento(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Distancia media y máxima (m) de los puntos de `real` a la polilínea `pred` (plano local). */
function desviacion(real, pred, lat) {
    const kx = R * Math.cos(lat * Math.PI / 180) * Math.PI / 180, ky = R * Math.PI / 180;
    const P = pred.map(([x, y]) => [x * kx, y * ky]);
    let suma = 0, max = 0;
    for (const [x0, y0] of real) {
        const x = x0 * kx, y = y0 * ky;
        let d = Infinity;
        for (let i = 1; i < P.length; i++) d = Math.min(d, distPuntoSegmento(x, y, P[i - 1][0], P[i - 1][1], P[i][0], P[i][1]));
        suma += d; max = Math.max(max, d);
    }
    return { media: suma / real.length, max };
}

function longitud(linea) {
    let L = 0;
    for (let i = 1; i < linea.length; i++) L += distancia(R, linea[i - 1][0], linea[i - 1][1], linea[i][0], linea[i][1]);
    return L;
}

function validar(id, { tramos: legs, pesos = null }) {
    const perfil = { ...PERFILES.rover, ...(pesos || {}) }, g = T.g20;
    const ev = crearEvaluador(g, perfil, TRAJE_DEFECTO);
    const out = [];
    legs.forEach((leg, n) => {
        progreso(id, `Tramo ${n + 1}/${legs.length}`, n / legs.length);
        const ka = ajustarCelda(g, leg.real[0][0], leg.real[0][1], perfil, 10);
        const fin = leg.real[leg.real.length - 1];
        const kb = ajustarCelda(g, fin[0], fin[1], perfil, 10);
        const r = aEstrella(g, ka, kb, ev);
        if (!r) return;
        const pred = celdasALineas(g, suavizar(g, ev, r.celdas));
        pred[0] = leg.real[0]; pred[pred.length - 1] = fin;
        const lat = leg.real[0][1];
        const dPred = desviacion(leg.real, pred, lat);
        const dRecta = desviacion(leg.real, [leg.real[0], fin], lat);
        out.push({ ...leg, pred, longReal: longitud(leg.real), longPred: longitud(pred),
            recta: distancia(R, leg.real[0][0], leg.real[0][1], fin[0], fin[1]),
            desvMedia: dPred.media, desvMax: dPred.max, desvRectaMedia: dRecta.media, desvRectaMax: dRecta.max });
    });
    const media = f => out.reduce((a, x) => a + f(x), 0) / Math.max(1, out.length);
    // Coherencia del mapa de transitabilidad: ¿qué fracción del terreno que el rover pisó de verdad
    // considera transitable nuestro modelo? (un "prohibido" donde el rover condujo sería un falso positivo)
    let pisados = 0, permitidos = 0;
    for (const leg of legs) for (const [lo, la] of leg.real) {
        const k = g.celda(lo, la);
        if (k < 0) continue;
        pisados++;
        if (g.pend[k] <= perfil.pendienteMax && g.peligro[k] < 1) permitidos++;
    }
    return {
        tramos: out,
        resumen: {
            n: out.length,
            desvMedia: media(x => x.desvMedia), desvRectaMedia: media(x => x.desvRectaMedia),
            mejoraFrac: 1 - media(x => x.desvMedia) / media(x => x.desvRectaMedia),
            ganaA: out.filter(x => x.desvMedia < x.desvRectaMedia).length,
            ratioLongitud: media(x => x.longPred / x.longReal),
            dentro50m: media(x => x.desvMedia < 50 ? 1 : 0),
            transitableReal: permitidos / Math.max(1, pisados),
            rectaMedia: media(x => x.recta),
        },
    };
}

// ───────────────────────── despachador ─────────────────────────

const transferibles = res => {
    const out = [];
    const visitar = o => {
        if (!o || typeof o !== 'object') return;
        if (ArrayBuffer.isView(o)) { out.push(o.buffer); return; }
        for (const v of Object.values(o)) visitar(v);
    };
    visitar(res);
    return [...new Set(out)];
};

self.onmessage = async ({ data }) => {
    const { id, tipo } = data;
    try {
        let res;
        if (tipo === 'init') {
            if (!T) {
                // Con `data.terreno` (arrays decodificados por otro worker) se evita volver a leer y decodificar los PNG.
                const [terreno] = await Promise.all([data.terreno ? terrenoDesde(data.terreno) : cargarTerreno(BASE), cargarKernel(new URL('ruta_kernel.wasm', import.meta.url))]);
                T = terreno; R = T.meta.radio_m;
            }
            const { meta, g20, g40, fuentes } = T;
            res = { meta, fuentes, bounds: g20.bounds(), motor: kernelActivo() ? 'wasm' : 'js',
                rejillaBusqueda: { ancho: g40.W, alto: g40.H, resM: g40.resM } };
        } else if (tipo === 'exportar') {
            const g = T.g20;
            res = { meta: T.meta, fuentes: T.fuentes, elev: g.elev.slice(), pend: g.pend.slice(), rug: g.rug.slice(), peligro: (T.peligroBase || g.peligro).slice() };
        } else if (tipo === 'motor') { usarKernel(data.wasm); cache.clear(); res = { motor: kernelActivo() ? 'wasm' : 'js' }; }
        else if (tipo === 'planificar') res = planificar(id, data);
        else if (tipo === 'abortar') res = abortar(id, data);
        else if (tipo === 'capa') {
            if (data.capa === 'pendiente') res = capaPendiente(data.perfil);
            else if (data.capa === 'alcance') res = capaAlcance(data.perfil, data.habitat, data.traje, data.cond, data.desde, data.usado);
            else if (data.capa === 'sombra') res = capaSombra(data.utc);
            else if (data.capa === 'cobertura') res = capaCobertura(data.habitat);
            // PNG codificado aquí (fuera del hilo de la página): la página solo recibe un Blob.
            if (data.png && res?.px) {
                const c = new OffscreenCanvas(res.ancho, res.alto);
                c.getContext('2d').putImageData(new ImageData(res.px, res.ancho, res.alto), 0, 0);
                const blob = await c.convertToBlob({ type: 'image/png' });
                res = { ...res, px: undefined, blob };
            }
        } else if (tipo === 'zonas') { fijarZonasProhibidas(data.poligonos); res = { ok: true }; }
        else if (tipo === 'precalentar') {
            // Campos de ida y vuelta de la base mientras el usuario mira el mapa: ALT con cotas en los dos
            // sentidos para la primera búsqueda y capa de alcance seguro instantánea.
            const traje = { ...TRAJE_DEFECTO, ...data.traje, reserva: PERFILES[data.perfil].reserva };
            const c = camposBase(data.perfil, data.habitat, traje, { conIda: !!data.conIda });
            res = { msVuelta: c.msVuelta };
        }
        else if (tipo === 'validar') res = validar(id, data);
        else if (tipo === 'elevaciones') res = data.puntos.map(([lo, la]) => T.g20.dentro(lo, la) ? T.g20.elevEn(lo, la) : null);
        else if (tipo === 'rumbo') res = rumbo(...data.args);
        else throw new Error(`Tipo de mensaje desconocido: ${tipo}`);
        postMessage({ id, ok: true, res }, transferibles(res));
    } catch (e) {
        console.error(e);
        postMessage({ id, ok: false, error: String(e?.stack || e) });
    }
};
