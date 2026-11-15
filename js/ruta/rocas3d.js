/**
 * @module rocas3d
 * @author Hamza
 * @description Rocas y bloques en 3D alrededor del astronauta (modo astronauta).
 *
 * MapLibre solo dibuja el terreno como una malla continua: las rocas pequeñas no existen en ningún DTM (el de
 * HiRISE llega a 1 m) y pintadas en el suelo se ven planas. Esta capa personalizada dibuja con three.js piedras
 * y bloques con volumen, iluminados por el Sol del planificador y apoyados sobre el relieve.
 *
 * Son decorativas: su posición y tamaño se generan con una semilla por celda (siempre las mismas en el mismo sitio).
 * Solo rocas grandes y bloques (0,9-4 m), más densos en manchas, para que el modo astronauta vaya fluido.
 * No intervienen en la ruta ni en las capas de peligro.
 */
const URL_THREE = 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.min.js';
const ESCALA_MAPA = 6371008.8 / 3396190;  // metros de mapa por metro real (radio Tierra / radio Marte)
const RADIO_M = 140;                      // radio (m reales) alrededor del caminante con rocas
const CELDA_M = 7;                        // una posible roca por celda
const REGENERAR_M = 45;                   // se recolocan al alejarse esta distancia
const VARIANTES = 6;
const MAX_POR_VARIANTE = 250;

let THREE = null, capa = null, estado = null;

function hash(i, j, k = 0) {  // entero → [0, 1), estable entre equipos
    let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Piedra irregular: icosaedro deformado con ruido, aplastado y con caras planas (roca fracturada). */
function geometriaRoca(semilla) {
    const g = new THREE.IcosahedronGeometry(1, 2);
    const p = g.attributes.position, v = new THREE.Vector3();
    const lobulos = Array.from({ length: 5 }, (_, i) => new THREE.Vector3(hash(semilla, i, 1) - .5, hash(semilla, i, 2) - .5, hash(semilla, i, 3) - .5).normalize());
    for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).normalize();
        let r = 1;
        lobulos.forEach((l, k) => { r += 0.22 * Math.max(0, v.dot(l)) ** 3 * (k % 2 ? -1 : 1); });
        r += 0.07 * Math.sin(v.x * 7 + semilla) * Math.cos(v.z * 6 - semilla) + 0.05 * Math.sin(v.y * 11 + semilla * 3);
        v.multiplyScalar(r);
        v.y = v.y * (0.45 + hash(semilla, 9, 9) * 0.3);
        if (v.y < -0.15) v.y = -0.15 + (v.y + 0.15) * 0.3;  // base plana: la roca se apoya en el suelo
        p.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    return g;
}

/** Tamaño real (m) de la roca de una celda, o 0 si no hay roca. Ley de potencias: muchas pequeñas, pocos bloques. */
function tamanoCelda(i, j) {
    // Más rocas en manchas (como los campos de bloques de Séítah) y pocas en el suelo arenoso.
    // Solo rocas grandes y bloques (las piedras pequeñas no se distinguen desde la altura de los ojos y cuestan).
    const mancha = hash(Math.floor(i / 5), Math.floor(j / 5), 21);
    if (hash(i, j, 11) > 0.04 + 0.26 * mancha * mancha) return 0;
    const t = hash(i, j, 12);
    return Math.min(0.9 * Math.pow(1 - t, -0.55), 4);   // 0,9 m mínimo; algunos bloques de 2-4 m
}

