/*
 * ruta_kernel.c — núcleo de búsqueda del planificador EVA (módulo 5, Hani), compilado a WebAssembly.
 *
 * Reproduce exactamente el modelo de js/ruta/busqueda.js: las tablas de coste (tiempo, potencia y coste
 * base por metro en función de rasante y rugosidad) y las distancias por fila se calculan en JS y se
 * copian aquí, de modo que ambos caminos dan los mismos números y JS sirve de respaldo.
 *
 * Sin libc: memoria con un asignador de pila (bump) + marcas para liberar el espacio temporal.
 * Compilar:  wasm/build.sh   (clang --target=wasm32, wasm-ld, wasm-opt)
 */
#include <stdint.h>
#include <stddef.h>

#define EXPORT(name) __attribute__((export_name(name)))
#define INF (__builtin_inf())

/* ───────────── memoria ───────────── */
extern unsigned char __heap_base;
static uintptr_t cima = 0;

static void *reservar_(uint32_t bytes) {
    if (!cima) cima = (uintptr_t)&__heap_base;
    uintptr_t p = (cima + 15) & ~(uintptr_t)15;
    uintptr_t fin = p + bytes;
    uintptr_t tam = __builtin_wasm_memory_size(0) * 65536u;
    if (fin > tam) {
        uint32_t paginas = (uint32_t)((fin - tam + 65535) / 65536);
        if (__builtin_wasm_memory_grow(0, paginas) == (size_t)-1) return 0;
    }
    cima = fin;
    return (void *)p;
}
EXPORT("reservar") uint32_t reservar(uint32_t bytes) { return (uint32_t)(uintptr_t)reservar_(bytes); }
EXPORT("marca") uint32_t marca(void) { if (!cima) cima = (uintptr_t)&__heap_base; return (uint32_t)cima; }
EXPORT("liberar") void liberar(uint32_t m) { cima = m; }

static void copiar(void *d, const void *s, uint32_t n) {
    unsigned char *a = d; const unsigned char *b = s;
    while (n--) *a++ = *b++;
}

/* ───────────── movimientos (16 directos + 16 inversos) ───────────── */
static const int8_t MOV[16][6] = {
    {1, 0}, {-1, 0}, {0, 1}, {0, -1},
    {1, 1}, {1, -1}, {-1, 1}, {-1, -1},
    {1, 2, 0, 1, 1, 1}, {-1, 2, 0, 1, -1, 1}, {1, -2, 0, -1, 1, -1}, {-1, -2, 0, -1, -1, -1},
    {2, 1, 1, 0, 1, 1}, {2, -1, 1, 0, 1, -1}, {-2, 1, -1, 0, -1, 1}, {-2, -1, -1, 0, -1, -1},
};
static int8_t DI[32], DJ[32], CAB[32], MI[32][4];
static int movs_listos = 0;
static void preparar_movs(void) {
    if (movs_listos) return;
    for (int k = 0; k < 16; k++) {
        const int8_t *m = MOV[k];
        int cab = (m[0] == 2 || m[0] == -2 || m[1] == 2 || m[1] == -2);
        DI[k] = m[0]; DJ[k] = m[1]; CAB[k] = cab;
        DI[k + 16] = -m[0]; DJ[k + 16] = -m[1]; CAB[k + 16] = cab;
        if (cab) {
            MI[k][0] = m[2]; MI[k][1] = m[3]; MI[k][2] = m[4]; MI[k][3] = m[5];
            MI[k + 16][0] = m[2] - m[0]; MI[k + 16][1] = m[3] - m[1];
            MI[k + 16][2] = m[4] - m[0]; MI[k + 16][3] = m[5] - m[1];
        }
    }
    movs_listos = 1;
}

/* ───────────── rejilla y evaluador ───────────── */
/* Elevación, pendiente, rugosidad y peligro juntos (16 B): la evaluación de una arista toca
 * 2-4 celdas; con arrays separados serían 8-16 líneas de caché distintas, aquí 2-4. */
typedef struct { float elev, pend, rug, pel; } Celda;

typedef struct {
    int W, H;
    float *elev, *pend, *rug, *pel, *dTab; /* dTab: H × 32 */
    Celda *c;                              /* atributos intercalados: 1 línea de caché por celda vecina */
    float dxm, dy;
    /* estado persistente de A* */
    double *coste; int32_t *padre, *sello, *cerrado; int32_t gen;
} Rejilla;

