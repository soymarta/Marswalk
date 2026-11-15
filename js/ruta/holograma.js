/**
 * @module holograma
 * @author Hani (módulo 5: rutas y seguridad)
 * @description Cuerpo humano «de luz» para el panel del cuerpo: modelo CC0 de Quaternius (Universal Base Characters,
 * animación de marcha de la Universal Animation Library) dibujado como holograma: piel translúcida con brillo en los
 * bordes (Fresnel), malla de líneas tenue y una línea de escaneo. Cada vértice pertenece a una zona del cuerpo según
 * el hueso que más lo mueve; la zona se tiñe de verde, ámbar o rojo (el rojo late) con el estado de fisiologia.js.
 *
 * Ficheros (CC0, https://quaternius.com): data/ruta/cuerpo/cuerpo.glb (personaje con esqueleto) y, opcional,
 * data/ruta/cuerpo/animaciones.glb (clips sobre el mismo esqueleto). Si no están, `montarHolograma` devuelve null y el
 * panel sigue con la silueta SVG.
 */

const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.169.0/+esm';
const GLTF_URL = 'https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/loaders/GLTFLoader.js/+esm';
const MODELO = 'data/ruta/cuerpo/cuerpo.glb';
const ANIMACIONES = 'data/ruta/cuerpo/animaciones.glb';

/** Zonas en el orden del uniforme de colores; 7 = sin zona (brazos, cadera). */
const ZONAS = ['corazon', 'muslos', 'gemelos', 'manos', 'glucogeno', 'agua', 'radiacion'];
const SIN_ZONA = 7;
const COLOR = { verde: [0.51, 0.79, 0.58], ambar: [0.99, 0.84, 0.39], rojo: [0.95, 0.35, 0.32] };
const BASE = [0.55, 0.85, 1.0];   // cian del holograma

/**
 * Cuerpo hecho con cápsulas (sin ficheros externos): articulaciones como grupos, cada pieza con su zona, y una marcha
 * por código (muslos, rodillas y brazos en contrafase, cadera que sube y baja). Medidas de un adulto de ~1,8 m.
 */
function cuerpoProcedural(THREE) {
    const modelo = new THREE.Group(), cadera = new THREE.Group();
    cadera.position.y = 0.98;
    modelo.add(cadera);
    const pieza = (padre, geo, y, zona, x = 0) => {
        const m = new THREE.Mesh(geo, null);
        m.position.set(x, y, 0); m.userData.zona = zona; padre.add(m); return m;
    };
    const articulacion = (padre, x, y) => { const g = new THREE.Group(); g.position.set(x, y, 0); padre.add(g); return g; };
    const cap = (r, l) => new THREE.CapsuleGeometry(r, l, 6, 14);
    // Tronco: abdomen (glucógeno), pecho (corazón), cuello y cabeza (radiación)
    pieza(cadera, new THREE.SphereGeometry(0.15, 16, 12).scale(1.05, 0.7, 0.75), 0.02, SIN_ZONA);
    pieza(cadera, cap(0.13, 0.12).scale(1, 1, 0.75), 0.17, 4);
    pieza(cadera, cap(0.17, 0.2).scale(1.05, 1, 0.7), 0.42, 0);
    pieza(cadera, cap(0.045, 0.06), 0.63, 6);
    pieza(cadera, new THREE.SphereGeometry(0.105, 18, 14).scale(0.9, 1.1, 1), 0.76, 6);
    const brazos = [], piernas = [];
    for (const lado of [-1, 1]) {
        // Brazo: hombro → codo → mano
        const hombro = articulacion(cadera, 0.22 * lado, 0.55);
        pieza(hombro, cap(0.048, 0.22), -0.15, SIN_ZONA);
        const codo = articulacion(hombro, 0, -0.3);
        pieza(codo, cap(0.042, 0.2), -0.13, SIN_ZONA);
        pieza(codo, new THREE.SphereGeometry(0.05, 12, 10).scale(0.8, 1.3, 0.6), -0.3, 3);
        hombro.rotation.z = 0.08 * lado;
        brazos.push({ hombro, codo, lado });
        // Pierna: cadera → rodilla → tobillo
        const muslo = articulacion(cadera, 0.1 * lado, -0.04);
        pieza(muslo, cap(0.078, 0.3), -0.22, 1);
        const rodilla = articulacion(muslo, 0, -0.45);
        pieza(rodilla, cap(0.06, 0.32), -0.22, 2);
        const pie = pieza(rodilla, new THREE.BoxGeometry(0.09, 0.06, 0.22), -0.45, 2);
        pie.position.z = 0.05;
        piernas.push({ muslo, rodilla, lado });
    }
    const animar = t => {
        const f = t * 5.2;   // ~0,8 zancadas por segundo
        piernas.forEach(({ muslo, rodilla, lado }) => {
            const s = Math.sin(f + (lado > 0 ? Math.PI : 0));
            muslo.rotation.x = -0.42 * s;
            rodilla.rotation.x = 0.55 * Math.max(0, Math.sin(f + (lado > 0 ? Math.PI : 0) - 1.2));
        });
        brazos.forEach(({ hombro, codo, lado }) => {
            hombro.rotation.x = 0.35 * Math.sin(f + (lado > 0 ? 0 : Math.PI));
            codo.rotation.x = -0.25 - 0.15 * Math.sin(f);
        });
        cadera.position.y = 0.98 + 0.018 * Math.abs(Math.cos(f));
    };
    animar(0);
    return { modelo, animar };
}