function crearCapa(map) {
    return {
        id: 'astro-rocas', type: 'custom', renderingMode: '3d',
        onAdd(m, gl) {
            this.map = m;
            this.camara = new THREE.Camera();
            this.escena = new THREE.Scene();
            this.sol = new THREE.DirectionalLight(0xfff0dc, 2.2);
            this.escena.add(this.sol, this.sol.target);
            this.cielo = new THREE.HemisphereLight(0xd9a27a, 0x3a1e10, 0.75);
            this.escena.add(this.cielo);
            const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, flatShading: false });
            this.mallas = Array.from({ length: VARIANTES }, (_, k) => {
                const malla = new THREE.InstancedMesh(geometriaRoca(k + 1), material, MAX_POR_VARIANTE);
                malla.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
                malla.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_POR_VARIANTE * 3), 3);
                malla.count = 0; malla.frustumCulled = false;
                this.escena.add(malla);
                return malla;
            });
            // Sombra de contacto: mancha oscura bajo cada roca, desplazada hacia el lado contrario al Sol.
            const c = document.createElement('canvas'); c.width = c.height = 64;
            const g2 = c.getContext('2d'), grad = g2.createRadialGradient(32, 32, 4, 32, 32, 32);
            grad.addColorStop(0, 'rgba(20,9,4,0.75)'); grad.addColorStop(0.6, 'rgba(20,9,4,0.35)'); grad.addColorStop(1, 'rgba(20,9,4,0)');
            g2.fillStyle = grad; g2.fillRect(0, 0, 64, 64);
            const planoSombra = new THREE.PlaneGeometry(1, 1); planoSombra.rotateX(-Math.PI / 2);
            this.sombras = new THREE.InstancedMesh(planoSombra, new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }), VARIANTES * MAX_POR_VARIANTE);
            this.sombras.count = 0; this.sombras.frustumCulled = false; this.sombras.renderOrder = -1;
            this.escena.add(this.sombras);
            this.polvo = crearPolvo();
            this.escena.add(this.polvo);
            this.render3 = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
            this.render3.autoClear = false;
        },
        render(gl, args) {
            if (estado) estado.renders = (estado.renders || 0) + 1;
            if (!estado?.origen || !estado.visible || m_proyeccionGlobo(this.map)) return;
            const o = estado.origen, s = o.mc.meterInMercatorCoordinateUnits();
            const l = new THREE.Matrix4().makeTranslation(o.mc.x, o.mc.y, o.mc.z)
                .scale(new THREE.Vector3(s, -s, s)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
            this.camara.projectionMatrix = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix).multiply(l);
            const ahora = (performance.now() / 1000) % 3600;
            for (const capaPolvo of [this.polvo]) {
                const u = capaPolvo.material.uniforms;
                u.uTiempo.value = ahora;
                if (estado.camLocal) u.uCam.value.copy(estado.camLocal);
            }
            this.render3.resetState();
            this.render3.render(this.escena, this.camara);
            // El polvo se mueve aunque la simulación esté en pausa: se pide otro fotograma a ~20 fps como mucho.
            if (!this.siguiente) this.siguiente = setTimeout(() => { this.siguiente = null; if (estado?.visible) this.map.triggerRepaint(); }, 50);
        },
    };
}
const m_proyeccionGlobo = map => map.getProjection?.()?.type === 'globe';

/**
 * Polvo en suspensión: nubecillas suaves que derivan con el viento cerca del suelo, en una caja que acompaña a la cámara.
 * Velocidad y dirección del viento de EMARS y densidad según la opacidad del polvo (tau) del MCD, del panel
 * de condiciones. Ráfagas suaves cada pocos segundos. Todo en el shader: no cuesta nada en JavaScript.
 */
const N_POLVO = 80, CAJA = 200;  // nubecillas de polvo y lado de la caja (m de mapa)
function crearPolvo() {
    const N = N_POLVO;
    const base = new Float32Array(N * 3), fase = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        base[i * 3] = (hash(i, 1, 31) - 0.5) * CAJA;
        base[i * 3 + 1] = 2 + hash(i, 2, 32) * 10;   // rozando el suelo
        base[i * 3 + 2] = (hash(i, 3, 31) - 0.5) * CAJA;
        fase[i] = hash(i, 4, 31) * 100;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(base, 3));
    geo.setAttribute('fase', new THREE.BufferAttribute(fase, 1));
    const material = new THREE.ShaderMaterial({
        uniforms: {
            uTiempo: { value: 0 }, uCam: { value: new THREE.Vector3() }, uViento: { value: new THREE.Vector2(3, 1) },
            uCaja: { value: CAJA }, uDensidad: { value: 0.6 }, uTam: { value: 160000 }, uTamMax: { value: 260 },
            uOpacidad: { value: 0.08 }, uColor: { value: new THREE.Color(0xe6b88c) },
        },
        vertexShader: `uniform float uTiempo; uniform vec3 uCam; uniform vec2 uViento; uniform float uCaja; uniform float uDensidad;
            uniform float uTam; uniform float uTamMax; attribute float fase; varying float vAlfa;
            void main() {
                float rafaga = 0.65 + 0.35 * sin(uTiempo * 0.7 + fase * 0.05) * sin(uTiempo * 0.23);
                vec3 p = position;
                p.xz += uViento * uTiempo * rafaga;
                p.y += sin(uTiempo * 0.9 + fase) * 1.5 + sin(uTiempo * 2.3 + fase * 2.0) * 0.4;
                p.xz = mod(p.xz - uCam.xz + 0.5 * uCaja, uCaja) - 0.5 * uCaja + uCam.xz;   // caja que sigue a la cámara
                p.y += uCam.y;
                vec4 c = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
                gl_Position = c;
                float d = length(p.xz - uCam.xz);
                vAlfa = (1.0 - smoothstep(0.30 * uCaja, 0.5 * uCaja, d)) * uDensidad * (fract(fase) < uDensidad ? 1.0 : 0.0);
                gl_PointSize = clamp(uTam / max(c.w, 1e-6), 1.5, uTamMax);
            }`,
        fragmentShader: `uniform vec3 uColor; uniform float uOpacidad; varying float vAlfa;
            void main() {
                vec2 q = gl_PointCoord - 0.5; float r = dot(q, q);
                if (r > 0.25 || vAlfa < 0.01) discard;
                float borde = 1.0 - r * 4.0;
                gl_FragColor = vec4(uColor, vAlfa * borde * borde * uOpacidad);
            }`,
        transparent: true, depthWrite: false,
    });
    const puntos = new THREE.Points(geo, material);
    puntos.frustumCulled = false; puntos.renderOrder = 2;
    return puntos;
}