typedef struct {
    Rejilla *g;
    int esRover, NR, NU, filas;
    float pMax, invPMax, rasMax, pesoR, pesoU, PRinv, PUinv;
    float *tabT, *tabM, *tabC;
    int32_t OFF[32], OFF1[32], OFF2[32];
} Evaluador;

EXPORT("rejilla_crear")
uint32_t rejilla_crear(int W, int H, float dxm, float dy, float *elev, float *pend, float *rug, float *pel, float *dTab) {
    preparar_movs();
    Rejilla *g = reservar_(sizeof(Rejilla));
    g->W = W; g->H = H; g->dxm = dxm; g->dy = dy;
    g->elev = elev; g->pend = pend; g->rug = rug; g->pel = pel; g->dTab = dTab;
    uint32_t n = (uint32_t)W * (uint32_t)H;
    g->c = reservar_(n * sizeof(Celda));
    for (uint32_t i = 0; i < n; i++) { g->c[i].elev = elev[i]; g->c[i].pend = pend[i]; g->c[i].rug = rug[i]; g->c[i].pel = pel[i]; }
    g->coste = reservar_(n * 8); g->padre = reservar_(n * 4);
    g->sello = reservar_(n * 4); g->cerrado = reservar_(n * 4);
    for (uint32_t i = 0; i < n; i++) { g->sello[i] = 0; g->cerrado[i] = 0; }
    g->gen = 0;
    return (uint32_t)(uintptr_t)g;
}

/* Tras cambiar las zonas prohibidas (array `pel`), refresca la copia intercalada. */
EXPORT("rejilla_sync")
void rejilla_sync(Rejilla *g) {
    uint32_t n = (uint32_t)g->W * (uint32_t)g->H;
    for (uint32_t i = 0; i < n; i++) g->c[i].pel = g->pel[i];
}

EXPORT("evaluador_crear")
uint32_t evaluador_crear(Rejilla *g, int esRover, float pMax, float rasMax, float pesoR, float pesoU,
                         int NR, float PR, int NU, float PU, float *tabT, float *tabM, float *tabC) {
    Evaluador *e = reservar_(sizeof(Evaluador));
    e->g = g; e->esRover = esRover; e->pMax = pMax; e->invPMax = 1.0f / pMax; e->rasMax = rasMax;
    e->pesoR = pesoR; e->pesoU = pesoU; e->NR = NR; e->NU = NU; e->filas = 2 * NR + 1;
    e->PRinv = 1.0f / PR; e->PUinv = 1.0f / PU;
    e->tabT = tabT; e->tabM = tabM; e->tabC = tabC;
    for (int k = 0; k < 32; k++) {
        e->OFF[k] = DJ[k] * g->W + DI[k];
        e->OFF1[k] = CAB[k] ? MI[k][1] * g->W + MI[k][0] : 0;
        e->OFF2[k] = CAB[k] ? MI[k][3] * g->W + MI[k][2] : 0;
    }
    return (uint32_t)(uintptr_t)e;
}

/* Coste de la arista k desde a (fila j). Escribe tiempo y potencia; INF si es intransitable. */
static inline double arista(const Evaluador *e, int32_t a, int k, int j, float *t_out, float *M_out) {
    const Rejilla *g = e->g;
    const Celda *A = &g->c[a], *Bc = &g->c[a + e->OFF[k]];
    float p = A->pend, r = A->rug, h = A->pel;
    if (Bc->pend > p) p = Bc->pend;
    if (Bc->rug > r) r = Bc->rug;
    if (Bc->pel > h) h = Bc->pel;
    if (CAB[k]) {
        const Celda *C1 = &g->c[a + e->OFF1[k]], *C2 = &g->c[a + e->OFF2[k]];
        if (C1->pend > p) p = C1->pend; if (C2->pend > p) p = C2->pend;
        if (C1->rug > r) r = C1->rug; if (C2->rug > r) r = C2->rug;
        if (C1->pel > h) h = C1->pel; if (C2->pel > h) h = C2->pel;
    }
    if (!(p <= e->pMax) || h >= 1.0f) return INF;
    float d = g->dTab[j * 32 + k];
    float ras = (Bc->elev - A->elev) / d;
    if (ras > e->rasMax || ras < -e->rasMax) return INF;
    int ia = ras >= 0 ? (int)(ras * e->PRinv + 0.5f) + e->NR : e->NR - (int)(-ras * e->PRinv + 0.5f);
    if (ia < 0) ia = 0; else if (ia >= e->filas) ia = e->filas - 1;
    int iu = (int)(r * e->PUinv + 0.5f); if (iu >= e->NU) iu = e->NU - 1;
    int ti = ia * e->NU + iu;
    *t_out = d * e->tabT[ti];
    if (e->esRover) {
        *M_out = 0;
        float q = p * 0.1f;
        return (double)d * (1.0 + e->pesoR * q * q + e->pesoU * r + 6.0 * h);
    }
    *M_out = e->tabM[ti];
    float q = p * e->invPMax, q2 = q * q;
    return (double)d * e->tabC[ti] * (1.0 + e->pesoR * q2 * q2 + e->pesoU * r + 4.0 * h);
}

