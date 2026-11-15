/**
 * @module mundo3d
 * @author Hani (módulo 5: rutas y seguridad)
 * @description Mundo 3D de la navegación: un renderizador propio (three.js) para caminar por Jezero a 60 fps.
 * Sustituye al relieve 3D de MapLibre mientras se navega (cámara de seguimiento) y en el modo astronauta (primera
 * persona). MapLibre sigue siendo el mapa para planificar y para la navegación 2D.
 *
 * Por qué: con la cámara en movimiento, el relieve de MapLibre iba a 6 fps (seguimiento) y a 1-2 fps (astronauta) en
 * un portátil con GPU integrada; aquí el terreno son mallas ya subidas a la GPU y un sombreador sencillo.
 *
 * Datos (los mismos del planificador, ninguno nuevo):
 *  - terreno lejano: rejilla del DTM CTX de 20 m que ya tienen los workers del planificador (una sola malla) con la
 *    ortoimagen CTX como textura;
 *  - terreno cercano: trozos (una tesela z16 ≈ 326 m) del DTM HiRISE de 1 m con la ortoimagen HiRISE de 0,6 m,
 *    alrededor del caminante; los construye mundo3d.worker.js fuera del hilo de la página;
 *  - la ruta, sus flechas y las paradas se pintan en dos texturas de suelo (una de toda la ruta y otra fina que sigue
 *    al caminante): quedan pegadas al relieve con cualquier nivel de detalle.
 * Todo lo que pisa la ruta se precarga en memoria al calcularla: al caminar no se pide nada a la red.
 *
 * NO SON DATOS (decoración, solo en esta vista): rocas sueltas, grano del suelo de cerca y polvo en suspensión.
 * El relieve va exagerado ×EXAG en vertical para que se lean pendientes de pocas decenas de metros.
 */
import { mirada, CAMARA } from './astronauta.js';

const URL_THREE = 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.min.js';
export const EXAG = 1.5;
const RAD = Math.PI / 180;
const Z = 16;                    // zoom de los trozos cercanos
const RADIO = 2;                 // trozos alrededor del caminante (5 × 5)
const PASO_LEJOS = 3;            // 1 de cada 3 celdas del DTM de 20 m en la malla lejana (60 m)
const PX_OV = 1024;              // lado de las texturas de suelo

let THREE = null;
const cargarThree = () => (THREE ? Promise.resolve(THREE) : import(URL_THREE).then(m => (THREE = m)));

class Trabajador {
    constructor() {
        this.w = new Worker(new URL('./mundo3d.worker.js', import.meta.url), { type: 'module' });
        this.n = 0; this.pend = new Map();
        this.w.onmessage = ({ data }) => {
            const p = this.pend.get(data.id);
            if (!p) return;
            if (data.progreso != null) { p.prog?.(data.progreso); return; }
            this.pend.delete(data.id);
            data.ok ? p.ok(data.res) : p.err(new Error(data.error));
        };
    }
    llamar(msg, prog) {
        const id = ++this.n;
        return new Promise((ok, err) => { this.pend.set(id, { ok, err, prog }); this.w.postMessage({ id, ...msg }); });
    }
}

// ───────────────────────── sombreadores ─────────────────────────

/** Cielo de Marte: ocre claro en el horizonte, más oscuro en el cénit y un halo azulado alrededor del Sol. */
const GLSL_CIELO = `
uniform vec3 uSol; uniform vec3 uCieloH; uniform vec3 uCieloZ; uniform vec3 uHalo;
vec3 cielo(vec3 d) {
    float h = clamp(d.y, 0.0, 1.0);
    vec3 c = mix(uCieloH, uCieloZ, pow(h, 0.42));
    float s = max(dot(d, uSol), 0.0);
    return c + uHalo * (pow(s, 8.0) * 0.20 + pow(s, 90.0) * 0.45);
}
uniform float uDens;
vec3 niebla(vec3 c, vec3 w) {
    vec3 v = w - cameraPosition; float d = length(v);
    float f = 1.0 - exp(-pow(d * uDens, 1.15));
    return mix(c, cielo(normalize(vec3(v.x, 0.03 * d, v.z))), f);
}`;

const VS_TERRENO = `
varying vec2 vUv; varying vec3 vN; varying vec3 vW;
void main() {
    vUv = uv; vN = normal;
    vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FS_TERRENO = `
uniform sampler2D uMap; uniform sampler2D uDet; uniform sampler2D uOvA; uniform sampler2D uOvB; uniform sampler2D uMascara;
uniform vec4 uOvARect; uniform vec4 uOvBRect; uniform vec4 uMk; uniform vec2 uMkTam;
uniform float uLuz; uniform float uOvOp;
varying vec2 vUv; varying vec3 vN; varying vec3 vW;
${GLSL_CIELO}
void main() {
#ifdef LEJOS
    // Donde hay un trozo cercano cargado, la malla lejana no se dibuja (el trozo la sustituye).
    vec2 t = vec2(uMk.x + vW.x * uMk.y, uMk.z + vW.z * uMk.w);
    if (t.x > 0.0 && t.y > 0.0 && t.x < uMkTam.x && t.y < uMkTam.y && texture2D(uMascara, (floor(t) + 0.5) / uMkTam).r > 0.5) discard;
#endif
    vec3 c = texture2D(uMap, vUv).rgb;
    float d = distance(vW, cameraPosition);
    // Grano del suelo (decoración): la ortoimagen llega a 0,6 m por píxel y de cerca se vería lisa.
    float cerca = 1.0 - smoothstep(6.0, 110.0, d), medio = 1.0 - smoothstep(80.0, 900.0, d);
    vec3 g1 = texture2D(uDet, vW.xz * 0.31).rgb, g2 = texture2D(uDet, vW.zx * 0.043 + 0.37).rgb;
    c *= mix(vec3(1.0), g1 * 2.0, cerca * 0.62) * mix(vec3(1.0), g2 * 2.0, medio * 0.30);
    // Luz del Sol real sobre el relieve, relativa a un suelo llano (la foto ya trae su propia luz).
    vec3 n = normalize(vN);
    float sol = clamp(1.0 + (dot(n, uSol) - uSol.y) * 1.25, 0.42, 1.55);
    c *= sol * uLuz;
    // Ruta, flechas y paradas pintadas sobre el suelo.
    vec2 a = (vW.xz - uOvARect.xy) * uOvARect.zw, b = (vW.xz - uOvBRect.xy) * uOvBRect.zw;
    vec4 ov = vec4(0.0);
    if (b.x > 0.0 && b.y > 0.0 && b.x < 1.0 && b.y < 1.0) ov = texture2D(uOvB, b);
    vec2 ma = min(a, 1.0 - a); float da = min(ma.x, ma.y);
    if (da > 0.0) ov = mix(ov, texture2D(uOvA, a), smoothstep(0.0, 0.06, da));
    c = mix(c, ov.rgb * (0.55 + 0.45 * uLuz), ov.a * uOvOp);
    gl_FragColor = vec4(niebla(c, vW), 1.0);
}`;

const VS_CIELO = `
varying vec3 vD;
void main() { vD = position; vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0); gl_Position = p.xyww; }`;
const FS_CIELO = `
varying vec3 vD; uniform vec3 uSolCol;
${GLSL_CIELO}
void main() {
    vec3 d = normalize(vD);
    vec3 c = cielo(normalize(vec3(d.x, max(d.y, 0.0), d.z)));
    float s = dot(d, uSol);
    c += uSolCol * (smoothstep(0.99988, 0.99996, s) + pow(max(s, 0.0), 900.0) * 0.6);
    gl_FragColor = vec4(c, 1.0);
}`;

const VS_ROCA = `
varying vec3 vW; varying vec3 vC; varying float vAlto;
void main() {
    vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vW = w.xyz; vC = instanceColor; vAlto = position.y;
    // Una piedra que ya no llega a un par de píxeles no se dibuja (son la mayoría de los triángulos de las rocas).
    float radio = length(instanceMatrix[0].xyz);
    gl_Position = distance(instanceMatrix[3].xyz, cameraPosition) > radio * 520.0 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * viewMatrix * w;
}`;
const FS_ROCA = `
varying vec3 vW; varying vec3 vC; varying float vAlto; uniform float uLuz; uniform sampler2D uDet;
${GLSL_CIELO}
void main() {
    // Caras planas (roca fracturada): la normal sale de las derivadas de la posición.
    vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
    float directa = max(dot(n, uSol), 0.0) * step(0.0, uSol.y);
    float ambiente = 0.34 + 0.22 * n.y;
    vec3 g = texture2D(uDet, vW.xz * 0.9 + vW.y * 0.7).rgb;
    // Polvo rojizo posado en las caras que miran hacia arriba; base más oscura (oclusión con el suelo).
    vec3 c = mix(vC, vec3(0.62, 0.40, 0.26), smoothstep(0.35, 0.95, n.y) * 0.55) * (0.7 + g * 0.6);
    c *= (ambiente + directa * 1.05) * uLuz * smoothstep(-0.25, 0.25, vAlto) ;
    gl_FragColor = vec4(niebla(c, vW), 1.0);
}`;

const VS_SOMBRA = `
attribute vec4 aSom; uniform vec3 uSol; varying vec2 vQ; varying float vF;
void main() {
    vQ = position.xz;
    vec2 ds = -normalize(uSol.xz + vec2(1e-4)), pe = vec2(-ds.y, ds.x);
    float largo = clamp(sqrt(max(1.0 - uSol.y * uSol.y, 0.0)) / max(uSol.y, 0.12), 0.15, 3.2), r = aSom.w;
    vec2 p = aSom.xz + ds * r * largo * 0.55 + pe * position.x * r * 1.15 + ds * position.z * r * (1.05 + largo * 0.55);
    vec4 w = vec4(p.x, aSom.y, p.y, 1.0);
    float d = distance(w.xyz, cameraPosition);
    vF = (1.0 - smoothstep(180.0, 320.0, d)) * step(0.02, uSol.y);
    gl_Position = projectionMatrix * viewMatrix * w;
}`;
const FS_SOMBRA = `
varying vec2 vQ; varying float vF;
void main() {
    float a = (1.0 - smoothstep(0.25, 1.0, length(vQ))) * 0.62 * vF;
    if (a < 0.01) discard;
    gl_FragColor = vec4(0.07, 0.035, 0.02, a);
}`;

/** Polvo fino en suspensión: motas pequeñas que derivan con el viento en una caja que acompaña a la cámara. */
const VS_POLVO = `
attribute float aFase; uniform float uTiempo; uniform vec2 uViento; uniform float uCaja; uniform float uPx; varying float vA;
void main() {
    vec3 p = position;
    float rafaga = 0.7 + 0.3 * sin(uTiempo * 0.6 + aFase * 0.07) * sin(uTiempo * 0.21 + aFase);
    p.xz += uViento * uTiempo * rafaga * (0.6 + 0.4 * fract(aFase * 3.7));
    p.y += sin(uTiempo * 0.8 + aFase * 6.0) * 0.5;
    p = mod(p - cameraPosition + 0.5 * uCaja, uCaja) - 0.5 * uCaja + cameraPosition;
    vec4 c = projectionMatrix * viewMatrix * vec4(p, 1.0);
    gl_Position = c;
    float d = distance(p, cameraPosition);
    vA = smoothstep(0.6, 3.0, d) * (1.0 - smoothstep(0.32 * uCaja, 0.5 * uCaja, d)) * (0.35 + 0.65 * fract(aFase * 7.3));
    gl_PointSize = clamp(uPx * (0.6 + fract(aFase * 5.1)) / max(c.w, 0.1), 1.0, 5.0);
}`;
const FS_POLVO = `
varying float vA; uniform vec3 uColor; uniform float uOpacidad;
void main() {
    vec2 q = gl_PointCoord - 0.5; float r = dot(q, q);
    if (r > 0.25) discard;
    gl_FragColor = vec4(uColor, vA * uOpacidad * (1.0 - r * 4.0));
}`;

/**
 * Guía de realidad aumentada del casco (como la vista en vivo de los mapas del móvil): galones azules con borde blanco
 * que flotan sobre el camino y avanzan en el sentido de la marcha, y galones grandes en el próximo giro.
 */
const VS_AR = `
attribute vec2 aAr; varying vec3 vP; varying vec3 vNl; varying vec2 vAr;
void main() {
    vP = position; vNl = normal; vAr = aAr;
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const FS_AR = `
varying vec3 vP; varying vec3 vNl; varying vec2 vAr;
void main() {
    if (vAr.x < 0.02) discard;
    // Colores planos, como un objeto macizo: interior blanco con un filo azul, y cantos azules (más claro el que mira arriba).
    float cara = step(0.5, abs(vNl.z));
    float u = vP.x + 0.72 * abs(vP.y);                       // 0.02 en el borde de atrás, 0.72 en el de la punta
    float filo = max(max(step(u, 0.13), step(0.61, u)), step(0.9, abs(vP.y)));
    vec3 azul = vec3(0.10, 0.45, 0.96);
    vec3 c = mix(vec3(0.05, 0.27, 0.72) * (0.8 + 0.35 * vNl.y), mix(vec3(1.0), azul, filo), cara);
    c = mix(c, mix(vec3(0.80, 0.90, 1.0), vec3(0.35, 0.65, 1.0), filo), vAr.y * 0.55 * cara);   // el galón que «late» se tiñe, sin transparencias
    gl_FragColor = vec4(c, vAr.x);
}`;
const VS_AR_SOMBRA = `
attribute float aAlfa; varying vec2 vQ; varying float vAlfa;
void main() { vQ = position.xz; vAlfa = aAlfa; gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0); }`;
const FS_AR_SOMBRA = `
varying vec2 vQ; varying float vAlfa;
void main() { float a = (1.0 - smoothstep(0.2, 1.0, length(vQ))) * 0.42 * vAlfa; if (a < 0.01) discard; gl_FragColor = vec4(0.05, 0.02, 0.01, a); }`;

// ───────────────────────── utilidades ─────────────────────────

const mezcla = (a, b, f) => a.map((v, i) => v + (b[i] - v) * Math.max(0, Math.min(1, f)));
const suave = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
const lonTesela = (x, z) => x / 2 ** z * 360 - 180;
const latTesela = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) / RAD;
const xTesela = (lon, z) => (lon + 180) / 360 * 2 ** z;
const yTesela = (lat, z) => (1 - Math.asinh(Math.tan(lat * RAD)) / Math.PI) / 2 * 2 ** z;