/** Coloca las rocas de las celdas alrededor de (lon, lat). Coordenadas de la escena: x este, y arriba, z sur (m de mapa). */
function recolocar(map, lon, lat, ruta) {
    const mc0 = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], map.queryTerrainElevation([lon, lat]) ?? 0);
    const s = mc0.meterInMercatorCoordinateUnits();
    estado.origen = { lon, lat, mc: mc0, elev: mc0.z / s };
    const R = 6371008.8, rad = Math.PI / 180;
    const mLon = R * Math.cos(lat * rad) * rad / ESCALA_MAPA, mLat = R * rad / ESCALA_MAPA;  // m reales por grado
    const ci = Math.floor(lon * mLon / CELDA_M), cj = Math.floor(lat * mLat / CELDA_M), n = Math.ceil(RADIO_M / CELDA_M);
    const capa3 = capa, cuentas = new Array(VARIANTES).fill(0);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), E = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    const solAz = (estado.sol?.az ?? 135) * rad, solEl = Math.max(5, estado.sol?.elev ?? 35) * rad;
    const largoSombra = Math.min(3, 1 / Math.tan(solEl));
    // Tramos de la ruta cerca del caminante (m reales, relativos a él): ahí no se ponen rocas.
    const tramos = [];
    if (ruta?.lon) {
        let ant = null;
        for (let k = 0; k < ruta.lon.length; k++) {
            const x = (ruta.lon[k] - lon) * mLon, y = (ruta.lat[k] - lat) * mLat;
            if (ant && Math.min(Math.hypot(x, y), Math.hypot(ant[0], ant[1])) < RADIO_M + 30) tramos.push([ant[0], ant[1], x, y]);
            ant = [x, y];
        }
    }
    const libre = (x, y, radio) => {
        for (const [ax, ay, bx, by] of tramos) {
            const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
            if (Math.hypot(x - ax - t * dx, y - ay - t * dy) < 2.5 + radio) return false;
        }
        return true;
    };
    let ns = 0;
    for (let di = -n; di <= n; di++) for (let dj = -n; dj <= n; dj++) {
        if (di * di + dj * dj > n * n) continue;
        const i = ci + di, j = cj + dj, d = tamanoCelda(i, j);
        if (!d) continue;
        const k = Math.floor(hash(i, j, 13) * VARIANTES);
        if (cuentas[k] >= MAX_POR_VARIANTE) continue;
        const rlon = (i + hash(i, j, 14)) * CELDA_M / mLon, rlat = (j + hash(i, j, 15)) * CELDA_M / mLat;
        if (!libre((rlon - lon) * mLon, (rlat - lat) * mLat, d)) continue;
        const elev = map.queryTerrainElevation([rlon, rlat]);
        if (elev == null) continue;
        const mc = maplibregl.MercatorCoordinate.fromLngLat([rlon, rlat], elev);
        // Radio en metros de mapa, con la misma exageración vertical que el relieve para que casen en proporción.
        const tam = d * (map.getTerrain()?.exaggeration ?? ESCALA_MAPA) / 2;
        P.set((mc.x - mc0.x) / s, elev - estado.origen.elev - tam * 0.12, (mc.y - mc0.y) / s);
        Q.setFromAxisAngle(Y, hash(i, j, 16) * Math.PI * 2);
        E.set(tam * (0.8 + hash(i, j, 17) * 0.5), tam, tam * (0.8 + hash(i, j, 18) * 0.5));
        M.compose(P, Q, E);
        const malla = capa3.mallas[k];
        malla.setMatrixAt(cuentas[k], M);
        const t = hash(i, j, 19);  // tonos de roca de Jezero: basalto gris oscuro con polvo rojizo
        col.setRGB(0.36 + t * 0.22, 0.22 + t * 0.12, 0.15 + t * 0.07);
        malla.setColorAt(cuentas[k], col);
        cuentas[k]++;
        {  // sombra de contacto
            const ls = tam * (1.6 + largoSombra);
            P.x += Math.sin(solAz + Math.PI) * tam * largoSombra * 0.6; P.z -= Math.cos(solAz + Math.PI) * tam * largoSombra * 0.6;
            P.y = elev - estado.origen.elev + 0.02;
            Q.setFromAxisAngle(Y, -solAz);
            E.set(tam * 2.2, 1, ls);
            M.compose(P, Q, E);
            capa3.sombras.setMatrixAt(ns++, M);
        }
    }
    capa3.mallas.forEach((m, k) => { m.count = cuentas[k]; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; });
    capa3.sombras.count = ns; capa3.sombras.instanceMatrix.needsUpdate = true;
    estado.ultimaPos = [lon, lat];
    return cuentas.reduce((a, b) => a + b, 0);
}