/** Zona de un hueso por su nombre (rig humanoide de Quaternius y nombres habituales de Mixamo). */
function zonaDeHueso(nombre) {
    const n = nombre.toLowerCase();
    if (/hand|finger|thumb|index|middle|ring|pinky|wrist/.test(n)) return 3;
    if (/foot|toe|ball|calf|shin|lowerleg|lower_leg|leg_lower|knee/.test(n)) return 2;
    if (/thigh|upperleg|upper_leg|leg_upper|upleg/.test(n)) return 1;
    if (/head|neck|jaw|eye/.test(n)) return 6;
    if (/spine.?0?1|spine$|abdomen|belly|waist/.test(n)) return 4;   // abdomen: hígado y glucógeno
    if (/spine|chest|clavicle|shoulder|torso/.test(n)) return 0;
    return SIN_ZONA;
}

const VERT = /* glsl */`
    attribute float zona;
    varying float vZona;
    varying vec3 vNormal;
    varying vec3 vVista;
    varying float vAltura;
    #include <common>
    #include <skinning_pars_vertex>
    void main() {
        #include <skinbase_vertex>
        #include <beginnormal_vertex>
        #include <skinnormal_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>
        vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
        vNormal = normalize(normalMatrix * objectNormal);
        vVista = normalize(-mv.xyz);
        vAltura = (modelMatrix * vec4(transformed, 1.0)).y;
        vZona = zona;
        gl_Position = projectionMatrix * mv;
    }`;

const FRAG = /* glsl */`
    uniform vec3 uColores[8];
    uniform float uIntensidad[8];
    uniform float uTiempo;
    uniform float uAlto;
    uniform float uLinea;
    varying float vZona;
    varying vec3 vNormal;
    varying vec3 vVista;
    varying float vAltura;
    void main() {
        int z = int(vZona + 0.5);
        vec3 col = vec3(0.0); float k = 0.0;
        for (int i = 0; i < 8; i++) if (i == z) { col = uColores[i]; k = uIntensidad[i]; }
        float fresnel = pow(1.0 - abs(dot(normalize(vNormal), normalize(vVista))), 2.2);
        float h = vAltura / uAlto;
        float scan = smoothstep(0.035, 0.0, abs(fract(h - uTiempo * 0.25) - 0.5) - 0.465);   // banda que sube
        float rayas = 0.85 + 0.15 * sin(h * 260.0 + uTiempo * 4.0);
        vec3 base = vec3(${BASE.join(', ')});
        vec3 c = mix(base, col, k);
        float a = (0.05 + 0.75 * fresnel) * rayas + 0.3 * scan + 0.22 * k;
        if (uLinea > 0.5) a = 0.07 + 0.18 * k + 0.2 * scan;
        gl_FragColor = vec4(min(c * (0.75 + 0.45 * fresnel + 0.4 * scan), vec3(1.0)), clamp(a, 0.0, 0.95));
    }`;