function aleatorio(semilla) {  // mulberry32
    let a = semilla >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Textura de grano del suelo, repetible y centrada en gris medio (se multiplica ×2 sobre la ortoimagen). */
function texturaGrano() {
    const N = 256, c = document.createElement('canvas'); c.width = c.height = N;
    const g = c.getContext('2d'), r = aleatorio(7), img = g.createImageData(N, N), d = img.data;
    // Ruido de valor en tres octavas, repetible.
    const oct = [8, 32, 128].map(n => { const t = new Float32Array(n * n); for (let i = 0; i < t.length; i++) t[i] = r(); return { n, t }; });
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        let v = 0, peso = 0;
        oct.forEach(({ n, t }, k) => {
            const fx = x / N * n, fy = y / N * n, i = fx | 0, j = fy | 0, a = suave(fx - i), b = suave(fy - j), i1 = (i + 1) % n, j1 = (j + 1) % n;
            const p = [0.5, 0.3, 0.2][k];
            v += p * ((t[j * n + i] * (1 - a) + t[j * n + i1] * a) * (1 - b) + (t[j1 * n + i] * (1 - a) + t[j1 * n + i1] * a) * b); peso += p;
        });
        const gris = 128 + (v / peso - 0.5) * 150, p = (y * N + x) * 4;
        d[p] = d[p + 1] = d[p + 2] = Math.max(0, Math.min(255, gris)); d[p + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    // Guijarros: mancha oscura con un borde iluminado.
    for (let i = 0; i < 260; i++) {
        const x = r() * N, y = r() * N, rad = 0.6 + r() * r() * 3.2;
        for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) {
            g.fillStyle = `rgba(40,26,18,${0.25 + r() * 0.3})`; g.beginPath(); g.ellipse(x + dx + rad * 0.3, y + dy + rad * 0.3, rad, rad * 0.75, r() * 3, 0, 7); g.fill();
            g.fillStyle = `rgba(235,215,190,${0.18 + r() * 0.2})`; g.beginPath(); g.ellipse(x + dx - rad * 0.15, y + dy - rad * 0.15, rad * 0.7, rad * 0.5, r() * 3, 0, 7); g.fill();
        }
    }
    return c;
}

/** Roca angulosa: icosaedro subdividido con los vértices desplazados y la base aplastada. Caras planas en el sombreador. */
function geometriaRoca() {
    const g = new THREE.IcosahedronGeometry(1, 1), p = g.attributes.position, r = aleatorio(5), v = new THREE.Vector3();
    const desplazamiento = new Map();
    for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        const k = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
        if (!desplazamiento.has(k)) desplazamiento.set(k, 0.68 + r() * 0.5);
        v.multiplyScalar(desplazamiento.get(k));
        if (v.y < -0.2) v.y = -0.2 + (v.y + 0.2) * 0.25;
        p.setXYZ(i, v.x, v.y, v.z);
    }
    g.deleteAttribute('normal'); g.deleteAttribute('uv');
    return g;
}

// ───────────────────────── mundo ─────────────────────────

/**
 * Crea el mundo 3D. No muestra nada hasta `mostrar(true)`.
 * @param {object} op  terreno { meta, elev } (rejilla del DTM de 20 m), relieve y orto (metadatos de las teselas
 *                     HiRISE), origen { lon, lat }, contenedor (elemento donde va el lienzo)
 */