/** Activa la capa (carga three.js la primera vez). Devuelve false si no se puede cargar. */
export async function activarRocas(map) {
    if (!THREE) {
        try { THREE = await import(URL_THREE); } catch (e) { console.warn('[astronauta] three.js no disponible, sin rocas 3D:', e.message); return false; }
    }
    estado ||= { visible: false };
    if (!map.getLayer('astro-rocas')) { capa = crearCapa(map); map.addLayer(capa); }
    estado.visible = true;
    return true;
}
export function desactivarRocas(map) {
    if (estado) estado.visible = false;
    if (capa?.siguiente) { clearTimeout(capa.siguiente); capa.siguiente = null; }
    map.triggerRepaint();
}

/** Llamar en cada paso del modo astronauta con la posición del caminante y el Sol del planificador. */
export function actualizarRocas(map, lon, lat, sol, ruta, viento) {
    if (!estado?.visible || !capa?.mallas) return;
    if (viento && capa.polvo) {
        // Viento de EMARS: dirección meteorológica (de dónde sopla) → vector hacia donde va, en x este / z sur.
        const ms = Math.min(25, Math.max(1.5, viento.ms ?? 5)), dir = ((viento.dir ?? 225) + 180) * Math.PI / 180;
        for (const capaPolvo of [capa.polvo]) {
            const u = capaPolvo.material.uniforms;
            u.uViento.value.set(Math.sin(dir) * ms * ESCALA_MAPA, -Math.cos(dir) * ms * ESCALA_MAPA);
            u.uDensidad.value = Math.min(1, 0.45 + 0.4 * (viento.tau ?? 0.6));
        }
    }
    if (sol) {
        estado.sol = sol;
        const rad = Math.PI / 180, el = Math.max(2, sol.elev) * rad, az = sol.az * rad;
        capa.sol.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).multiplyScalar(100);
        capa.sol.intensity = sol.elev > 0 ? 2.2 : 0.15;
    }
    // Posición del caminante en las coordenadas de la escena (para que la caja de polvo le siga).
    if (estado.origen) {
        const mc = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], 0), s = estado.origen.mc.meterInMercatorCoordinateUnits();
        const e = map.queryTerrainElevation([lon, lat]);
        (estado.camLocal ||= new THREE.Vector3()).set((mc.x - estado.origen.mc.x) / s, (e ?? estado.origen.elev) - estado.origen.elev, (mc.y - estado.origen.mc.y) / s);
    }
    const lejos = !estado.ultimaPos || Math.hypot((lon - estado.ultimaPos[0]) * 105000, (lat - estado.ultimaPos[1]) * 111000) > REGENERAR_M;
    if (lejos) estado.n = recolocar(map, lon, lat, ruta);
}
export const infoRocas = () => ({ cargado: !!THREE, visible: !!estado?.visible, rocas: estado?.n || 0, renders: estado?.renders || 0, origen: estado?.origen && { lon: estado.origen.lon, lat: estado.origen.lat, elev: Math.round(estado.origen.elev) } });