let modulos = null;
async function cargarModulos() {
    modulos ||= Promise.all([import(THREE_URL), import(GLTF_URL)]).then(([THREE, g]) => ({ THREE, GLTFLoader: g.GLTFLoader }));
    return modulos;
}

let existe = null;
/** ¿Están los ficheros del modelo? (una petición HEAD, recordada). */
export async function hayHolograma() {
    existe ??= fetch(MODELO, { method: 'HEAD' }).then(r => r.ok).catch(() => false);
    return existe;
}

/**
 * Monta el holograma en `contenedor` (ocupa su tamaño). Devuelve { actualizar(zonas), destruir() } o null si no hay modelo.
 * `zonas`: E.zonas de estadoCuerpo (cada una con `nivel`: verde | ambar | rojo).
 */
export async function montarHolograma(contenedor) {
    const { THREE, GLTFLoader } = await cargarModulos();
    let gltf = null, anim = null, propio = null;
    if (await hayHolograma()) {
        const cargador = new GLTFLoader();
        [gltf, anim] = await Promise.all([cargador.loadAsync(MODELO), cargador.loadAsync(ANIMACIONES).catch(() => null)]);
    } else {
        propio = cuerpoProcedural(THREE);   // sin ficheros: cuerpo hecho con cápsulas y marcha por código
        gltf = { scene: propio.modelo, animations: [] };
    }

    const ancho = contenedor.clientWidth || 70, alto = contenedor.clientHeight || 130;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    renderer.setSize(ancho, alto);
    contenedor.appendChild(renderer.domElement);
    const escena = new THREE.Scene();
    const camara = new THREE.PerspectiveCamera(28, ancho / alto, 0.1, 50);

    const modelo = gltf.scene;
    const pivote = new THREE.Group();
    pivote.add(modelo);
    escena.add(pivote);
    let altoModelo = 1.8;

    const uniformesAlto = { value: 1.8 };
    const uniformes = {
        uColores: { value: Array.from({ length: 8 }, () => new THREE.Color(...BASE)) },
        uIntensidad: { value: new Array(8).fill(0) },
        uTiempo: { value: 0 }, uAlto: uniformesAlto, uLinea: { value: 0 },
    };
    const piel = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: uniformes,
        transparent: true, depthWrite: false, blending: THREE.NormalBlending, side: THREE.FrontSide });
    const lineas = piel.clone();
    lineas.uniforms = { ...uniformes, uLinea: { value: 1 } };
    lineas.wireframe = true;

    const mallas = [];
    modelo.traverse(o => { if (o.isSkinnedMesh || o.isMesh) mallas.push(o); });
    mallas.forEach(o => {
        const g = o.geometry, n = g.attributes.position.count, zona = new Float32Array(n).fill(SIN_ZONA);
        const idx = g.attributes.skinIndex, pes = g.attributes.skinWeight, huesos = o.skeleton?.bones;
        if (idx && pes && huesos) for (let v = 0; v < n; v++) {
            let mejor = 0, w = -1;
            for (let c = 0; c < 4; c++) { const p = pes.getComponent(v, c); if (p > w) { w = p; mejor = idx.getComponent(v, c); } }
            zona[v] = zonaDeHueso(huesos[mejor]?.name || '');
        }
        if (o.userData.zona != null) zona.fill(o.userData.zona);
        g.setAttribute('zona', new THREE.BufferAttribute(zona, 1));
        o.material = piel;
        o.frustumCulled = false;
        if (!o.isSkinnedMesh) {
            const malla = new THREE.Mesh(g, lineas);
            malla.frustumCulled = false;
            o.add(malla);
        } else {
            const malla = new THREE.SkinnedMesh(g, lineas);
            malla.bind(o.skeleton, o.bindMatrix);
            malla.frustumCulled = false;
            o.parent.add(malla);
        }
    });

    // Marcha en el sitio: el clip de andar (o el primero) sin avance de la cadera.
    const mezclador = new THREE.AnimationMixer(modelo);
    const clips = [...(gltf.animations || []), ...(anim?.animations || [])];
    const clip = clips.find(c => /^walk(_?loop)?$/i.test(c.name)) || clips.find(c => /walk/i.test(c.name)) || clips[0];
    if (clip) mezclador.clipAction(clip).play();   // UAL «Standard» ya anda en el sitio (la variante _RM es la que avanza)
    // Encuadre con el cuerpo ya posado (la caja de una malla con esqueleto sin posar puede salir muy distinta).
    mezclador.update(0.01); propio?.animar(0);
    modelo.updateMatrixWorld(true);
    const caja = new THREE.Box3().setFromObject(modelo, true), tam = caja.getSize(new THREE.Vector3());
    altoModelo = tam.y || 1.8;
    uniformesAlto.value = altoModelo;
    modelo.position.sub(new THREE.Vector3((caja.min.x + caja.max.x) / 2, caja.min.y, (caja.min.z + caja.max.z) / 2));
    const dist = altoModelo * 0.62 / Math.tan(THREE.MathUtils.degToRad(camara.fov / 2));
    camara.position.set(0, altoModelo * 0.5, dist);
    camara.lookAt(0, altoModelo * 0.47, 0);

    // El panel cambia de ancho (pantallas, paneles ocultos): el lienzo lo sigue.
    const ajustar = () => {
        const w = contenedor.clientWidth, h = contenedor.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h); camara.aspect = w / h; camara.updateProjectionMatrix();
    };
    const observador = new ResizeObserver(ajustar);
    observador.observe(contenedor);

    const reloj = new THREE.Clock();
    let vivo = true, cuadro = 0;
    const animar = () => {
        if (!vivo) return;
        cuadro = requestAnimationFrame(animar);
        if (!contenedor.isConnected || document.hidden) return;
        const dt = Math.min(0.05, reloj.getDelta());
        uniformes.uTiempo.value += dt;
        mezclador.update(dt);
        propio?.animar(uniformes.uTiempo.value);
        pivote.rotation.y += dt * 0.35;
        // Las zonas en rojo laten; las ámbar brillan fijas.
        const t = uniformes.uTiempo.value;
        estado.forEach((nivel, i) => { uniformes.uIntensidad.value[i] = nivel === 'rojo' ? 0.65 + 0.35 * Math.sin(t * 5) : nivel === 'ambar' ? 0.75 : nivel === 'verde' ? 0.18 : 0; });
        renderer.render(escena, camara);
    };
    const estado = new Array(8).fill(null);
    animar();

    return {
        actualizar(zonas) {
            ZONAS.forEach((z, i) => {
                const nivel = zonas?.[z]?.nivel || null;
                estado[i] = nivel;
                if (nivel) uniformes.uColores.value[i].setRGB(...COLOR[nivel]);
            });
            // El sudor no tiene un sitio: si va mal, toda la piel toma su color (salvo zonas peores).
            const agua = zonas?.agua?.nivel;
            if (agua && agua !== 'verde') { estado[SIN_ZONA] = agua; uniformes.uColores.value[SIN_ZONA].setRGB(...COLOR[agua]); }
            else estado[SIN_ZONA] = null;
        },
        destruir() {
            vivo = false; cancelAnimationFrame(cuadro); observador.disconnect();
            renderer.dispose(); piel.dispose(); lineas.dispose();
            renderer.domElement.remove();
        },
    };
}
