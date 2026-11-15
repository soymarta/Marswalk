/**
 * @module kernel
 * @author Hani
 * @description Puente JS ↔ WebAssembly del núcleo de búsqueda (wasm/ruta_kernel.c).
 * Las rejillas se suben una vez; las tablas del modelo de coste son las mismas que usa la versión JS,
 * así que ambos motores dan resultados idénticos. Si el .wasm no carga, busqueda.js usa JS.
 */

let K = null;

export async function cargarKernel(url) {
    try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(resp.status);
        const { instance } = await WebAssembly.instantiate(await resp.arrayBuffer(), {});
        K = instance.exports;
        return true;
    } catch (e) {
        console.warn('[ruta] núcleo WASM no disponible, se usa JS:', e);
        K = null;
        return false;
    }
}

let activo = true;
export const kernelActivo = () => !!K && activo;
export const usarKernel = v => { activo = v; };

const subir = (arr, Ctor) => {
    const p = K.reservar(arr.byteLength);
    if (!p) throw new Error('WASM sin memoria');
    new Ctor(K.memory.buffer, p, arr.length).set(arr);
    return p;
};

const rejillas = new WeakMap();
function rejillaWasm(g) {
    let r = rejillas.get(g);
    if (r) return r;
    const dTab = new Float32Array(g.H * 32);
    const MOV = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
        [1, 2], [-1, 2], [1, -2], [-1, -2], [2, 1], [2, -1], [-2, 1], [-2, -1]];
    for (let j = 0; j < g.H; j++) for (let k = 0; k < 32; k++) {
        const [di, dj] = MOV[k % 16];
        const x = di * g.dx[j], y = dj * g.dy;
        dTab[j * 32 + k] = Math.sqrt(x * x + y * y);
    }
    const pElev = subir(g.elev, Float32Array), pPend = subir(g.pend, Float32Array);
    const pRug = subir(g.rug, Float32Array), pPel = subir(g.peligro, Float32Array);
    const pD = subir(dTab, Float32Array);
    r = { ptr: K.rejilla_crear(g.W, g.H, g.dxMedio, g.dy, pElev, pPend, pRug, pPel, pD), pPel, n: g.W * g.H };
    rejillas.set(g, r);
    return r;
}

/** Vuelve a copiar la capa de peligro (zonas prohibidas dibujadas por el usuario). */
export function sincronizarPeligro(g) {
    const r = K && rejillas.get(g);
    if (r) { new Float32Array(K.memory.buffer, r.pPel, r.n).set(g.peligro); K.rejilla_sync(r.ptr); }
}

function evaluadorWasm(g, ev) {
    if (ev._wasm) return ev._wasm;
    const r = rejillaWasm(g), t = ev.tablas;
    const pT = subir(t.tabT, Float32Array), pM = subir(t.tabM, Float32Array), pC = subir(t.tabC, Float32Array);
    ev._wasm = K.evaluador_crear(r.ptr, t.esRover ? 1 : 0, t.pMax, t.rasMax, t.pesoR, t.pesoU,
        t.NR, t.PR, t.NU, t.PU, pT, pM, pC);
    return ev._wasm;
}

// Ranuras fijas para los campos-hito de ALT (evita crecer la memoria con cada perfil cacheado).
const ranuras = [];
let turno = 0;
function hitoWasm(campo, n) {
    if (!campo) return 0;
    let r = ranuras.find(x => x.campo === campo && x.n === n);
    if (r) return r.ptr;
    r = ranuras.find(x => x.n === n && !x.campo) || (ranuras.length < 6 ? null : ranuras.filter(x => x.n === n)[turno++ % 2]);
    if (!r) { r = { ptr: K.reservar(n * 8), n }; ranuras.push(r); }
    r.campo = campo;
    new Float64Array(K.memory.buffer, r.ptr, n).set(campo);
    return r.ptr;
}

export function dijkstraWasm(g, fuente, ev, { inverso = false, objetivos = null, radioM = Infinity } = {}) {
    const pe = evaluadorWasm(g, ev);
    const n = g.W * g.H;
    const m = K.marca();
    const pObj = objetivos?.length ? subir(Int32Array.from(objetivos), Int32Array) : 0;
    const pC = K.reservar(n * 8), pT = K.reservar(n * 4), pE = K.reservar(n * 4), pQ = K.reservar(n * 4), pP = K.reservar(n * 4);
    const cerrados = K.dijkstra(pe, fuente, inverso ? 1 : 0, Number.isFinite(radioM) ? radioM : 1e308,
        pObj, objetivos?.length || 0, pC, pT, pE, pQ, pP);
    if (cerrados < 0) { K.liberar(m); throw new Error('WASM: memoria agotada en Dijkstra'); }
    const B = K.memory.buffer;
    const res = {
        coste: new Float64Array(B, pC, n).slice(), T: new Float32Array(B, pT, n).slice(),
        E: new Float32Array(B, pE, n).slice(), Q: new Float32Array(B, pQ, n).slice(),
        padre: new Int32Array(B, pP, n).slice(), fuente, inverso, cerrados,
    };
    K.liberar(m);
    return res;
}

export function aEstrellaWasm(g, ini, fin, ev, { hitos = [] } = {}) {
    if (ini < 0 || fin < 0) return null;
    const pe = evaluadorWasm(g, ev);
    const n = g.W * g.H;
    const L = hitos[0] || {};
    const pI = L.ida ? hitoWasm(L.ida.coste, n) : 0, pV = L.vuelta ? hitoWasm(L.vuelta.coste, n) : 0;
    const m = K.marca();
    const pCam = K.reservar(n * 4), pInfo = K.reservar(16);
    const len = K.aestrella(pe, ini, fin, ev.cmin, pI, pV, pCam, n, pInfo);
    const B = K.memory.buffer;
    const info = new Float64Array(B, pInfo, 2);
    const res = len ? { celdas: Array.from(new Int32Array(B, pCam, len)).reverse(), coste: info[0], expandidos: info[1] } : null;
    K.liberar(m);
    return res;
}
