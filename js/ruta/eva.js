/**
 * @module eva
 * @author Hani (módulo 5: rutas y seguridad)
 * @description Modelo de la EVA: velocidad de marcha, coste metabólico, consumibles del traje,
 * dosis de radiación y perfiles de riesgo. Funciones puras que comparten el worker y la interfaz.
 *
 * Referencias (resumidas en docs/planificador_rutas.md):
 *  - Tobler (1993): velocidad de marcha en función de la pendiente.
 *  - Pandolf et al. (1977) + corrección de bajada de Santee et al. (2003): gasto metabólico con carga.
 *  - Gravedad y traje calibrados con la caminata de 10 km con traje de NASA (Norcross et al. 2008), ver CALIBRACION.
 *  - Sobrecoste del traje presurizado ≈ +25 % (Carr & Newman 2007), con rango 1,10-1,40 en la incertidumbre.
 *  - 1 L de O₂ ≈ 20,1 kJ de energía metabólica; 1 L O₂ = 1,429 g.
 *  - Dosis en superficie medida por RAD/MSL ≈ 0,64 mSv/día (Hassler et al. 2014).
 */

export const G_MARTE = 3.721;

/** Traje y astronauta por defecto (editable desde la interfaz). */
export const TRAJE_DEFECTO = {
    masaCorporal: 75,        // kg
    masaTraje: 60,           // kg (traje + PLSS de exploración)
    carga: 10,               // kg (herramientas, muestras)
    o2Kg: 1.2,               // O₂ utilizable (kg)
    bateriaWh: 2200,         // batería del PLSS (Wh)
    aguaKg: 4.0,             // agua de refrigeración por sublimación (kg)
    potenciaBaseW: 140,      // ventiladores, bombas, comunicaciones, HUD
    duracionMaxH: 7,         // límite operativo de la EVA (h)
    reserva: 0.25,           // fracción de reserva obligatoria al volver
};

/** Perfiles de planificación: límites duros y pesos del coste. */
export const PERFILES = {
    segura: {
        nombre: 'Segura', color: '#4fe3c1',
        pendienteMax: 15, rasanteMax: 12,        // grados: terreno y a lo largo de la marcha
        pesoRiesgo: 2.5, pesoRugosidad: 3.0, reserva: 0.35,
        descripcion: 'Pendiente ≤15°, reserva 35 %. Prioriza terreno llano y liso.',
    },
    equilibrada: {
        nombre: 'Equilibrada', color: '#ffb547',
        pendienteMax: 20, rasanteMax: 16,
        pesoRiesgo: 1.0, pesoRugosidad: 1.5, reserva: 0.25,
        descripcion: 'Pendiente ≤20°, reserva 25 %. Compromiso entre ciencia y margen.',
    },
    ciencia: {
        nombre: 'Máx. ciencia', color: '#ff5a7a',
        pendienteMax: 25, rasanteMax: 20,
        pesoRiesgo: 0.35, pesoRugosidad: 0.6, reserva: 0.15,
        descripcion: 'Pendiente ≤25°, reserva mínima 15 %. Visita el máximo de paradas.',
    },
    rover: { // usado solo para validar contra la traza de Perseverance
        // Pesos calibrados con la mitad de las conducciones de un sol y evaluados en la otra mitad
        // (ver docs/planificador_rutas.md): a 20 m lo que mejor reproduce al rover es el camino
        // más corto que respeta el límite de pendiente; las penalizaciones extra lo alejaban de la traza real.
        nombre: 'Rover (validación)', color: '#ffffff', esRover: true,
        pendienteMax: 20, rasanteMax: 20,
        pesoRiesgo: 0, pesoRugosidad: 0, reserva: 0,
        descripcion: 'Coste tipo rover calibrado con la traza de Perseverance.',
    },
};

/**
 * Velocidad de marcha con traje (m/s) para una rasante (dz/dx) y una rugosidad (m).
 * Tobler: 6·e^(−3,5·|g+0,05|) km/h, escalada por el traje (≈0,55 → 0,77 m/s en llano,
 * coherente con los 0,7–1 m/s medidos en las EVA del Apolo).
 */
export function velocidadMarcha(rasante, rugosidad = 0) {
    const tobler = 6 * Math.exp(-3.5 * Math.abs(rasante + 0.05)) / 3.6;
    return 0.55 * tobler / (1 + rugosidad / 0.6);
}

