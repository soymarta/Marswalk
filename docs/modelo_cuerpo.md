# Tu cuerpo en esta ruta: modelo, datos y límites

Responsable: Hani (módulo 5). Código: `js/ruta/eva.js` (modelo), `js/ruta/ruta.js` (`resumenCuerpo`, tarjeta
«Tu cuerpo en esta ruta»), `python/calibrar_metabolismo.py` → `data/ruta/calibracion_metabolica.json`.

## Qué muestra

Para la ruta elegida y la persona que la camina:

| Cifra | Tipo | De dónde sale |
|---|---|---|
| Energía (rango del 90 %) | modelo | Pandolf/Santee calibrado con NASA (abajo), sumado tramo a tramo y en las paradas |
| Equivalencias: plátanos, km andando en la Tierra | modelo | 105 kcal por plátano mediano (USDA); paseo a 5 km/h sin carga (Pandolf) |
| % de tu capacidad aeróbica (media, pico de 1 min, minutos > 70 %) | modelo | VO₂ = M / 20,1 kJ por litro de O₂; capacidad por el test de 20 m (Léger et al. 1988) o, sin test, la de los sujetos de NASA (48,7 mL/kg/min) |
| Minutos sudando / por encima de la refrigeración del Apolo | umbral medido | 1670 y 2090 kJ/h (Waligora & Horrigan 1975) |
| Agua para beber | dato medido | bolsa de 1 L del Apolo; 0,7-0,95 L bebidos en la caminata de 10 km |

Veredicto: «asumible» si la media no pasa del 50 % (la caminata de 10 km con traje de NASA se hizo al 51 % y
se percibió como ligera, Borg 11,8) y hay menos de 5 min por encima del 70 %; «exigente» hasta el 60 %;
«demasiado exigente» por encima. Los cortes del 60 % y el 70 % son orientativos, no clínicos.

## Cuerpo por zonas y qué comer (js/ruta/fisiologia.js)

Un diagrama del cuerpo al lado de la tarjeta, con cada zona en verde, ámbar o rojo. Sigue la línea de tiempo
(en el minuto 0 muestra la ruta entera). En la navegación, quien camina solo ve un indicador «Cuerpo» cuando
pide actuar (bajar el ritmo, beber). Los cortes de color son orientativos y están en el código.

| Zona | Qué se calcula | Fuente |
|---|---|---|
| Corazón y lactato | % del VO₂máx frente a un umbral de lactato estimado (55 % sin entrenar a 80 % muy entrenado, según tu VO₂máx); minutos por encima | Faude et al. 2009 (rangos del umbral); la relación con el VO₂máx es nuestra |
| Muslos | trabajo vertical al subir y al bajar (masa con traje × 3,72 m/s² × desnivel), en metros de escalera en la Tierra sin traje; bajar = frenada excéntrica del cuádriceps (agujetas) | física; cortes 150 / 400 m |
| Gemelos | pasos de 0,75 m | cortes 6000 / 12 000 |
| Manos | minutos de trabajo de campo con guante | Strauss 2004 (NASA/TP-2004-212075); cortes 45 / 90 min |
| Glucógeno | energía × fracción de hidratos según la intensidad, sobre ~500 g de reserva en 70 kg | Romijn et al. 1993; Hearris et al. 2018 |
| Sudor | calor por encima del umbral de sudor del traje del Apolo / 2,43 MJ/kg + ~50 mL/h al respirar; % del peso | Waligora & Horrigan 1975; Sawka et al. 2007 (2 %) |
| Radiación | dosis de la salida | Hassler et al. 2014 |

**Plan de comida y bebida** (Thomas, Erdman & Burke 2016, ACSM): antes, 1-2 g/kg de hidratos 2-3 h antes;
durante, ~30 g/h de hidratos si dura más de 1 h y beber de la bolsa de 1 L lo necesario para no perder más
del 1 % del peso; al volver, 0,3 g/kg de proteína, 0,6-1 g/kg de hidratos y 1,5 L por litro perdido. El ejemplo
de recuperación es leche con cacao (Karp et al. 2006), con calcio y vitamina D para el hueso a 0,38 g.