/* ───────────── montículo binario (borrado perezoso) ───────────── */
typedef struct { double *k; int32_t *v; uint32_t n, cap; } Monticulo;

static int mont_init(Monticulo *m, uint32_t cap) {
    m->k = reservar_(cap * 8); m->v = reservar_(cap * 4); m->n = 0; m->cap = cap;
    return m->k && m->v;
}
/* Montículo 4-ario: mitad de profundidad que el binario y los 4 hijos contiguos en memoria. */
static int mont_push(Monticulo *m, double key, int32_t val) {
    if (m->n == m->cap) { /* crece en el espacio temporal; lo viejo se libera con la marca */
        uint32_t cap = m->cap * 2;
        double *k = reservar_(cap * 8); int32_t *v = reservar_(cap * 4);
        if (!k || !v) return 0;
        copiar(k, m->k, m->n * 8); copiar(v, m->v, m->n * 4);
        m->k = k; m->v = v; m->cap = cap;
    }
    uint32_t i = m->n++;
    double *K = m->k; int32_t *V = m->v;
    while (i > 0) {
        uint32_t p = (i - 1) >> 2;
        if (K[p] <= key) break;
        K[i] = K[p]; V[i] = V[p]; i = p;
    }
    K[i] = key; V[i] = val;
    return 1;
}
static int32_t mont_pop(Monticulo *m) {
    double *K = m->k; int32_t *V = m->v;
    int32_t top = V[0];
    uint32_t n = --m->n;
    double key = K[n]; int32_t val = V[n];
    uint32_t i = 0;
    for (;;) {
        uint32_t c = 4 * i + 1;
        if (c >= n) break;
        uint32_t best = c; double bk = K[c];
        uint32_t fin = c + 4 < n ? c + 4 : n;
        for (uint32_t q = c + 1; q < fin; q++) if (K[q] < bk) { bk = K[q]; best = q; }
        if (bk >= key) break;
        K[i] = bk; V[i] = V[best]; i = best;
    }
    K[i] = key; V[i] = val;
    return top;
}

/* ───────────── Dijkstra (campo completo, acotado por radio u objetivos) ───────────── */
/* Salidas (n celdas, reservadas por el llamador): coste f64, T/E/Q f32, padre i32. Devuelve nodos cerrados. */
EXPORT("dijkstra")
int32_t dijkstra(Evaluador *e, int32_t fuente, int inverso, double radioM, int32_t *objetivos, int nObj,
                 double *coste, float *T, float *E, float *Q, int32_t *padre) {
    Rejilla *g = e->g;
    const int W = g->W, H = g->H;
    const uint32_t n = (uint32_t)W * (uint32_t)H;
    uint32_t m0 = marca();
    uint8_t *cerrado = reservar_(n);
    uint8_t *obj = nObj ? reservar_(n) : 0;
    for (uint32_t i = 0; i < n; i++) { coste[i] = INF; T[i] = 0; E[i] = 0; Q[i] = 0; padre[i] = -1; cerrado[i] = 0; }
    int pendientes = 0;
    if (obj) {
        for (uint32_t i = 0; i < n; i++) obj[i] = 0;
        for (int i = 0; i < nObj; i++) if (objetivos[i] >= 0 && !obj[objetivos[i]]) { obj[objetivos[i]] = 1; pendientes++; }
    }
    Monticulo heap;
    if (!mont_init(&heap, 1u << 18)) { liberar(m0); return -1; }
    coste[fuente] = 0;
    mont_push(&heap, 0, fuente);
    const int fj0 = fuente / W, fi0 = fuente - fj0 * W;
    const double dxm = g->dxm, dy = g->dy, r2 = radioM * radioM;
    const int podar = radioM < 1e300;
    const int kInv = inverso ? 16 : 0;
    int32_t cerrados = 0;
    float t, M;
    while (heap.n) {
        int32_t u = mont_pop(&heap);
        if (cerrado[u]) continue;
        cerrado[u] = 1; cerrados++;
        if (obj && obj[u] && --pendientes == 0) break;
        const int uj = u / W, ui = u - uj * W;
        const double cu = coste[u];
        for (int k = 0; k < 16; k++) {
            const int vi = ui + DI[k], vj = uj + DJ[k];
            if (vi < 0 || vj < 0 || vi >= W || vj >= H) continue;
            if (podar) { double x = (vi - fi0) * dxm, y = (vj - fj0) * dy; if (x * x + y * y > r2) continue; }
            const int32_t v = vj * W + vi;
            if (cerrado[v]) continue;
            const double c = inverso ? arista(e, v, k + kInv, vj, &t, &M) : arista(e, u, k, uj, &t, &M);
            if (c == INF) continue;
            const double nc = cu + c;
            if (nc < coste[v]) {
                coste[v] = nc; padre[v] = u;
                T[v] = T[u] + t; E[v] = E[u] + M * t;
                const float calor = 0.8f * M - 90.0f;
                Q[v] = calor > 0 ? Q[u] + calor * t : Q[u];
                if (!mont_push(&heap, nc, v)) { liberar(m0); return -1; }
            }
        }
    }
    liberar(m0);
    return cerrados;
}