export async function crearMundo(op) {
    await cargarThree();
    const T = THREE;
    const { meta, elev } = op.terreno, G = { W: meta.ancho, H: meta.alto };
    const O = { lon: op.origen.lon, lat: op.origen.lat };
    const R = meta.radio_m, kx = RAD * R * Math.cos(O.lat * RAD), kz = RAD * R;
    const aX = lon => (lon - O.lon) * kx, aZ = lat => -(lat - O.lat) * kz;
    const aLon = x => O.lon + x / kx, aLat = z => O.lat - z / kz;
    const elevRejilla = (lon, lat) => {
        const fi = Math.max(0, Math.min(G.W - 1.001, (lon - meta.lon0) / meta.dlon - 0.5)), fj = Math.max(0, Math.min(G.H - 1.001, (meta.lat0 - lat) / meta.dlat - 0.5));
        const i = fi | 0, j = fj | 0, a = fi - i, b = fj - j, k = j * G.W + i;
        return (elev[k] * (1 - a) + elev[k + 1] * a) * (1 - b) + (elev[k + G.W] * (1 - a) + elev[k + G.W + 1] * a) * b;
    };
    O.elev = elevRejilla(O.lon, O.lat);
    if (!Number.isFinite(O.elev)) O.elev = meta.elev_min;

    // El worker resuelve las rutas relativas respecto a su propio archivo: se le dan absolutas. (Por concatenación:
    // new URL() codificaría las llaves de {z}/{x}/{y}.)
    const base = new URL('./', document.baseURI).href, abs = u => (!u || /^[a-z]+:\/\//i.test(u) ? u : base + u);
    if (op.relieve) op.relieve = { ...op.relieve, url: abs(op.relieve.url) };
    if (op.orto) op.orto = { ...op.orto, url: abs(op.orto.url) };
    const W = new Trabajador();
    const rangoDem = op.relieve?.rangos?.[Z] || null;          // [xa, ya, xb, yb] de los trozos con DTM HiRISE
    await W.llamar({ tipo: 'config', config: { lonO: O.lon, latO: O.lat, elevO: O.elev, R, exag: EXAG,
        urlDem: op.relieve?.url, urlOrto: op.orto?.url, zOrto: op.orto?.zoom_max ?? Z } });

    // Lienzo y renderizador
    const lienzo = document.createElement('canvas');
    lienzo.id = 'mw-mundo'; lienzo.className = 'mw-mundo'; lienzo.setAttribute('aria-hidden', 'true');
    op.contenedor.appendChild(lienzo);
    // Mirar alrededor en la cámara de seguimiento (en el casco lo hace el visor, js/ruta/astronauta.js): mismo estado `mirada`.
    let enCasco = () => false;
    {
        let arrastre = null;
        lienzo.addEventListener('pointerdown', e => { arrastre = [e.clientX, e.clientY]; lienzo.setPointerCapture(e.pointerId); lienzo.classList.add('arrastrando'); });
        lienzo.addEventListener('pointermove', e => {
            if (!arrastre) return;
            const dx = e.clientX - arrastre[0], dy = e.clientY - arrastre[1];
            if (enCasco()) {   // primera persona: se «agarra» el paisaje (arrastrar a la izquierda gira la vista a la derecha)
                mirada.yaw = (mirada.yaw - dx * 0.16 + 360) % 360; mirada.pitch = Math.max(-60, Math.min(55, mirada.pitch + dy * 0.14));
            } else {           // seguimiento: se gira alrededor del caminante y se sube o baja la cámara
                mirada.yaw = (mirada.yaw - dx * 0.3 + 360) % 360; mirada.pitch = Math.max(-35, Math.min(10, mirada.pitch - dy * 0.2));
            }
            arrastre = [e.clientX, e.clientY];
        });
        const soltar = e => { arrastre = null; lienzo.classList.remove('arrastrando'); try { lienzo.releasePointerCapture(e.pointerId); } catch { /* ya suelto */ } };
        lienzo.addEventListener('pointerup', soltar); lienzo.addEventListener('pointercancel', soltar);
        lienzo.addEventListener('wheel', e => { e.preventDefault(); mirada.zoomOffset = Math.max(-4, Math.min(6, mirada.zoomOffset - e.deltaY * 0.003)); }, { passive: false });
        lienzo.addEventListener('dblclick', () => { mirada.yaw = 0; mirada.pitch = 0; mirada.zoomOffset = 0; });
    }
    // En GPU integradas el suavizado multimuestra y el filtrado anisótropo alto cuestan más que todo el terreno (medido:
    // 45 → 60 fps a resolución completa en una Intel UHD): ahí se prescinde del primero y se limita el segundo.
    let gpu = '';
    try { const g = document.createElement('canvas').getContext('webgl2'), x = g?.getExtension('WEBGL_debug_renderer_info'); gpu = x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : ''; g?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* sin información de la GPU */ }
    const integrada = !gpu || /Intel|SwiftShader|llvmpipe|Mali|Adreno|PowerVR|Apple GPU/i.test(gpu);
    const DBG = new URLSearchParams(location.search);
    const render = new T.WebGLRenderer({ canvas: lienzo, antialias: DBG.has('aa') ? DBG.get('aa') !== '0' : !integrada, powerPreference: 'high-performance', alpha: false, stencil: false });
    render.outputColorSpace = T.LinearSRGBColorSpace;          // se trabaja con los colores de las fotos tal cual
    render.setClearColor(0xc79466);
    const escena = new T.Scene();
    const camara = new T.PerspectiveCamera(60, 1, 0.4, 60000);
    const anisotropia = Math.min(+(DBG.get('an') || (integrada ? 4 : 8)), render.capabilities.getMaxAnisotropy());

    // Uniformes compartidos por todos los materiales
    const texVacia = new T.DataTexture(new Uint8Array(4), 1, 1); texVacia.needsUpdate = true;
    const lienzoGrano = texturaGrano(), texGrano = new T.CanvasTexture(lienzoGrano);
    texGrano.wrapS = texGrano.wrapT = T.RepeatWrapping; texGrano.anisotropy = Math.min(2, anisotropia);
    const crearOverlay = () => {
        const c = document.createElement('canvas'); c.width = c.height = PX_OV;
        const t = new T.CanvasTexture(c); t.flipY = false; t.anisotropy = anisotropia; t.premultiplyAlpha = false;
        return { c, g: c.getContext('2d'), t, rect: null };
    };
    const ovA = crearOverlay(), ovB = crearOverlay();
    const nMx = rangoDem ? rangoDem[2] - rangoDem[0] + 1 : 1, nMy = rangoDem ? rangoDem[3] - rangoDem[1] + 1 : 1;
    const mascara = new T.DataTexture(new Uint8Array(nMx * nMy * 4), nMx, nMy);
    mascara.magFilter = mascara.minFilter = T.NearestFilter; mascara.needsUpdate = true;
    const U = {
        uSol: { value: new T.Vector3(0.5, 0.7, 0.5).normalize() }, uCieloH: { value: new T.Vector3() }, uCieloZ: { value: new T.Vector3() },
        uHalo: { value: new T.Vector3() }, uSolCol: { value: new T.Vector3(1, 1, 1) }, uDens: { value: 1 / 9000 }, uLuz: { value: 1 },
        uDet: { value: texGrano }, uOvA: { value: ovA.t }, uOvB: { value: ovB.t },
        uOvARect: { value: new T.Vector4(0, 0, 0, 0) }, uOvBRect: { value: new T.Vector4(0, 0, 0, 0) },
        uMascara: { value: mascara }, uMk: { value: new T.Vector4() }, uMkTam: { value: new T.Vector2(nMx, nMy) },
        uTiempo: { value: 0 }, uOvOp: { value: 1 },
    };
    if (rangoDem) {
        // Coordenada de trozo (lineal en x; en z la curvatura de Mercator en 4 km es < 0,5 m: la tapan los faldones).
        const xa = aX(lonTesela(rangoDem[0], Z)), xb = aX(lonTesela(rangoDem[2] + 1, Z)), za = aZ(latTesela(rangoDem[1], Z)), zb = aZ(latTesela(rangoDem[3] + 1, Z));
        U.uMk.value.set(-xa * nMx / (xb - xa), nMx / (xb - xa), -za * nMy / (zb - za), nMy / (zb - za));
    }
    const materialTerreno = (tex, lejos) => new T.ShaderMaterial({
        uniforms: { ...U, uMap: { value: tex } }, vertexShader: VS_TERRENO, fragmentShader: FS_TERRENO, defines: lejos ? { LEJOS: 1 } : {},
    });

    // ── Cielo
    const cielo = new T.Mesh(new T.SphereGeometry(1, 32, 16), new T.ShaderMaterial({ uniforms: U, vertexShader: VS_CIELO, fragmentShader: FS_CIELO, side: T.BackSide, depthWrite: false, depthTest: false }));
    cielo.frustumCulled = false; cielo.renderOrder = -10;
    escena.add(cielo);

    // ── Terreno lejano: una malla de toda la rejilla del DTM de 20 m
    const texLejos = new T.Texture(); texLejos.flipY = false; texLejos.anisotropy = anisotropia;
    const matLejos = materialTerreno(texVacia, true);
    let mosaico = null;
    const construirLejos = () => {
        const p = PASO_LEJOS, nw = Math.floor((G.W - 1) / p) + 1, nh = Math.floor((G.H - 1) / p) + 1;
        const pos = new Float32Array(nw * nh * 3), nor = new Float32Array(nw * nh * 3), uv = new Float32Array(nw * nh * 2);
        const e = (i, j) => { const v = elev[Math.min(G.H - 1, Math.max(0, j)) * G.W + Math.min(G.W - 1, Math.max(0, i))]; return Number.isFinite(v) ? v : meta.elev_min; };
        const [mxa, mya, mxb, myb] = mosaico.rango, mz = mosaico.z;
        const d = meta.res_m * 2;
        for (let b = 0; b < nh; b++) {
            const j = b * p, lat = meta.lat0 - (j + 0.5) * meta.dlat, z = aZ(lat), v = (yTesela(lat, mz) - mya) / (myb - mya + 1);
            for (let a = 0; a < nw; a++) {
                const i = a * p, lon = meta.lon0 + (i + 0.5) * meta.dlon, k = b * nw + a;
                pos[k * 3] = aX(lon); pos[k * 3 + 1] = (e(i, j) - O.elev) * EXAG; pos[k * 3 + 2] = z;
                const dx = (e(i + 1, j) - e(i - 1, j)) * EXAG / d, dz = (e(i, j + 1) - e(i, j - 1)) * EXAG / d, l = 1 / Math.hypot(dx, 1, dz);
                nor[k * 3] = -dx * l; nor[k * 3 + 1] = l; nor[k * 3 + 2] = -dz * l;
                uv[k * 2] = (xTesela(lon, mz) - mxa) / (mxb - mxa + 1); uv[k * 2 + 1] = v;
            }
        }
        // Bloques de 48 × 48 celdas que comparten los mismos vértices: la GPU solo dibuja los que entran en la vista.
        const ap = new T.BufferAttribute(pos, 3), an = new T.BufferAttribute(nor, 3), au = new T.BufferAttribute(uv, 2), B = 48;
        for (let b0 = 0; b0 < nh - 1; b0 += B) for (let a0 = 0; a0 < nw - 1; a0 += B) {
            const b1 = Math.min(nh - 1, b0 + B), a1 = Math.min(nw - 1, a0 + B), idx = new Uint32Array((a1 - a0) * (b1 - b0) * 6);
            let q = 0, yMin = Infinity, yMax = -Infinity;
            for (let b = b0; b < b1; b++) for (let a = a0; a < a1; a++) {
                const i0 = b * nw + a, i1 = i0 + 1, i2 = i0 + nw, i3 = i2 + 1;
                idx[q++] = i0; idx[q++] = i2; idx[q++] = i1; idx[q++] = i1; idx[q++] = i2; idx[q++] = i3;
            }
            for (let b = b0; b <= b1; b += 4) for (let a = a0; a <= a1; a += 4) { const y = pos[(b * nw + a) * 3 + 1]; if (y < yMin) yMin = y; if (y > yMax) yMax = y; }
            const g = new T.BufferGeometry();
            g.setAttribute('position', ap); g.setAttribute('normal', an); g.setAttribute('uv', au); g.setIndex(new T.BufferAttribute(idx, 1));
            const k0 = (b0 * nw + a0) * 3, k1 = (b1 * nw + a1) * 3;
            const c = new T.Vector3((pos[k0] + pos[k1]) / 2, (yMin + yMax) / 2, (pos[k0 + 2] + pos[k1 + 2]) / 2);
            g.boundingSphere = new T.Sphere(c, Math.hypot(pos[k1] - pos[k0], pos[k1 + 2] - pos[k0 + 2], yMax - yMin) / 2 + 60);
            const m = new T.Mesh(g, matLejos); m.matrixAutoUpdate = false;
            escena.add(m);
        }
    };
    const om = op.terreno.meta.orto, zMos = Math.min(13, om.zoom_max);
    const lejosListo = W.llamar({ tipo: 'mosaico', plantilla: abs(om.url), z: zMos, rango: om.rangos[zMos], maxLado: Math.min(4096, render.capabilities.maxTextureSize) }).then(r => {
        mosaico = r; texLejos.image = r.img; texLejos.needsUpdate = true; matLejos.uniforms.uMap.value = texLejos;
        construirLejos();
    });

    // ── Trozos cercanos
    const trozos = new Map();                                   // "x/y" → { estado, res, malla, rocas, sombras, alturas, ... }
    const geoRoca = geometriaRoca();
    const matRoca = new T.ShaderMaterial({ uniforms: U, vertexShader: VS_ROCA, fragmentShader: FS_ROCA });
    const matSombra = new T.ShaderMaterial({ uniforms: U, vertexShader: VS_SOMBRA, fragmentShader: FS_SOMBRA, transparent: true, depthWrite: false });
    const planoSombra = new T.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    const hayTrozo = (x, y) => !!rangoDem && x >= rangoDem[0] && x <= rangoDem[2] && y >= rangoDem[1] && y <= rangoDem[3];
    let enCurso = 0, cola = [];
    const marcarMascara = (x, y, v) => {
        if (!hayTrozo(x, y)) return;
        mascara.image.data[((y - rangoDem[1]) * nMx + (x - rangoDem[0])) * 4] = v ? 255 : 0; mascara.needsUpdate = true;
    };
    const liberar = t => {
        for (const o of [t.malla, t.rocas, t.sombras]) if (o) { escena.remove(o); if (o !== t.rocas) o.geometry.dispose(); else o.dispose(); }
        t.malla?.material.uniforms.uMap.value.dispose(); t.malla?.material.dispose();
    };
    const montar = (clave, d) => {
        const previo = trozos.get(clave);
        if (!previo || previo.pedido !== d.res) return;        // ya no hace falta (se alejó o cambió de detalle)
        if (previo.malla) liberar(previo);
        const g = new T.BufferGeometry();
        g.setAttribute('position', new T.BufferAttribute(d.pos, 3)); g.setAttribute('normal', new T.BufferAttribute(d.nor, 3)); g.setAttribute('uv', new T.BufferAttribute(d.uv, 2));
        g.setIndex(new T.BufferAttribute(d.idx, 1));
        const cx = (d.x0 + d.x1) / 2, cz = (d.zN + d.zS) / 2, cy = (d.yMin + d.yMax) / 2;
        g.boundingSphere = new T.Sphere(new T.Vector3(cx, cy, cz), Math.hypot(d.x1 - d.x0, d.zS - d.zN, d.yMax - d.yMin) / 2 + 2);
        const tex = new T.Texture(d.tex); tex.flipY = false; tex.anisotropy = anisotropia; tex.generateMipmaps = true;
        tex.minFilter = T.LinearMipmapLinearFilter; tex.wrapS = tex.wrapT = T.ClampToEdgeWrapping; tex.needsUpdate = true;
        const malla = new T.Mesh(g, materialTerreno(tex, false)); malla.matrixAutoUpdate = false;
        escena.add(malla);
        const t = { ...previo, estado: 'listo', res: d.res, malla, alturas: d.alturas, x0: d.x0, x1: d.x1, zN: d.zN, zS: d.zS, rocas: null, sombras: null };
        if (d.nRocas) {
            const rocas = new T.InstancedMesh(geoRoca, matRoca, d.nRocas);
            rocas.instanceMatrix = new T.InstancedBufferAttribute(d.rocaMat, 16); rocas.instanceColor = new T.InstancedBufferAttribute(d.rocaCol, 3);
            rocas.matrixAutoUpdate = false; rocas.boundingSphere = g.boundingSphere; rocas.frustumCulled = true;
            const gs = new T.InstancedBufferGeometry(); gs.index = planoSombra.index; gs.setAttribute('position', planoSombra.attributes.position);
            gs.setAttribute('aSom', new T.InstancedBufferAttribute(d.rocaSom, 4)); gs.instanceCount = d.nRocas; gs.boundingSphere = g.boundingSphere;
            const sombras = new T.Mesh(gs, matSombra); sombras.matrixAutoUpdate = false; sombras.renderOrder = 1;
            escena.add(sombras, rocas);
            t.rocas = rocas; t.sombras = sombras;
        }
        trozos.set(clave, t);
        marcarMascara(d.x, d.y, true);
    };
    const pedirTrozo = (x, y, res, prioridad) => {
        const clave = `${x}/${y}`, t = trozos.get(clave);
        if (t && (t.pedido >= res)) return;
        trozos.set(clave, { ...(t || { estado: 'pend' }), pedido: res, x, y });
        cola.push({ x, y, res, prioridad, clave });
    };
    const despachar = () => {
        cola.sort((a, b) => b.prioridad - a.prioridad);
        while (enCurso < 3 && cola.length) {
            const p = cola.pop(), t = trozos.get(p.clave);
            if (!t || t.pedido !== p.res) continue;
            enCurso++;
            W.llamar({ tipo: 'trozo', z: Z, x: p.x, y: p.y, res: p.res, rocas: p.res >= 96 })
                .then(d => { if (d) pendientesMontar.push([p.clave, d]); else trozos.delete(p.clave); })
                .catch(e => { console.warn('[mundo3d] trozo', p.clave, e.message); trozos.delete(p.clave); })
                .finally(() => { enCurso--; despachar(); });
        }
    };
    const pendientesMontar = [];
    let centro = null;
    /** Pide los trozos alrededor de (lon, lat) y suelta los que quedan lejos. */
    const actualizarTrozos = (lon, lat) => {
        if (!rangoDem) return;
        const cx = Math.floor(xTesela(lon, Z)), cy = Math.floor(yTesela(lat, Z));
        if (centro && centro[0] === cx && centro[1] === cy) return;
        centro = [cx, cy];
        for (let dy = -RADIO; dy <= RADIO; dy++) for (let dx = -RADIO; dx <= RADIO; dx++) {
            const x = cx + dx, y = cy + dy, r = Math.max(Math.abs(dx), Math.abs(dy));
            if (hayTrozo(x, y)) pedirTrozo(x, y, r <= 1 ? 128 : 64, Math.hypot(dx, dy));
        }
        for (const [clave, t] of trozos) {
            if (Math.max(Math.abs(t.x - cx), Math.abs(t.y - cy)) <= RADIO + 1) continue;
            if (t.malla) { liberar(t); marcarMascara(t.x, t.y, false); }
            trozos.delete(clave);
        }
        cola = cola.filter(p => trozos.has(p.clave));
        despachar();
    };

    /** Altura de la escena (m, ya exagerada y relativa al origen) en un punto: del trozo cercano si está, si no del DTM de 20 m. */
    const alturaEn = (x, z) => {
        const lon = aLon(x), lat = aLat(z);
        if (rangoDem) {
            const tx = xTesela(lon, Z), ty = yTesela(lat, Z), t = trozos.get(`${Math.floor(tx)}/${Math.floor(ty)}`);
            if (t?.alturas) {
                const h = t.alturas, sx = Math.min(255, Math.max(0, (tx - t.x) * 256 - 0.5)), sy = Math.min(255, Math.max(0, (ty - t.y) * 256 - 0.5));
                const i = Math.min(254, sx | 0), j = Math.min(254, sy | 0), a = sx - i, b = sy - j, k = j * 256 + i;
                return ((h[k] * (1 - a) + h[k + 1] * a) * (1 - b) + (h[k + 256] * (1 - a) + h[k + 257] * a) * b - O.elev) * EXAG;
            }
        }
        const e = elevRejilla(lon, lat);
        return ((Number.isFinite(e) ? e : meta.elev_min) - O.elev) * EXAG;
    };

    // ── Polvo en suspensión
    const N_POLVO = 2600, CAJA = 70;
    const gp = new T.BufferGeometry(), pp = new Float32Array(N_POLVO * 3), fp = new Float32Array(N_POLVO), ra = aleatorio(3);
    for (let i = 0; i < N_POLVO; i++) { pp[i * 3] = ra() * CAJA; pp[i * 3 + 1] = ra() * ra() * 26; pp[i * 3 + 2] = ra() * CAJA; fp[i] = ra() * 100; }
    gp.setAttribute('position', new T.BufferAttribute(pp, 3)); gp.setAttribute('aFase', new T.BufferAttribute(fp, 1));
    const matPolvo = new T.ShaderMaterial({ uniforms: { uTiempo: U.uTiempo, uViento: { value: new T.Vector2(4, 1) }, uCaja: { value: CAJA }, uPx: { value: 60 },
        uColor: { value: new T.Vector3(0.95, 0.80, 0.62) }, uOpacidad: { value: 0.3 } }, vertexShader: VS_POLVO, fragmentShader: FS_POLVO, transparent: true, depthWrite: false });
    const polvo = new T.Points(gp, matPolvo); polvo.frustumCulled = false; polvo.renderOrder = 5;
    escena.add(polvo);

    // ── Caminante (cámara de seguimiento): flecha de navegación tumbada sobre el suelo
    const flecha = new T.Group();
    {
        const forma = pts => { const s = new T.Shape(); pts.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y))); return new T.ShapeGeometry(s).rotateX(-Math.PI / 2); };
        const borde = new T.Mesh(forma([[0, 1.25], [0.98, -1.05], [0, -0.55], [-0.98, -1.05]]), new T.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }));
        const relleno = new T.Mesh(forma([[0, 0.95], [0.72, -0.8], [0, -0.38], [-0.72, -0.8]]), new T.MeshBasicMaterial({ color: 0x1a73e8, depthTest: false, transparent: true }));
        borde.renderOrder = 8; relleno.renderOrder = 9;
        flecha.add(borde, relleno); flecha.userData = { borde, relleno };
        escena.add(flecha);
    }

    // ── Guía de realidad aumentada del casco, como la vista en vivo de los mapas del móvil: tríos de galones macizos
    // («>>>») clavados en el terreno. Cada galón está DE PIE (sus dos brazos van hacia arriba y hacia abajo), tiene
    // grosor de verdad y su punta señala en horizontal hacia dónde seguir. No giran hacia quien mira ni cambian de
    // tamaño con la distancia: son objetos del mundo, y por eso en un giro se ven de lado apuntando a la salida.
    const N_GRUPOS = 2, N_AR = N_GRUPOS * 3, TRECHO = 120, ALTO = 1.4;   // como mucho dos tríos a la vista: el de «sigue» y el del giro
    const formaGalon = new T.Shape();
    [[-0.72, 1], [-0.02, 1], [0.72, 0], [-0.02, -1], [-0.72, -1], [0.02, 0]].forEach(([x, y], i) => (i ? formaGalon.lineTo(x, y) : formaGalon.moveTo(x, y)));
    const GROSOR = 0.9;                                           // grosor del galón respecto a su media altura
    const geoAr = new T.ExtrudeGeometry(formaGalon, { depth: GROSOR, bevelEnabled: false }).translate(0, 0, -GROSOR / 2);
    const arAlfa = new T.InstancedBufferAttribute(new Float32Array(N_AR * 2), 2); arAlfa.setUsage(T.DynamicDrawUsage);   // (opacidad, brillo)
    geoAr.setAttribute('aAr', arAlfa);
    const ar = new T.InstancedMesh(geoAr, new T.ShaderMaterial({ vertexShader: VS_AR, fragmentShader: FS_AR, transparent: true }), N_AR);
    ar.instanceMatrix.setUsage(T.DynamicDrawUsage); ar.frustumCulled = false; ar.renderOrder = 6; ar.visible = false;
    const geoArSombra = new T.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    const arSombraAlfa = new T.InstancedBufferAttribute(new Float32Array(N_GRUPOS), 1); arSombraAlfa.setUsage(T.DynamicDrawUsage);
    geoArSombra.setAttribute('aAlfa', arSombraAlfa);
    const arSombra = new T.InstancedMesh(geoArSombra, new T.ShaderMaterial({ vertexShader: VS_AR_SOMBRA, fragmentShader: FS_AR_SOMBRA, transparent: true, depthWrite: false }), N_GRUPOS);
    arSombra.instanceMatrix.setUsage(T.DynamicDrawUsage); arSombra.frustumCulled = false; arSombra.renderOrder = 2; arSombra.visible = false;
    escena.add(arSombra, ar);
    // Cartel del giro: disco azul con la flecha de la maniobra y la distancia, siempre de cara a quien mira.
    const lienzoGiro = document.createElement('canvas'); lienzoGiro.width = lienzoGiro.height = 256;
    const texGiro = new T.CanvasTexture(lienzoGiro); texGiro.anisotropy = anisotropia;
    const cartel = new T.Sprite(new T.SpriteMaterial({ map: texGiro, transparent: true, depthTest: false, sizeAttenuation: false })); cartel.renderOrder = 21; cartel.visible = false; cartel.center.set(0.5, 0);
    const poste = new T.Mesh(geoHazAr(), new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false })); poste.visible = false;
    escena.add(cartel, poste);
    function geoHazAr() { return new T.CylinderGeometry(0.07, 0.07, 1, 6, 1, true).translate(0, 0.5, 0); }
    let claveGiro = '';
    const pintarCartel = (giro, metros) => {
        const g = lienzoGiro.getContext('2d'); g.clearRect(0, 0, 256, 256);
        g.beginPath(); g.arc(128, 128, 112, 0, 7); g.fillStyle = '#1a73e8'; g.fill(); g.lineWidth = 12; g.strokeStyle = '#fff'; g.stroke();
        // Flecha: tallo vertical y tramo de salida girado `giro` grados (como el icono del visor).
        const a = Math.max(-140, Math.min(140, giro)) * RAD, cx = 128, cy = 118, L = 46, ex = cx + Math.sin(a) * L, ey = cy - Math.cos(a) * L;
        g.strokeStyle = '#fff'; g.lineWidth = 20; g.lineCap = 'round'; g.lineJoin = 'round';
        g.beginPath(); g.moveTo(cx, cy + 46); g.lineTo(cx, cy); g.lineTo(ex, ey); g.stroke();
        const ux = Math.sin(a), uy = -Math.cos(a), r = 24;
        g.beginPath(); g.moveTo(ex + ux * r, ey + uy * r); g.lineTo(ex - uy * r, ey + ux * r); g.lineTo(ex + uy * r, ey - ux * r); g.closePath(); g.fillStyle = '#fff'; g.fill();
        g.font = '700 38px Roboto, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(metros, 128, 203);
        texGiro.needsUpdate = true;
    };
    const mAr = new T.Matrix4();
    const actualizarAR = () => {
        const op = suave((E.modo - 0.6) / 0.4) * suave(E.entrada);
        ar.visible = arSombra.visible = op > 0.01 && !!ruta && E.dist != null;
        cartel.visible = poste.visible = false;
        if (!ar.visible) return;
        const t = U.uTiempo.value;
        /**
         * Un trío de galones en (x, z) cuya punta señala el rumbo `rumbo` (horizontal). `tam` es la media altura de
         * cada galón en metros y `alto` la altura de su centro sobre el suelo. Ejes del galón: x = hacia donde señala,
         * y = arriba, z = a su derecha (el grosor).
         */
        const trio = (g, x, z, rumbo, tam, alto, alfa, marcha) => {
            const r = rumbo * RAD, fx = Math.sin(r), fz = -Math.cos(r), suelo = alturaEn(x, z), flota = 0.07 * tam * Math.sin(t * 1.8 + g * 1.3);
            for (let j = 0; j < 3; j++) {
                const i = g * 3 + j, k = (j - 1) * tam * 1.18, px = x + fx * k, pz = z + fz * k;
                // columnas: x = (fx, 0, fz) · tam; y = (0, 1, 0) · tam; z = x × y = (−fz, 0, fx) · tam
                mAr.set(fx * tam, 0, -fz * tam, px,  0, tam * ALTO, 0, suelo + alto * ALTO + flota,  fz * tam, 0, fx * tam, pz,  0, 0, 0, 1);
                ar.setMatrixAt(i, mAr);
                // Brillo en marcha: 1 → 2 → 3, en el sentido que señalan.
                arAlfa.array[i * 2] = alfa; arAlfa.array[i * 2 + 1] = Math.max(0, Math.sin(t * marcha - j * 1.2)) ** 2;
            }
            mAr.makeRotationY(-r + Math.PI / 2).scale(v1.set(tam * 2.1, 1, tam * 0.7)).setPosition(x, suelo + 0.08, z);
            arSombra.setMatrixAt(g, mAr); arSombraAlfa.array[g] = alfa;
        };
        const ocultar = g => { for (let j = 0; j < 3; j++) arAlfa.array[(g * 3 + j) * 2] = 0; arSombraAlfa.array[g] = 0; };
        // Próximo giro: su trío va clavado en el punto del giro, más grande, señalando la dirección de salida.
        const info = estadoOv.infoManiobra, hayGiro = info && info.dist > E.dist - 6 && info.dist < ruta.total - 2;
        if (hayGiro) {
            const c = puntoRuta(Math.min(ruta.total, info.dist + 5)), dCam = Math.hypot(c[0] - E.x, c[1] - E.z);
            // A un lado del camino, por fuera de la curva: el astronauta pasa junto al trío, no a través de él.
            { const e = puntoRuta(Math.max(0, info.dist - 22))[2] * RAD, fuera = -Math.sign(info.giro || 1) * 8; c[0] += Math.cos(e) * fuera; c[1] += Math.sin(e) * fuera; }
            // Señala la salida del giro; en giros suaves se abre hasta 40° respecto a la llegada para que se lea de lado.
            const entra = puntoRuta(Math.max(0, info.dist - 22))[2], real = ((puntoRuta(Math.min(ruta.total, info.dist + 26))[2] - entra + 540) % 360) - 180;
            const sale = entra + Math.sign(real || info.giro || 1) * Math.max(40, Math.abs(real));
            const alfa = op * (1 - suave((dCam - 260) / 80)) * suave((dCam - 2) / 4);
            trio(N_GRUPOS - 1, c[0], c[1], sale, 2.4, 3.6, alfa, 6);
            // Cartel con la maniobra y la distancia, sobre el trío.
            const metros = dCam >= 1000 ? `${(dCam / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(dCam / 10) * 10)} m`, clave = `${Math.round(info.giro / 5)}|${metros}`;
            if (clave !== claveGiro) { claveGiro = clave; pintarCartel(info.giro, metros); }
            const tam = 0.1 * Math.tan(camara.fov * RAD / 2) / 0.7, suelo = alturaEn(c[0], c[1]), alto = 9.5 + dCam * 0.05;
            cartel.visible = poste.visible = alfa > 0.02 && dCam > 25;
            cartel.position.set(c[0], suelo + alto, c[1]); cartel.scale.set(tam, tam, 1); cartel.material.opacity = alfa * suave((dCam - 25) / 20);
            const gr = Math.max(1, dCam * 0.03);
            poste.position.set(c[0], suelo + 6, c[1]); poste.scale.set(gr, alto - 6, gr); poste.material.opacity = 0.5 * alfa * suave((dCam - 25) / 20);
        } else ocultar(N_GRUPOS - 1);
        // En recta basta un recordatorio de «sigue»: UN trío clavado en el terreno cada 120 m (se ve acercarse y se deja
        // atrás). Si el giro ya está cerca (a menos de 130 m) sobra: manda el trío del giro. Así nunca hay más de dos.
        const d = (Math.floor((E.dist + 4) / TRECHO) + 1) * TRECHO, delante = d - E.dist;
        if (d > ruta.total - 12 || (hayGiro && info.dist - E.dist < 130 && info.dist > E.dist - 6)) ocultar(0);
        else {
            // A un lado del camino y algo vuelto hacia él: se ve de costado, no de canto, y la punta sigue diciendo «adelante».
            const p = puntoRuta(d), rumbo = puntoRuta(Math.min(ruta.total, d + 8))[2], lado = Math.round(d / TRECHO) % 2 ? 1 : -1, r = rumbo * RAD;
            trio(0, p[0] + Math.cos(r) * 8 * lado, p[1] + Math.sin(r) * 8 * lado, rumbo - 28 * lado, 1.6, 2.6, op * suave((delante - 3) / 4) * (1 - suave((delante - 95) / 25)), 4.5);
        }
        ar.instanceMatrix.needsUpdate = true; arAlfa.needsUpdate = true; arSombra.instanceMatrix.needsUpdate = true; arSombraAlfa.needsUpdate = true;
    };

    // ── Paradas y base: etiqueta de tamaño fijo en pantalla y un haz vertical para localizarlas de lejos
    const marcas = new T.Group(); escena.add(marcas);
    const ESTILO = { siguiente: ['#1a73e8', '#ffffff', '#ffffff'], pendiente: ['#ffffff', '#5f6368', '#202124'], hecha: ['#80868b', '#e8eaed', '#ffffff'], base: ['#1a73e8', '#ffffff', '#ffffff'] };
    const pintarEtiqueta = (c, texto, numero, estado) => {
        const g = c.getContext('2d'), [fondo, borde, tinta] = ESTILO[estado];
        g.clearRect(0, 0, c.width, c.height);
        g.font = '500 44px Roboto, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.beginPath(); g.arc(256, 50, 40, 0, 7); g.fillStyle = fondo; g.fill(); g.lineWidth = 6; g.strokeStyle = borde; g.stroke();
        g.fillStyle = tinta; g.fillText(estado === 'hecha' ? '✓' : numero, 256, 53);
        g.font = '500 34px Roboto, Arial, sans-serif'; g.lineWidth = 8; g.strokeStyle = 'rgba(0,0,0,.8)'; g.lineJoin = 'round'; g.fillStyle = estado === 'hecha' ? '#dadce0' : '#fff';
        g.strokeText(texto, 256, 128); g.fillText(texto, 256, 128);
    };
    const etiqueta = (texto, numero, estado) => {
        const c = document.createElement('canvas'); c.width = 512; c.height = 160;
        pintarEtiqueta(c, texto, numero, estado);
        const t = new T.CanvasTexture(c); t.anisotropy = anisotropia;
        const s = new T.Sprite(new T.SpriteMaterial({ map: t, depthTest: false, transparent: true, sizeAttenuation: false }));
        s.scale.set(0.3, 0.3 * 160 / 512, 1); s.center.set(0.5, 0.1); s.renderOrder = 20;
        return s;
    };
    const geoHaz = new T.CylinderGeometry(0.5, 0.5, 1, 8, 1, true).translate(0, 0.5, 0);
    let listaMarcas = [];
    const fijarMarcas = lista => {
        for (const m of listaMarcas) { marcas.remove(m.grupo); m.sprite.material.map.dispose(); m.sprite.material.dispose(); m.haz.material.dispose(); }
        listaMarcas = lista.map(p => {
            const grupo = new T.Group(), estado = p.base ? 'base' : 'pendiente';
            const sprite = etiqueta(p.nombre, p.base ? '⌂' : String(p.n), estado);
            const haz = new T.Mesh(geoHaz, new T.MeshBasicMaterial({ color: p.base ? 0x8ab4f8 : 0xffffff, transparent: true, opacity: 0.4, depthWrite: false }));
            haz.scale.set(1, 46, 1); sprite.position.y = 48;
            grupo.add(haz, sprite);
            const x = aX(p.lon), z = aZ(p.lat);
            grupo.position.set(x, alturaEn(x, z), z);
            marcas.add(grupo);
            return { ...p, grupo, sprite, haz, x, z, estado };
        });
    };

    // ── Ruta pintada en el suelo
    let ruta = null;            // { x[], z[], dist[], color[], total, emergencia }
    let estadoOv = { prog: -1, maniobra: null, aviso: null, modoA: -1, centroA: null, sucioB: true, sucioA: true, tB: 0 };
    const trazar = (g, rect, pxm, k0, k1) => {  // camino entre dos muestras, en píxeles de la textura
        const X = k => (ruta.x[k] - rect.x0) * pxm, Y = k => (ruta.z[k] - rect.z0) * pxm;
        g.beginPath(); g.moveTo(X(k0), Y(k0));
        for (let k = k0 + 1; k < k1; k++) g.quadraticCurveTo(X(k), Y(k), (X(k) + X(k + 1)) / 2, (Y(k) + Y(k + 1)) / 2);
        g.lineTo(X(k1), Y(k1));
    };
    const pintar = (ov, rect, anchoM, fino) => {
        const g = ov.g, pxm = PX_OV / rect.w;
        g.clearRect(0, 0, PX_OV, PX_OV);
        ov.rect = rect;
        if (!ruta) { ov.t.needsUpdate = true; return; }
        g.lineCap = 'round'; g.lineJoin = 'round';
        const n = ruta.x.length, dentro = k => ruta.x[k] > rect.x0 - 40 && ruta.x[k] < rect.x0 + rect.w + 40 && ruta.z[k] > rect.z0 - 40 && ruta.z[k] < rect.z0 + rect.w + 40;
        const ancho = Math.max(anchoM * pxm, 3);
        // Tramo con aviso (pendiente, sombra, sin radio…): resplandor ancho bajo la línea
        if (estadoOv.aviso) {
            const { ini, fin, color } = estadoOv.aviso;
            g.strokeStyle = color; g.globalAlpha = 0.45; g.lineWidth = ancho * 2.6; trazar(g, rect, pxm, ini, fin); g.stroke(); g.globalAlpha = 1;
        }
        // Borde y relleno por tramos del mismo color (gris lo ya recorrido)
        g.strokeStyle = ruta.emergencia ? '#8c1c13' : '#1557b0'; g.lineWidth = ancho * 1.42; trazar(g, rect, pxm, 0, n - 1); g.stroke();
        let k0 = 0;
        const colorDe = k => (ruta.dist[k] < estadoOv.prog ? '#9aa0a6' : ruta.color[k]);
        for (let k = 1; k <= n - 1; k++) {
            if (k < n - 1 && colorDe(k) === colorDe(k0)) continue;
            if (!fino || dentro(k0) || dentro(k) || dentro((k0 + k) >> 1)) { g.strokeStyle = colorDe(k0); g.lineWidth = ancho; trazar(g, rect, pxm, k0, k); g.stroke(); }
            k0 = k;
        }
        if (fino) {
            // Chevrones de sentido cada cierto trecho, por delante del caminante
            const paso = anchoM * 4.5; g.strokeStyle = 'rgba(255,255,255,.95)'; g.lineWidth = ancho * 0.16;
            let sig = Math.ceil(Math.max(0, estadoOv.prog) / paso) * paso;
            for (let k = 1; k < n; k++) {
                while (sig <= ruta.dist[k]) {
                    if (dentro(k)) {
                        const f = (sig - ruta.dist[k - 1]) / Math.max(1e-6, ruta.dist[k] - ruta.dist[k - 1]);
                        const x = (ruta.x[k - 1] + (ruta.x[k] - ruta.x[k - 1]) * f - rect.x0) * pxm, y = (ruta.z[k - 1] + (ruta.z[k] - ruta.z[k - 1]) * f - rect.z0) * pxm;
                        const a = Math.atan2(ruta.z[k] - ruta.z[k - 1], ruta.x[k] - ruta.x[k - 1]), r = ancho * 0.26;
                        g.save(); g.translate(x, y); g.rotate(a); g.beginPath(); g.moveTo(-r, -r); g.lineTo(r * 0.5, 0); g.lineTo(-r, r); g.stroke(); g.restore();
                    }
                    sig += paso;
                }
            }
            // Flecha de la próxima maniobra
            const m = estadoOv.maniobra;
            if (m?.length > 2) {
                const P = m.map(([x, z]) => [(x - rect.x0) * pxm, (z - rect.z0) * pxm]);
                const linea = () => { g.beginPath(); P.slice(0, -1).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); };
                g.lineCap = 'butt';
                g.strokeStyle = '#1557b0'; g.lineWidth = ancho * 0.74; linea(); g.stroke();
                g.strokeStyle = '#fff'; g.lineWidth = ancho * 0.44; linea(); g.stroke();
                const [ax, ay] = P[P.length - 3] || P[0], [bx, by] = P[P.length - 1], a = Math.atan2(by - ay, bx - ax), r = ancho * 0.95;
                g.save(); g.translate(bx, by); g.rotate(a); g.beginPath(); g.moveTo(r * 0.75, 0); g.lineTo(-r * 0.8, -r); g.lineTo(-r * 0.35, 0); g.lineTo(-r * 0.8, r); g.closePath();
                g.fillStyle = '#fff'; g.fill(); g.lineWidth = ancho * 0.18; g.strokeStyle = '#1557b0'; g.stroke(); g.restore();
                g.lineCap = 'round';
            }
        }
        // Anillo en cada parada
        for (const p of listaMarcas) {
            const x = (p.x - rect.x0) * pxm, y = (p.z - rect.z0) * pxm, r = Math.max(anchoM * 1.5 * pxm, 5);
            if (x < -r || y < -r || x > PX_OV + r || y > PX_OV + r) continue;
            const azul = p.base || p.estado === 'siguiente';
            g.beginPath(); g.arc(x, y, r, 0, 7); g.fillStyle = azul ? 'rgba(26,115,232,.92)' : p.estado === 'hecha' ? 'rgba(128,134,139,.9)' : 'rgba(255,255,255,.92)'; g.fill();
            g.lineWidth = Math.max(2, r * 0.22); g.strokeStyle = azul || p.estado === 'hecha' ? '#fff' : '#5f6368'; g.stroke();
        }
        ov.t.needsUpdate = true;
    };
    /** Punto [x, z, rumbo°] de la ruta suavizada a `d` metros del inicio. */
    let kRuta = 0;
    const puntoRuta = d => {
        const D = ruta.dist, n = D.length;
        if (kRuta > n - 2 || D[kRuta] > d) kRuta = 0;
        while (kRuta < n - 2 && D[kRuta + 1] < d) kRuta++;
        const k = kRuta, f = D[k + 1] > D[k] ? Math.max(0, Math.min(1, (d - D[k]) / (D[k + 1] - D[k]))) : 0;
        return [ruta.x[k] + (ruta.x[k + 1] - ruta.x[k]) * f, ruta.z[k] + (ruta.z[k + 1] - ruta.z[k]) * f, Math.atan2(ruta.x[k + 1] - ruta.x[k], -(ruta.z[k + 1] - ruta.z[k])) / RAD];
    };
    const rectUniforme = (u, r) => u.value.set(r.x0, r.z0, 1 / r.w, 1 / r.w);

    // ── Estado y cámara
    const E = {
        visible: false, lon: O.lon, lat: O.lat, rumbo: 0, x: 0, z: 0, ySuave: null,
        modo: 0, modoObjetivo: 0,       // 0 = seguimiento, 1 = astronauta
        entrada: 1, tEntrada: 0, ultimo: 0, escala: 1, techo: 1, lentas: 0, tEscala: 0, tiempos: [], fps: 60, tBajada: 0,
        sol: { az: 135, elev: 40 }, viento: { ms: 6, dir: 225, tau: 0.5 }, pendienteCalentar: 0,
    };
    enCasco = () => E.modoObjetivo === 1;
    const v1 = new T.Vector3(), v2 = new T.Vector3(), v3 = new T.Vector3(), v4 = new T.Vector3();
    const dirDe = (rumbo, el, out) => { const a = rumbo * RAD, e = el * RAD; return out.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)); };

    const aplicarLuz = () => {
        const { az, elev } = E.sol, e = Math.max(-6, elev);
        dirDe(az, Math.max(1.5, e), U.uSol.value);
        const dia = suave(e / 22), noche = suave((-e) / 6), tau = E.viento.tau ?? 0.5;
        // De día el cielo es ocre por el polvo; con el Sol bajo se enfría y el halo junto al Sol se vuelve azul.
        const hor = mezcla(mezcla([0.56, 0.52, 0.56], [0.90, 0.75, 0.59], dia), [0.05, 0.05, 0.09], noche);
        const zen = mezcla(mezcla([0.30, 0.31, 0.40], [0.72, 0.54, 0.38], dia), [0.02, 0.02, 0.05], noche);
        const halo = mezcla(mezcla([0.45, 0.62, 0.95], [0.55, 0.52, 0.48], dia), [0, 0, 0], noche);
        U.uCieloH.value.fromArray(hor); U.uCieloZ.value.fromArray(zen); U.uHalo.value.fromArray(halo);
        U.uSolCol.value.fromArray(elev > -1 ? mezcla([0.85, 0.92, 1.0], [1.0, 0.97, 0.9], dia) : [0, 0, 0]);
        U.uLuz.value = 0.3 + 0.7 * suave((e + 4) / 24);
        U.uDens.value = (0.6 + 0.9 * Math.min(3, tau)) / 15000;   // más polvo en suspensión (τ) = menos alcance visual
        const ms = Math.min(25, Math.max(1.5, E.viento.ms ?? 6)), dir = ((E.viento.dir ?? 225) + 180) * RAD;
        matPolvo.uniforms.uViento.value.set(Math.sin(dir) * ms * 0.5, -Math.cos(dir) * ms * 0.5);
        matPolvo.uniforms.uOpacidad.value = Math.min(0.55, 0.16 + 0.16 * tau) * (0.4 + 0.6 * U.uLuz.value);
    };
    aplicarLuz();

    const tamano = () => {
        const w = lienzo.clientWidth || innerWidth, h = lienzo.clientHeight || innerHeight;
        render.setPixelRatio(Math.min(devicePixelRatio || 1, integrada ? 1 : 1.5) * E.escala);
        render.setSize(w, h, false);
        camara.aspect = w / h; camara.updateProjectionMatrix();
        matPolvo.uniforms.uPx.value = h * 0.09;
    };
    addEventListener('resize', () => { if (E.visible) tamano(); });

    /** Resolución adaptativa: si no se sostienen ~55 fps se dibujan menos píxeles; si sobra, se recuperan. */
    const adaptar = (dt, ahora) => {
        if (E.escalaFija) { if (E.escala !== E.escalaFija) { E.escala = E.escalaFija; tamano(); } }
        const t = E.tiempos; t.push(dt); if (t.length < 40) return;
        // Mediana de 40 fotogramas: un tirón suelto (un trozo que entra, otra pestaña) no cuenta; solo se baja si la
        // GPU no llega de forma sostenida (dos ventanas seguidas) y se vuelve a probar más resolución a los 4 s.
        const orden = t.slice().sort((a, b) => a - b), medio = orden[20]; t.length = 0;
        E.fps = 1000 / medio;
        if (E.escalaFija) return;
        if (medio > 19.5 && E.escala > 0.5) {
            if (++E.lentas < 2) return;
            E.escala = Math.max(0.5, E.escala - (medio > 26 ? 0.15 : 0.08)); E.techo = E.escala + 0.04; E.tBajada = ahora; tamano();
        } else {
            E.lentas = 0;
            if (medio < 17.4 && E.escala < 1 && (E.escala + 0.05 <= E.techo || ahora - E.tBajada > 4000)) { E.escala = Math.min(1, E.escala + 0.1); E.techo = Math.max(E.techo, E.escala); E.tBajada = ahora; tamano(); }
        }
    };

    const colocarCamara = (dt) => {
        const sueloY = alturaEn(E.x, E.z);
        E.ySuave = E.ySuave == null ? sueloY : E.ySuave + (sueloY - E.ySuave) * (1 - Math.exp(-dt * 7));
        const m = suave(E.modo), intro = suave(E.entrada);
        // Seguimiento: detrás y por encima del caminante; arrastrar gira alrededor, la rueda acerca o aleja.
        const yawS = E.rumbo + mirada.yaw * (1 - m), elS = Math.max(8, Math.min(80, 30 - mirada.pitch * 1.6 * (1 - m)));
        const dist = 150 * Math.pow(2, -mirada.zoomOffset * 0.35 * (1 - m));
        dirDe(yawS, 0, v1);                                                        // hacia delante, horizontal
        const posS = v2.set(E.x, E.ySuave, E.z).addScaledVector(v1, -dist * Math.cos(elS * RAD)); posS.y += dist * Math.sin(elS * RAD);
        const miraS = v3.set(E.x, E.ySuave + 2, E.z).addScaledVector(v1, dist * 0.1); miraS.y -= dist * 0.1;
        // Astronauta: en los ojos del caminante; arrastrar mueve la cabeza, la rueda hace zoom.
        const ojos = CAMARA.alturaOjos, yawA = E.rumbo + mirada.yaw, elA = Math.max(-70, Math.min(55, -5 + mirada.pitch));
        const posA = v4.set(E.x, E.ySuave + ojos, E.z);
        posS.lerp(posA, m);
        dirDe(yawA, elA, v1); posA.addScaledVector(v1, 50);                         // punto de mira del astronauta
        miraS.lerp(posA, m);
        // Entrada: la cámara baja desde arriba hasta su sitio (como dejarse caer del mapa al suelo).
        if (intro < 1) { dirDe(E.rumbo, 0, v1); v4.set(E.x, E.ySuave + 900, E.z).addScaledVector(v1, -500); posS.lerpVectors(v4, posS, intro); }
        const minimo = alturaEn(posS.x, posS.z) + (1.2 + 5 * (1 - m));
        if (posS.y < minimo) posS.y = minimo;
        camara.position.copy(posS); camara.lookAt(miraS);
        const fovA = Math.max(18, Math.min(95, 70 / Math.pow(2, mirada.zoomOffset * 0.35)));
        const fov = 46 + (fovA - 46) * m;
        const cercano = 0.35 + 3 * (1 - m);
        if (Math.abs(camara.fov - fov) > 0.05 || Math.abs(camara.near - cercano) > 0.01) { camara.fov = fov; camara.near = cercano; camara.updateProjectionMatrix(); }
        // Flecha del caminante: se ve en seguimiento y se desvanece al entrar en el casco.
        // Su tamaño sale de la distancia de la vista ya asentada (no de la cámara que aún baja en la entrada) y aparece
        // con un fundido al final de la bajada.
        const a = (1 - suave(E.modo * 1.6)) * suave((E.entrada - 0.55) / 0.45);
        flecha.visible = a > 0.02;
        if (flecha.visible) {
            const s = Math.max(3.2, dist * 0.05) * (0.8 + 0.2 * suave((E.entrada - 0.55) / 0.45));
            flecha.position.set(E.x, E.ySuave + 0.6, E.z); flecha.rotation.y = -E.rumbo * RAD; flecha.scale.setScalar(s);
            flecha.userData.borde.material.opacity = a; flecha.userData.relleno.material.opacity = a;
            flecha.userData.relleno.material.color.set(ruta?.emergencia ? 0xd93025 : 0x1a73e8);
        }
        polvo.visible = E.modo > 0.3;
    };

    const actualizarOverlay = ahora => {
        if (!ruta) return;
        // Textura B: toda la ruta. Se repinta al cambiar la ruta y, para el tramo recorrido, cada 1,5 s.
        if (estadoOv.sucioB || (ahora - estadoOv.tB > 1500 && estadoOv.progB !== estadoOv.prog)) {
            estadoOv.sucioB = false; estadoOv.tB = ahora; estadoOv.progB = estadoOv.prog;
            let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
            for (let k = 0; k < ruta.x.length; k++) { x0 = Math.min(x0, ruta.x[k]); x1 = Math.max(x1, ruta.x[k]); z0 = Math.min(z0, ruta.z[k]); z1 = Math.max(z1, ruta.z[k]); }
            const w = Math.max(x1 - x0, z1 - z0) + 240, rect = { x0: (x0 + x1 - w) / 2, z0: (z0 + z1 - w) / 2, w };
            pintar(ovB, rect, Math.max(16, w / PX_OV * 3.6), false); rectUniforme(U.uOvBRect, rect);
        }
        // Textura A: ventana fina centrada en el caminante (más pequeña y nítida en el casco).
        const modoA = E.modoObjetivo, w = modoA ? 280 : 760, c = estadoOv.centroA;
        if (estadoOv.sucioA || estadoOv.modoA !== modoA || !c || Math.hypot(E.x - c[0], E.z - c[1]) > w * 0.14 || (ahora - estadoOv.tA > 900 && estadoOv.progA !== estadoOv.prog)) {
            estadoOv.sucioA = false; estadoOv.modoA = modoA; estadoOv.centroA = [E.x, E.z]; estadoOv.tA = ahora; estadoOv.progA = estadoOv.prog;
            // Centrada algo por delante del caminante: lo que importa está en el sentido de la marcha.
            dirDe(E.rumbo, 0, v1);
            const rect = { x0: E.x + v1.x * w * 0.2 - w / 2, z0: E.z + v1.z * w * 0.2 - w / 2, w };
            pintar(ovA, rect, modoA ? 2.2 : 7.5, true); rectUniforme(U.uOvARect, rect);
        }
    };

    let rafId = 0;
    const fotograma = ts => {
        rafId = E.visible && !E.pausado ? requestAnimationFrame(fotograma) : 0;
        if (document.hidden) { E.ultimo = 0; return; }           // pestaña en segundo plano: nada que dibujar
        const dt = E.ultimo ? Math.min(0.1, (ts - E.ultimo) / 1000) : 0.016;
        if (E.ultimo && E.visible) adaptar(ts - E.ultimo, ts);
        E.ultimo = ts;
        dibujar(dt, ts);
    };
    const dibujar = (dt, ts) => {
        U.uTiempo.value = (ts / 1000) % 3600;
        // Como mucho dos trozos nuevos por fotograma: subir mallas y texturas a la GPU no debe notarse.
        for (let k = 0; k < 2 && pendientesMontar.length; k++) { const [clave, d] = pendientesMontar.shift(); montar(clave, d); }
        E.modo += Math.sign(E.modoObjetivo - E.modo) * Math.min(Math.abs(E.modoObjetivo - E.modo), dt / 1.1);
        if (E.entrada < 1) E.entrada = Math.min(1, E.entrada + dt / 1.7);
        colocarCamara(dt);
        U.uOvOp.value = 1 - suave(E.modo);   // en el casco guía la realidad aumentada, no la línea pintada en el suelo
        actualizarOverlay(ts);
        actualizarAR();
        for (const m of listaMarcas) {
            m.grupo.position.y = alturaEn(m.x, m.z);
            const d = camara.position.distanceTo(m.grupo.position);
            m.sprite.material.opacity = suave((d - 25) / 60); m.haz.material.opacity = 0.4 * suave((d - 40) / 150);
            // Tamaño fijo en pantalla aunque cambie el campo de visión (zoom del casco).
            const s = (m.siguiente ? 0.3 : 0.24) * Math.tan(camara.fov * RAD / 2) / 0.42; m.sprite.scale.set(s, s * 160 / 512, 1);
        }
        render.render(escena, camara);
    };

    // ───────────────────────── API ─────────────────────────
    const mundo = {
        listo: lejosListo,
        get visible() { return E.visible; },
        alturaEn: (lon, lat) => alturaEn(aX(lon), aZ(lat)),

        /**
         * Ruta activa: muestras { lon[], lat[], dist[] }, color por muestra y paradas [{ nombre, n, lon, lat, base }].
         * Precarga en memoria todas las teselas que pisa (relieve y ortoimagen) y reconstruye las rocas sin pisar el camino.
         */
        fijarRuta(s, colores, paradas, { emergencia = false } = {}) {
            const n = s.lon.length, RS = 14;
            ruta = { x: new Float32Array(n), z: new Float32Array(n), dist: s.dist, color: colores, total: s.dist[n - 1], emergencia };
            const plano = new Float32Array(n * 2), bx = new Float32Array(n), bz = new Float32Array(n);
            for (let k = 0; k < n; k++) { bx[k] = plano[k * 2] = aX(s.lon[k]); bz[k] = plano[k * 2 + 1] = aZ(s.lat[k]); }
            // Esquinas redondeadas: cada punto es la media (peso triangular) de los que tiene a ±14 m por el camino. Los
            // extremos y las paradas no se mueven. El caminante y la cámara siguen esta misma línea.
            const fijos = new Set([0, n - 1, ...paradas.map(p => { let m = 0, dm = Infinity; const px = aX(p.lon), pz = aZ(p.lat); for (let k = 0; k < n; k++) { const d = (bx[k] - px) ** 2 + (bz[k] - pz) ** 2; if (d < dm) { dm = d; m = k; } } return dm < 400 ? m : -1; })]);
            for (let k = 0; k < n; k++) {
                let lim = RS;
                for (const f of fijos) if (f >= 0) lim = Math.min(lim, Math.abs(s.dist[f] - s.dist[k]));   // cerca de un punto fijo, menos suavizado
                if (lim < 0.5) { ruta.x[k] = bx[k]; ruta.z[k] = bz[k]; continue; }
                let a = k, b = k;
                while (a > 0 && s.dist[k] - s.dist[a - 1] <= lim) a--;
                while (b < n - 1 && s.dist[b + 1] - s.dist[k] <= lim) b++;
                let sx = 0, sz = 0, sw = 0;
                for (let q = a; q <= b; q++) { const w = 1 - Math.abs(s.dist[q] - s.dist[k]) / (lim + 1e-6) + 0.02; sx += bx[q] * w; sz += bz[q] * w; sw += w; }
                ruta.x[k] = sx / sw; ruta.z[k] = sz / sw;
            }
            W.llamar({ tipo: 'ruta', puntos: plano });
            fijarMarcas(paradas);
            Object.assign(estadoOv, { sucioA: true, sucioB: true, maniobra: null, infoManiobra: null, aviso: null, prog: -1 });
            // Los trozos ya construidos conservan sus rocas; los nuevos evitan el camino nuevo.
            if (!rangoDem) return Promise.resolve();
            const urls = new Set();
            let ant = '';
            for (let k = 0; k < n; k++) {
                const cx = Math.floor(xTesela(s.lon[k], Z)), cy = Math.floor(yTesela(s.lat[k], Z)), clave = `${cx}/${cy}`;
                if (clave === ant) continue; ant = clave;
                for (let dy = -RADIO; dy <= RADIO; dy++) for (let dx = -RADIO; dx <= RADIO; dx++) {
                    const x = cx + dx, y = cy + dy;
                    if (!hayTrozo(x, y)) continue;
                    urls.add(op.relieve.url.replace('{z}', Z).replace('{x}', x).replace('{y}', y));
                    urls.add(op.orto.url.replace('{z}', Z).replace('{x}', x).replace('{y}', y));
                    if (Math.max(Math.abs(dx), Math.abs(dy)) <= 1 && Z + 1 <= op.orto.zoom_max) {
                        for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]]) urls.add(op.orto.url.replace('{z}', Z + 1).replace('{x}', 2 * x + i).replace('{y}', 2 * y + j));
                    }
                }
            }
            return W.llamar({ tipo: 'precargar', urls: [...urls] });
        },

        /** Deja construido (mallas, texturas y sombreadores ya en la GPU) el entorno de un punto, sin mostrarlo. */
        async calentar(lon, lat) {
            await lejosListo;
            actualizarTrozos(lon, lat);
            const t0 = performance.now();
            while ((enCurso || cola.length || pendientesMontar.length) && performance.now() - t0 < 8000) {
                while (pendientesMontar.length) { const [clave, d] = pendientesMontar.shift(); montar(clave, d); }
                await new Promise(r => setTimeout(r, 30));
            }
            if (E.visible) return;
            Object.assign(E, { lon, lat, x: aX(lon), z: aZ(lat), ySuave: null });
            tamano();
            for (const modo of [0, 1]) { E.modo = modo; dibujar(0.016, performance.now()); }   // compila los sombreadores de las dos vistas
            E.modo = E.modoObjetivo;
        },

        /** Posición del caminante y estado de la simulación (cada fotograma de la navegación). */
        actualizar(d) {
            E.lon = d.lon; E.lat = d.lat; E.x = aX(d.lon); E.z = aZ(d.lat); E.rumbo = d.rumbo; E.dist = d.dist ?? null;
            if (ruta && d.dist != null) { const p = puntoRuta(d.dist); E.x = p[0]; E.z = p[1]; }
            if (d.progreso != null) estadoOv.prog = d.progreso;
            if (d.sol && (Math.abs(d.sol.elev - E.sol.elev) > 0.05 || Math.abs(d.sol.az - E.sol.az) > 0.05)) { E.sol = d.sol; aplicarLuz(); }
            if (d.viento && (d.viento.ms !== E.viento.ms || d.viento.tau !== E.viento.tau || d.viento.dir !== E.viento.dir)) { E.viento = d.viento; aplicarLuz(); }
            if (d.siguiente !== undefined) for (const m of listaMarcas) {
                m.siguiente = m.id === d.siguiente;
                const estado = m.base ? 'base' : m.siguiente ? 'siguiente' : d.hechas?.includes(m.id) ? 'hecha' : 'pendiente';
                if (estado !== m.estado) {
                    m.estado = estado; pintarEtiqueta(m.sprite.material.map.image, m.nombre, String(m.n), estado); m.sprite.material.map.needsUpdate = true;
                    m.haz.material.color.set(estado === 'siguiente' ? 0x4d9bff : estado === 'hecha' ? 0x9aa0a6 : 0xffffff); estadoOv.sucioA = estadoOv.sucioB = true;
                }
            }
            actualizarTrozos(d.lon, d.lat);
        },
        /** Flecha de la próxima maniobra: lista de [lon, lat] o null. */
        maniobra(pts, info = null) { estadoOv.maniobra = pts ? pts.map(([lon, lat]) => [aX(lon), aZ(lat)]) : null; estadoOv.infoManiobra = pts ? info : null; estadoOv.sucioA = true; },
        /** Tramo con aviso resaltado: { ini, fin, color } (índices de muestra) o null. */
        tramoAviso(a) { estadoOv.aviso = a; estadoOv.sucioA = estadoOv.sucioB = true; },
        /** Detiene el dibujo mientras algo lo tapa por completo (la vista 360°) y lo reanuda después. */
        pausa(v) { E.pausado = !!v; if (!v && E.visible && !rafId) { E.ultimo = 0; rafId = requestAnimationFrame(fotograma); } },
        /** Primera persona (true) o cámara de seguimiento (false); `ya` salta sin transición. */
        astronauta(v, ya = false) { E.modoObjetivo = v ? 1 : 0; if (ya) E.modo = E.modoObjetivo; },

        mostrar(v, { entrada = true } = {}) {
            if (v === E.visible) return;
            E.visible = v;
            if (v) {
                E.ultimo = 0; E.tiempos.length = 0; E.ySuave = null; E.entrada = entrada ? 0 : 1; E.modo = E.modoObjetivo;
                tamano();
                lienzo.classList.add('visible');
                if (!rafId) rafId = requestAnimationFrame(fotograma);
            } else lienzo.classList.remove('visible');
        },
        info: () => ({ fps: +E.fps.toFixed(1), escala: +E.escala.toFixed(2), trozos: [...trozos.values()].filter(t => t.malla).length, pendientes: enCurso + cola.length,
            triangulos: render.info.render.triangles, llamadas: render.info.render.calls, texturas: render.info.memory.textures, modo: +E.modo.toFixed(2) }),
        lienzo,
        /** Solo para medir y depurar desde la consola. */
        _: { E, escena, render, camara, trozos, U },
    };
    return mundo;
}