No se modela la adrenalina: no hay forma de estimarla con lo que sabemos de la ruta.

## Calibración (no es aprendizaje automático, y por qué)

El modelo es Pandolf (1977) con la corrección de bajada de Santee (2003), generalizado a cualquier gravedad:

```
M = s · [ 1,5W + (g/g₀)·2(W+L)(L/W)² + (a + (1−a)·g/g₀)·η(W+L)(1,5v² + 0,35vG) ]
```

- Sostener la carga escala con el peso (g/g₀). La locomoción tiene una parte `a` que no depende del peso.
- `s` es el sobrecoste del traje presurizado.
- En la Tierra sin traje es exactamente Pandolf.

**Datos.** Solo hay una medida abierta de marcha con traje en gravedad reducida con números legibles: la
caminata de 10 km con traje MKIII a 1/6 g (Norcross et al. 2008). El informe de marcha en llano a 3/8 g
(NASA/TP-2010-216115) no está en NTRS y las bases de datos abiertas de marcha en la Tierra no se pudieron
descargar (de pago o con captcha). Con un punto no se entrena un modelo de aprendizaje automático sin
sobreajustarlo. Por eso se ajusta **un** parámetro (`a`) y la incertidumbre se propaga por Monte Carlo:

- medida de la caminata ± su desviación entre sujetos (2374 ± 304 BTU/h);
- `s` uniforme en [1,10, 1,40] (supuesto; Carr & Newman 2007 dan ≈ 1,25).

**Resultado** (`a` = 0,176, `s` = 1,25; banda de energía ×0,90 a ×1,10):

| Marte, traje por defecto (75 + 60 + 10 kg) | Antes | Calibrado (P5–P95) |
|---|---|---|
| Llano, 0,77 m/s | 497 W | 354 W (320–390) |
| Subida 10 % | 724 W | 512 W (455–571) |
| Bajada 10 % | 424 W | 303 W (274–333) |

El modelo anterior sobrestimaba el esfuerzo en un ~29 %: escalaba el peso del traje como si la gravedad solo
redujera el 30 % del coste.

**Validación** con datos que no se usaron para ajustar:

| Comprobación | Predicho | Medido |
|---|---|---|
| VO₂ en la caminata de 10 km | 25,5 mL/kg/min | 24,7 (50,8 % de 48,7): +3 % |
| O₂ en la caminata de 10 km | 178 g/h | 181 g/h |
| O₂ en las EVA del Apolo | 70 g/h | 68 g/h |
| Apolo andando (0,8 m/s, η 1,2-1,5) | 313-331 W | medias de EVA 233-291 W, que incluyen tareas más suaves |

## Límites (dichos por nosotros)

- Un solo punto de marcha con traje en gravedad reducida, en cinta y con suspensión POGO (no en regolito).
  Nada medido a 0,38 g: Marte se interpola entre la Tierra (Pandolf) y la Luna (NASA).
- El test de 20 m estima la capacidad aeróbica con r ≈ 0,7 en niños y 0,9 en adultos. No es un diagnóstico.
- El trabajo en las paradas usa 280 W fijos (las medias de EVA del Apolo, 200-250 kcal/h, incluyen marcha).
- La fatiga por zonas, el glucógeno y el sudor son modelos sencillos con cortes orientativos, no medidas; no se
  modela la temperatura corporal. Los umbrales de sudor y refrigeración son los del traje del Apolo, no los de un
  traje marciano.

## Fuentes

- Norcross J. et al. 2008. *Feasibility of performing a suited 10-km ambulation on the Moon.* AsMA. NTRS 20080014853.
- Norcross J. et al. 2010. *Metabolic costs and biomechanics of inclined ambulation and exploration tasks in a planetary suit.* NASA/TP-2010-216125. NTRS 20110003409.
- Waligora J.M. & Horrigan D.J. 1975. *Metabolism and heat dissipation during Apollo EVA periods.* NASA SP-368. NTRS 19760005584.
- Pandolf K.B. et al. 1977. *J Appl Physiol* 43:577-581. Santee W.R. et al. 2003. *Aviat Space Environ Med*.
- Léger L.A. et al. 1988. *J Sports Sci* 6:93-101.