/**
 * Calibración con medidas de NASA (python/calibrar_metabolismo.py → data/ruta/calibracion_metabolica.json):
 * `a` se ajustó a la caminata de 10 km con traje a 1/6 g (Norcross et al. 2008); `s` es el sobrecoste del
 * traje (supuesto, 1,10-1,40). La banda es el intervalo del 90 % de la energía propagando ambas incertidumbres.
 * Validación: VO₂ de esa caminata +3 %; O₂ de esa caminata y del Apolo ±3 %.
 */
export const CALIBRACION = { a: 0.176, s: 1.25, banda: [0.903, 1.10], version: 1 };
export const G_TIERRA = 9.80665;

/**
 * Potencia metabólica (W) andando a `v` m/s con rasante `rasante` (dz/dx) en la gravedad `g` (Marte por defecto).
 * Pandolf (+Santee en bajada) con factor de terreno η según rugosidad. Sostener la carga escala con el peso
 * (g/g₀); la locomoción tiene una parte `a` que no depende del peso (balanceo de piernas). En la Tierra y sin
 * traje (`sinTraje`) es exactamente Pandolf.
 */
export function potenciaMetabolica(v, rasante, rugosidad, traje, g = G_MARTE, sinTraje = false) {
    const W = traje.masaCorporal;
    const L = traje.masaTraje + traje.carga;
    const G = rasante * 100;                         // %
    const eta = 1.2 + Math.min(1.0, rugosidad / 1.0); // regolito suelto → 1,2; bloques → hasta 2,2
    const reposo = 1.5 * W;                          // de pie, sin carga
    const carga = 2 * (W + L) * (L / W) ** 2;        // sostener la carga (escala con el peso → gravedad)
    let loco = eta * (W + L) * (1.5 * v * v + 0.35 * v * G);
    if (G < 0) {
        const cf = eta * ((G * (W + L) * v) / 3.5 - ((W + L) * (G + 6) ** 2) / W + (25 - v * v));
        loco -= cf;
    }
    const gr = g / G_TIERRA;
    const { a, s } = CALIBRACION;
    return (reposo + gr * carga + (a + (1 - a) * gr) * Math.max(0, loco)) * (sinTraje ? 1 : s);
}

/** Potencia del PLSS (W): base + calefacción según la temperatura exterior y la sombra. */
export function potenciaTraje(traje, tempC, enSombra = false) {
    const frio = Math.max(0, -20 - tempC);             // por debajo de −20 °C se calienta
    return traje.potenciaBaseW + 1.1 * frio + (enSombra ? 25 : 0);
}

/**
 * Consumos de un tramo de `dt` segundos con potencia metabólica `M` (W).
 * Devuelve kg de O₂, Wh de batería, kg de agua y mSv.
 */
export function consumoTramo(dt, M, traje, cond) {
    const o2 = (M * dt) / 20100 * 1.429e-3;                       // kg
    const bat = potenciaTraje(traje, cond.tempC ?? -50, cond.enSombra) * dt / 3600; // Wh
    const calorRechazado = Math.max(0, M * 0.8 - 90);             // W (parte se pierde por radiación)
    const agua = calorRechazado * dt / 2.45e6;                    // kg (calor latente de sublimación)
    const dosis = (cond.dosisMsvH ?? DOSIS_BASE_MSV_H) * dt / 3600;
    return { o2, bat, agua, dosis };
}

/** Dosis de radiación de fondo (GCR) en superficie a la altura de Jezero (mSv/h). */
export const DOSIS_BASE_MSV_H = 0.64 / 24.66 * 1.05; // RAD (Gale), +5 % por la menor columna de aire en Jezero

/** Fracción de cada consumible usado y el recurso que limita. */
export function fracciones(uso, traje) {
    const f = {
        o2: uso.o2 / traje.o2Kg,
        bat: uso.bat / traje.bateriaWh,
        agua: uso.agua / traje.aguaKg,
        tiempo: uso.t / (traje.duracionMaxH * 3600),
    };
    let limitante = 'o2';
    for (const k of Object.keys(f)) if (f[k] > f[limitante]) limitante = k;
    return { ...f, max: f[limitante], limitante };
}

export const NOMBRE_RECURSO = { o2: 'O₂', bat: 'Batería', agua: 'Agua', tiempo: 'Tiempo' };

/**
 * Coste de arista (s equivalentes) para el buscador. Devuelve Infinity si el paso es intransitable.
 * `d` distancia horizontal (m), `dz` desnivel (m), `pend` pendiente del terreno (°), `rug` rugosidad (m).
 */
