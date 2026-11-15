/**
 * @module espacio
 * @description Cielo profundo animado para la vista de globo: estrellas en tres planos con paralaje (se desplazan al
 * girar el planeta), centelleo, estrellas brillantes que laten con destellos en cruz, estrellas fugaces, un cometa de
 * paso de vez en cuando y unos pocos asteroides que derivan girando. Es un lienzo 2D detrás del mapa: el propio globo
 * tapa lo que pasa por detrás.
 *
 * Solo trabaja mientras la vista de globo está activa (y la pestaña visible). Las estrellas de fondo se pintan una vez
 * en lienzos auxiliares; en cada fotograma solo se dibujan esos lienzos desplazados y los pocos elementos que cambian.
 * Con «reducir movimiento» queda el cielo estrellado quieto.
 */

const quieto = matchMedia('(prefers-reduced-motion: reduce)').matches;

function aleatorio(semilla) {  // mulberry32: el mismo cielo en todos los equipos
    let a = semilla >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Color de una estrella según su «temperatura»: de azulada a anaranjada, la mayoría casi blancas. */
function colorEstrella(r) {
    const t = r();
    if (t < 0.12) return [170, 196, 255];
    if (t < 0.22) return [255, 214, 170];
    if (t < 0.27) return [255, 180, 140];
    return [235, 240, 255];
}

/** Plano de estrellas repetible (lado L): se pinta una vez. */
function planoEstrellas(L, n, tamMax, semilla) {
    const c = document.createElement('canvas'); c.width = c.height = L;
    const g = c.getContext('2d'), r = aleatorio(semilla);
    for (let i = 0; i < n; i++) {
        const x = r() * L, y = r() * L, t = r(), rad = 0.35 + t * t * tamMax, [cr, cg, cb] = colorEstrella(r), a = 0.35 + r() * 0.6;
        for (const dx of [-L, 0, L]) for (const dy of [-L, 0, L]) {   // repetida en los bordes: el plano casa consigo mismo
            if (x + dx < -4 || x + dx > L + 4 || y + dy < -4 || y + dy > L + 4) continue;
            g.fillStyle = `rgba(${cr},${cg},${cb},${a})`;
            g.beginPath(); g.arc(x + dx, y + dy, rad, 0, 7); g.fill();
            if (rad > 1.1) { g.fillStyle = `rgba(${cr},${cg},${cb},${a * 0.16})`; g.beginPath(); g.arc(x + dx, y + dy, rad * 2.6, 0, 7); g.fill(); }
        }
    }
    return c;
}

export function initEspacio(despuesDe) {
    const lienzo = document.createElement('canvas');
    lienzo.id = 'space-fx'; lienzo.setAttribute('aria-hidden', 'true');
    despuesDe.after(lienzo);
    const g = lienzo.getContext('2d');
    const L = 1024;
    const planos = [
        { c: planoEstrellas(L, 900, 0.9, 11), k: 0.35, a: 0.75 },   // lejano: muchas y tenues, se mueve poco
        { c: planoEstrellas(L, 320, 1.5, 23), k: 0.7, a: 0.9 },
        { c: planoEstrellas(L, 90, 2.1, 37), k: 1.15, a: 1 },       // cercano
    ];
    const r = aleatorio(101);
    // Estrellas que centellean (y las más brillantes, que laten con un destello en cruz)
    const vivas = Array.from({ length: 150 }, (_, i) => ({ x: r(), y: r(), tam: i < 14 ? 1.6 + r() * 1.5 : 0.7 + r() * 0.9, col: colorEstrella(r),
        vel: 0.6 + r() * 2.4, fase: r() * 6.28, cruz: i < 14, k: 0.5 + r() * 0.7 }));
    // Asteroides: polígonos irregulares que giran despacio
    const asteroides = Array.from({ length: 5 }, () => {
        const n = 7 + Math.floor(r() * 4);
        return { x: r(), y: r(), vx: (r() - 0.5) * 0.006, vy: (r() - 0.5) * 0.004, giro: r() * 6.28, w: (r() - 0.5) * 0.5, tam: 5 + r() * 9,
            pts: Array.from({ length: n }, (_, i) => { const a = i / n * 6.283, d = 0.62 + r() * 0.5; return [Math.cos(a) * d, Math.sin(a) * d * (0.7 + r() * 0.3)]; }), tono: 70 + r() * 50 };
    });
    let fugaces = [], cometa = null, activo = false, raf = 0, ant = 0, sigFugaz = 1.5, sigCometa = 6, despX = 0, despY = 0, W = 0, H = 0, dpr = 1;

    const medir = () => {
        dpr = Math.min(devicePixelRatio || 1, 1.5);
        W = innerWidth; H = innerHeight;
        lienzo.width = Math.round(W * dpr); lienzo.height = Math.round(H * dpr);
    };
    addEventListener('resize', () => { if (activo) { medir(); if (quieto) dibujar(0, 0); } });

    const nuevaFugaz = () => {
        const ang = (20 + r() * 35) * Math.PI / 180 * (r() < 0.5 ? 1 : -1) + (r() < 0.5 ? 0 : Math.PI), vel = 900 + r() * 900;
        fugaces.push({ x: r() * W, y: r() * H * 0.7, vx: Math.cos(ang) * vel, vy: Math.abs(Math.sin(ang)) * vel, vida: 0, dur: 0.45 + r() * 0.5, largo: 120 + r() * 160, brillo: 0.6 + r() * 0.4 });
    };
    const nuevoCometa = () => {
        const izq = r() < 0.5, y0 = H * (0.08 + r() * 0.5);
        cometa = { x: izq ? -80 : W + 80, y: y0, vx: (izq ? 1 : -1) * (W + 160) / (16 + r() * 8), vy: H * (0.012 + r() * 0.018), t: 0 };
    };

    function dibujar(t, dt) {
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, W, H);
        // Planos de estrellas con paralaje
        for (const p of planos) {
            const ox = ((despX * p.k) % L + L) % L, oy = ((despY * p.k) % L + L) % L;
            g.globalAlpha = p.a;
            for (let x = -ox; x < W; x += L) for (let y = -oy; y < H; y += L) g.drawImage(p.c, x, y);
        }
        g.globalAlpha = 1;
        // Centelleo y latidos
        for (const s of vivas) {
            const x = (((s.x * W * 1.4 - despX * s.k) % (W * 1.4)) + W * 1.4) % (W * 1.4) - W * 0.2, y = (((s.y * H * 1.4 - despY * s.k) % (H * 1.4)) + H * 1.4) % (H * 1.4) - H * 0.2;
            if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
            const pulso = 0.5 + 0.5 * Math.sin(t * s.vel + s.fase), a = 0.25 + 0.75 * pulso * pulso, [cr, cg, cb] = s.col;
            g.fillStyle = `rgba(${cr},${cg},${cb},${a})`;
            g.beginPath(); g.arc(x, y, s.tam * (0.8 + 0.3 * pulso), 0, 7); g.fill();
            if (s.cruz) {
                const halo = g.createRadialGradient(x, y, 0, x, y, s.tam * 7);
                halo.addColorStop(0, `rgba(${cr},${cg},${cb},${0.35 * a})`); halo.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
                g.fillStyle = halo; g.beginPath(); g.arc(x, y, s.tam * 7, 0, 7); g.fill();
                const largo = s.tam * (5 + 9 * pulso);
                g.strokeStyle = `rgba(${cr},${cg},${cb},${0.55 * a})`; g.lineWidth = 0.8;
                g.beginPath(); g.moveTo(x - largo, y); g.lineTo(x + largo, y); g.moveTo(x, y - largo); g.lineTo(x, y + largo); g.stroke();
            }
        }
        // Asteroides
        for (const a of asteroides) {
            a.x = (a.x + a.vx * dt + 1.2) % 1.2; a.y = (a.y + a.vy * dt + 1.2) % 1.2; a.giro += a.w * dt;
            const x = (((a.x * W - despX * 1.6) % (W * 1.2)) + W * 1.2) % (W * 1.2) - W * 0.1, y = (((a.y * H - despY * 1.6) % (H * 1.2)) + H * 1.2) % (H * 1.2) - H * 0.1;
            g.save(); g.translate(x, y); g.rotate(a.giro);
            g.beginPath(); a.pts.forEach(([px, py], i) => (i ? g.lineTo(px * a.tam, py * a.tam) : g.moveTo(px * a.tam, py * a.tam))); g.closePath();
            g.rotate(-a.giro);                                                   // la luz viene siempre del mismo lado
            const luz = g.createLinearGradient(-a.tam, -a.tam, a.tam, a.tam);
            luz.addColorStop(0, `rgb(${a.tono + 70},${a.tono + 55},${a.tono + 40})`); luz.addColorStop(0.55, `rgb(${a.tono},${a.tono - 10},${a.tono - 18})`); luz.addColorStop(1, 'rgb(14,12,14)');
            g.fillStyle = luz; g.fill();
            g.restore();
        }
        // Cometa: cabeza brillante, cola de polvo (clara, ancha) y cola de iones (azulada, recta)
        if (cometa) {
            const c = cometa; c.t += dt; c.x += c.vx * dt; c.y += c.vy * dt;
            const dir = Math.atan2(c.vy, c.vx), entra = Math.min(1, c.t / 1.5);
            for (const [largo, ancho, color, desv] of [[260, 26, '160,200,255', 0.0], [190, 44, '255,236,200', 0.22]]) {
                g.save(); g.translate(c.x, c.y); g.rotate(dir + Math.PI + desv * Math.sign(c.vx));
                const cola = g.createLinearGradient(0, 0, largo, 0);
                cola.addColorStop(0, `rgba(${color},${0.5 * entra})`); cola.addColorStop(0.3, `rgba(${color},${0.16 * entra})`); cola.addColorStop(1, `rgba(${color},0)`);
                g.fillStyle = cola; g.beginPath(); g.moveTo(0, -3); g.quadraticCurveTo(largo * 0.5, -ancho * 0.5, largo, -ancho * 0.25); g.lineTo(largo, ancho * 0.25); g.quadraticCurveTo(largo * 0.5, ancho * 0.5, 0, 3); g.closePath(); g.fill();
                g.restore();
            }
            const cabeza = g.createRadialGradient(c.x, c.y, 0, c.x, c.y, 16);
            cabeza.addColorStop(0, `rgba(255,255,255,${entra})`); cabeza.addColorStop(0.25, `rgba(200,230,255,${0.7 * entra})`); cabeza.addColorStop(1, 'rgba(160,200,255,0)');
            g.fillStyle = cabeza; g.beginPath(); g.arc(c.x, c.y, 16, 0, 7); g.fill();
            if (c.x < -400 || c.x > W + 400 || c.y > H + 300) cometa = null;
        }
        // Estrellas fugaces
        for (const f of fugaces) {
            f.vida += dt; f.x += f.vx * dt; f.y += f.vy * dt;
            const k = f.vida / f.dur, a = Math.sin(Math.min(1, k) * Math.PI) * f.brillo, v = Math.hypot(f.vx, f.vy), ux = f.vx / v, uy = f.vy / v;
            const rastro = g.createLinearGradient(f.x, f.y, f.x - ux * f.largo, f.y - uy * f.largo);
            rastro.addColorStop(0, `rgba(255,255,255,${a})`); rastro.addColorStop(0.2, `rgba(200,225,255,${a * 0.55})`); rastro.addColorStop(1, 'rgba(160,200,255,0)');
            g.strokeStyle = rastro; g.lineWidth = 1.8; g.lineCap = 'round';
            g.beginPath(); g.moveTo(f.x, f.y); g.lineTo(f.x - ux * f.largo, f.y - uy * f.largo); g.stroke();
            g.fillStyle = `rgba(255,255,255,${a})`; g.beginPath(); g.arc(f.x, f.y, 1.6, 0, 7); g.fill();
        }
        fugaces = fugaces.filter(f => f.vida < f.dur);
    }

    const paso = ts => {
        raf = activo ? requestAnimationFrame(paso) : 0;
        if (document.hidden) { ant = 0; return; }
        const dt = ant ? Math.min(0.1, (ts - ant) / 1000) : 0.016; ant = ts;
        const t = ts / 1000;
        if ((sigFugaz -= dt) <= 0) { nuevaFugaz(); if (Math.random() < 0.18) nuevaFugaz(); sigFugaz = 1.8 + Math.random() * 4.5; }
        if (!cometa && (sigCometa -= dt) <= 0) { nuevoCometa(); sigCometa = 28 + Math.random() * 30; }
        dibujar(t, dt);
    };

    return {
        /** Enciende o apaga el cielo animado (con la vista de globo). */
        activar(v) {
            if (v === activo) return;
            activo = v;
            lienzo.classList.toggle('visible', v);
            if (!v) { cancelAnimationFrame(raf); raf = 0; return; }
            medir(); ant = 0; fugaces = []; cometa = null; sigFugaz = 1.2; sigCometa = 5;
            if (quieto) dibujar(0, 0); else raf = requestAnimationFrame(paso);
        },
        /** Paralaje: desplazamiento acumulado del planeta (grados de giro y de inclinación). */
        mover(giro, inclinacion) { despX = giro * 6; despY = -inclinacion * 6; if (activo && quieto) dibujar(0, 0); },
    };
}