/* ───────────── A* con heurística ALT ───────────── */
/*
 * h(v) = máx(dist·cmin, vc[v] − vc[fin], ic[fin] − ic[v])  (cotas por desigualdad triangular con la base).
 * Escribe el camino (de fin a ini) en `camino` y devuelve su longitud (0 si no hay). info[0]=coste, info[1]=expandidos.
 */
EXPORT("aestrella")
int32_t aestrella(Evaluador *e, int32_t ini, int32_t fin, float cmin, double *ic, double *vc,
                  int32_t *camino, int32_t maxCamino, double *info) {
    Rejilla *g = e->g;
    const int W = g->W, H = g->H;
    double *coste = g->coste; int32_t *padre = g->padre, *sello = g->sello, *cerrado = g->cerrado;
    const int32_t gen = ++g->gen;
    uint32_t m0 = marca();
    Monticulo heap;
    if (!mont_init(&heap, 1u << 14)) return 0;
    const int fj = fin / W, fi = fin - fj * W;
    const double dxm = g->dxm, dy = g->dy;
    const double it = ic ? ic[fin] : INF, vt = vc ? vc[fin] : INF;
    const int usaI = it != INF, usaV = vt != INF;
    coste[ini] = 0; padre[ini] = -1; sello[ini] = gen;
    mont_push(&heap, 0, ini);
    int ok = 0; double expandidos = 0;
    float t, M;
    while (heap.n) {
        int32_t u = mont_pop(&heap);
        if (cerrado[u] == gen) continue;
        cerrado[u] = gen; expandidos++;
        if (u == fin) { ok = 1; break; }
        const int uj = u / W, ui = u - uj * W;
        const double cu = coste[u];
        for (int k = 0; k < 16; k++) {
            const int vi = ui + DI[k], vj = uj + DJ[k];
            if (vi < 0 || vj < 0 || vi >= W || vj >= H) continue;
            const int32_t v = vj * W + vi;
            if (cerrado[v] == gen) continue;
            const double c = arista(e, u, k, uj, &t, &M);
            if (c == INF) continue;
            const double nc = cu + c;
            if (sello[v] != gen || nc < coste[v]) {
                sello[v] = gen; coste[v] = nc; padre[v] = u;
                const double x = (vi - fi) * dxm, y = (vj - fj) * dy;
                double h = __builtin_sqrt(x * x + y * y) * cmin;
                if (usaV) { double d = vc[v]; if (d != INF && d - vt > h) h = d - vt; }
                if (usaI) { double d = ic[v]; if (d != INF && it - d > h) h = it - d; }
                if (!mont_push(&heap, nc + h, v)) { liberar(m0); return 0; }
            }
        }
    }
    liberar(m0);
    info[1] = expandidos;
    if (!ok) return 0;
    info[0] = coste[fin];
    int32_t n = 0;
    for (int32_t k = fin; k != -1 && n < maxCamino; k = padre[k]) camino[n++] = k;
    return n;
}