export function costeArista(d, dz, pend, rug, peligro, perfil, traje) {
    if (pend > perfil.pendienteMax || peligro >= 1) return Infinity;
    const rasante = dz / d;
    if (Math.abs(Math.atan(rasante)) * 57.29578 > perfil.rasanteMax) return Infinity;
    const v = velocidadMarcha(rasante, rug);
    const t = Math.hypot(d, dz) / v;
    if (perfil.esRover) {
        // Rover: el tiempo importa poco; penaliza fuerte inclinación y rugosidad (riesgo de vuelco/ruedas).
        return d * (1 + perfil.pesoRiesgo * (pend / 10) ** 2 + perfil.pesoRugosidad * rug + 6 * peligro);
    }
    const M = potenciaMetabolica(v, rasante, rug, traje);
    // Coste = tiempo · (1 + esfuerzo relativo) · (1 + riesgo). El riesgo crece rápido al acercarse al límite.
    const esfuerzo = M / 400;
    const riesgo = perfil.pesoRiesgo * (pend / perfil.pendienteMax) ** 4 + perfil.pesoRugosidad * rug + 4 * peligro;
    return t * (0.5 + 0.5 * esfuerzo) * (1 + riesgo);
}

// ───────────────────────── el cuerpo de quien camina ─────────────────────────

/** Consumo de oxígeno (mL/kg/min) para una potencia metabólica M (W): 1 L de O₂ ≈ 20,1 kJ. */
export function vo2(M, masaCorporal) { return M * 60 / 20.1 / masaCorporal; }

/**
 * VO₂máx estimado (mL/kg/min) con el test de ida y vuelta de 20 m (Léger et al. 1988):
 * velocidad final X = 8 + 0,5·etapa (km/h); Y = 31,025 + 3,238X − 3,248A + 0,1536AX. En adultos, A = 18.
 * Es una estimación de campo (r ≈ 0,7 en niños, 0,9 en adultos), no una medida de laboratorio.
 */
export function vo2maxLeger(etapa, edad) {
    const X = 8 + 0.5 * etapa, A = Math.min(Math.max(edad, 6), 18);
    return 31.025 + 3.238 * X - 3.248 * A + 0.1536 * A * X;
}

/** Valores de referencia medidos (fuente en cada uno) para leer el esfuerzo de una ruta. */
export const REFERENCIAS_CUERPO = {
    caminata10kmPct: 50.8,       // % del VO₂pico en la caminata de 10 km con traje (Norcross et al. 2008), esfuerzo percibido 11,8 («ligero»)
    sudorW: 464,                 // supresión del sudor en el traje del Apolo, 1670 kJ/h (Waligora & Horrigan 1975)
    refrigeracionW: 581,         // refrigeración sostenida del traje del Apolo, 2090 kJ/h (Waligora & Horrigan 1975)
    bebidaL: 1.0,                // bolsa de bebida del Apolo, 1 L (Waligora & Horrigan 1975)
    trabajoParadaW: 280,         // trabajo de campo en una parada; medias de EVA del Apolo 200-250 kcal/h
    kcalPlatano: 105,            // un plátano mediano (USDA FoodData Central)
};

/** Kilómetros andando en la Tierra (5 km/h, sin carga) que cuestan la misma energía que `kJ`. */
export function kmTierraEquivalentes(kJ, masaCorporal) {
    const v = 5 / 3.6;
    const M = 1.5 * masaCorporal + masaCorporal * 1.5 * v * v;   // Pandolf en la Tierra, sin carga, asfalto (η = 1)
    return kJ * 1000 / M * v / 1000;
}

/** VO₂pico medio de los sujetos de la caminata de 10 km con traje (Norcross et al. 2008): referencia sin test. */
export const VO2MAX_REFERENCIA = 48.7;
export const AVISO_MEDICO = 'Estimación de un modelo calibrado con datos de NASA. No es una evaluación médica.';

/**
 * «¿Puedo hacer esta ruta?»: lo que una ruta planificada le pide al cuerpo de quien la camina.
 * Única fuente de las cifras para la tarjeta, el texto y la voz (no se recalcula en otro sitio).
 * @param {object} ruta  plan del planificador (muestras con met, dtm, ener, o2; paradas con trabajoS)
 * @param {{edad:number, etapa:number|null}} persona  etapa del test de ida y vuelta de 20 m (null = sin test)
 * @param {object} traje  masaCorporal (kg) y o2Kg (kg de O₂ del traje)
 */
export function respuestaCuerpo(ruta, persona, traje) {
    const s = ruta.muestras, n = s.t.length - 1, masa = traje.masaCorporal;
    const conTest = !!persona.etapa;
    const vo2max = conTest ? vo2maxLeger(persona.etapa, persona.edad) : VO2MAX_REFERENCIA;
    const tramos = [];   // [potencia W, segundos]: andando y trabajando en las paradas
    for (let k = 1; k <= n; k++) if (s.dtm[k] > 0) tramos.push([s.met[k], s.dtm[k]]);
    for (const p of ruta.paradas || []) if (p.trabajoS > 0) tramos.push([REFERENCIAS_CUERPO.trabajoParadaW, p.trabajoS]);
    const T = tramos.reduce((a, [, dt]) => a + dt, 0) || 1;
    const pctDe = M => 100 * vo2(M, masa) / vo2max;
    const minutos = cond => tramos.reduce((a, [M, dt]) => a + (cond(M) ? dt : 0), 0) / 60;
    const orden = [...tramos].sort((a, b) => b[0] - a[0]);
    let acc = 0, pico = orden[0]?.[0] || 0;
    for (const [M, dt] of orden) { acc += dt; pico = M; if (acc >= 60) break; }   // pico sostenido ≥ 1 min
    const kJ = s.ener[n], kcal = kJ / 4.184;
    const media = tramos.reduce((a, [M, dt]) => a + pctDe(M) * dt, 0) / T;
    const minMuyDuro = minutos(M => pctDe(M) > 70);
    const nivel = media <= 50 && minMuyDuro < 5 ? 'asumible' : media <= 60 ? 'exigente' : 'demasiado';
    const r0 = x => Math.round(x);
    const quien = conTest ? 'tu capacidad' : 'la capacidad de un astronauta de referencia';
    const texto = {
        asumible: `Asumible: de media, un ${r0(media)} % de ${quien}; en la caminata de 10 km con traje de NASA se sostuvo un 51 % y se percibió como ligera.`,
        exigente: `Exigente: de media, un ${r0(media)} % de ${quien}, con ${r0(minMuyDuro)} min por encima del 70 %. La ruta «Segura» o pausas en las subidas lo bajan.`,
        demasiado: `Demasiado exigente: de media, un ${r0(media)} % de ${quien}, por encima de lo que se sostuvo en la prueba de NASA (51 %). Elige una ruta más corta o más llana.`,
    }[nivel];
    const rango = CALIBRACION.banda.map(f => r0(kcal * f));
    const voz = `${{ asumible: 'Sí, es asumible', exigente: 'Sí, pero es exigente', demasiado: 'No te la recomiendo' }[nivel]}. ` +
        `De media pide un ${r0(media)} por ciento de ${quien}, con picos del ${r0(pctDe(pico))}. ` +
        `Gastarás entre ${rango[0]} y ${rango[1]} kilocalorías y ${(s.o2[n] * traje.o2Kg).toFixed(1).replace('.', ',')} kilos de oxígeno. Es una estimación, no una evaluación médica.`;
    return {
        disponible: true, nivel, texto, voz, aviso: AVISO_MEDICO,
        conTest, vo2max, mediaPct: media, picoPct: pctDe(pico),
        minDuro: minutos(M => pctDe(M) > 50), minMuyDuro,
        minSudor: minutos(M => M > REFERENCIAS_CUERPO.sudorW), minRefrig: minutos(M => M > REFERENCIAS_CUERPO.refrigeracionW),
        kcal, kcalRango: rango, kmTierra: kmTierraEquivalentes(kJ, masa),
        o2Kg: s.o2[n] * traje.o2Kg, bebidaL: REFERENCIAS_CUERPO.bebidaL, horas: s.t[n] / 3600,
        fuentes: {
            energia: 'Pandolf (1977) + Santee (2003), calibrado con la caminata de 10 km con traje de NASA (Norcross et al. 2008); rango del 90 %',
            capacidad: conTest ? 'Test de ida y vuelta de 20 m (Léger et al. 1988)' : 'VO₂pico medio de los sujetos de NASA, 48,7 mL/kg/min (Norcross et al. 2008)',
            umbrales: 'Sudor y refrigeración del traje del Apolo (Waligora & Horrigan 1975)',
        },
    };
}
