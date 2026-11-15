Os propongo un producto concreto y luego lo reparto en siete roles. Cada rol tiene entregables propios y unas interfaces claras con los demás, para que podáis trabajar en paralelo desde la primera hora.

## Concepto: "Marswalk Planner"

Es un mapa 3D de **un solo sitio** con capas que se activan y desactivan: terreno, geología, peligros y clima. Encima va un planificador que traza una ruta de EVA entre puntos de interés científico. La ruta respeta los límites de pendiente, distancia, tiempo y retorno a la base, y muestra las condiciones previstas.

Os recomiendo **el cráter Jezero**. Tiene cobertura HiRISE con modelos de elevación (DTM), datos de Perseverance (MEDA para el clima, SuperCam y PIXL para la geología) y una historia científica clara: el delta y los carbonatos. Elegir un sitio con tantos datos os ahorra muchísimo trabajo.

## Reparto en 7 personas

**1. Arquitectura e integración (tech lead)**

> Roberto

- Define la pila técnica. Por ejemplo, CesiumJS o MapLibre en el frontend y un backend ligero en FastAPI.
- Fija el contrato de datos desde la hora 0: sistema de referencia común (IAU Mars 2000), rasters en GeoTIFF optimizado (COG) o teselas, y vectores en GeoJSON.
- Monta el repositorio, el despliegue y la API de capas (`/layers`, `/route`, `/conditions`).
- Integra el trabajo de todos y resuelve los bloqueos.

**2. Terreno e imágenes orbitales**

> Roberto

- Reúne la topografía y la imagen base. Cuanta más resolución, más detalle: MOLA a escala global, después HRSC y CTX, y por último el DTM de HiRISE de Jezero.
- Reproyecta, recorta y genera teselas. Si queréis ir rápido, podéis reutilizar los servicios WMTS de NASA Mars Trek.
- Calcula las capas derivadas que necesita la persona 5: pendiente, rugosidad, orientación y, si da tiempo, densidad de rocas.

**3. Ciencia y puntos de interés**

> Pablo

- Prepara las capas de mineralogía (CRISM, de MRO) y de inercia térmica (THEMIS, de Mars Odyssey) sobre el delta.
- Selecciona entre 5 y 10 puntos de interés con una ficha cada uno: qué hay, por qué importa, qué muestra tomar y qué dijo el rover.
- Redacta el relato científico de la ruta, es decir, qué se descubre en cada parada. Es lo que convence al jurado.

**4. Condiciones ambientales ("current conditions")**

> Paula

- Trabaja con los datos de superficie de MEDA (Perseverance) y REMS (Curiosity) como referencia: temperatura, presión, viento y polvo.
- Añade el contexto orbital: MARCI para el seguimiento de tormentas de polvo, MCS para perfiles atmosféricos y RAD para la radiación.
- Monta un panel de condiciones con el estado actual simulado o el más reciente, el ciclo diurno, la hora solar local, el ángulo solar y las ventanas de luz.
- Produce un indicador de "go / no-go" para la EVA.

**5. Planificación de rutas y seguridad**

> Hani

- Construye un algoritmo de coste sobre la cuadrícula del terreno, por ejemplo A* o Dijkstra. Penaliza la pendiente y la rugosidad, y excluye las zonas peligrosas.
- Aplica las restricciones de la EVA: distancia y duración máximas, consumibles (modelo simple de O₂ y batería), punto de no retorno y regreso al hábitat.
- Devuelve la ruta en GeoJSON con el perfil de elevación, el tiempo estimado por tramo y las alertas.
- Opcional: ofrece una ruta alternativa de emergencia.

**6. Frontend, experiencia de usuario y presentación**

> Marta

- Diseña la interfaz: globo o mapa 3D, selector de capas, fichas de los puntos de interés, línea de tiempo de la EVA y panel de condiciones.
- Añade un "modo astronauta" con vista simplificada en primera persona y las siguientes instrucciones de ruta.
- Prepara el vídeo demo, las diapositivas y el texto del envío, en coordinación con la persona 3 para el relato.

**7. Terreno en el mapa, modo astronauta y Jarvis**

> Hamza

- Prepara las capas de terreno de Jezero para el planificador: pendiente, rugosidad y peligro, sacadas del DTM, con la escala este-oeste corregida en las pendientes.
- Añade la **capa de confianza**, que marca en el mapa dónde los datos son fiables (HiRISE) y dónde son pobres.
- Une las dos vistas en un **mapa unificado**: «Explorar Marte» llega hasta el detalle de Jezero, y la ruta se abre y se cierra sin saltos.
- Construye el **modo astronauta**: vista en primera persona con visor de casco (rumbo, siguiente maniobra, consumibles y alertas). Lleva el relieve HiRISE de 1 m y la ortoimagen de ~0,6 m, mirada libre en 360° con zoom, rocas en 3D y polvo con el viento.
- Monta la **interfaz de voz de Jarvis** en la vista 360° de Wildcat Ridge: se mantiene pulsada la J para preguntar y se suelta para que responda con el audio de Pablo. Mientras, la cámara se acerca sola a la roca sin enseñar la cubierta negra del rover y el panel muestra las cifras en vivo del planificador.
- Mejora la voz de las indicaciones de la ruta para que use la voz más natural de cada equipo.

## Calendario orientativo (48 h)

| Fase | Qué |
|---|---|
| 0–3 h | Elegir el sitio, cerrar el contrato de datos y montar el esqueleto del repositorio |
| 3–18 h | Cada persona trabaja en su parte con datos de prueba si los reales no han llegado |
| 18–30 h | Primera integración de extremo a extremo: mapa, capas, ruta y panel |
| 30–40 h | Pulido, cas

---

Estos son los extras que más pueden diferenciaros. Los he ordenado por **impacto ante el jurado frente al esfuerzo**, porque en 48 horas no da tiempo a todo. Mejor elegir dos o tres y hacerlos muy bien.

## Alto impacto, esfuerzo razonable

**Validar la ruta contra el trayecto real de Perseverance.** Superponed el recorrido que hizo el rover en Jezero y comparadlo con el que propone vuestro algoritmo. Si salen parecidos, tenéis una prueba objetiva de que el planificador funciona. Casi ningún equipo valida su modelo, y es lo que da credibilidad a todo lo demás.

**Mostrar la confianza de cada dato.** Cada capa indica su resolución, su fecha y la misión de origen. Además, el mapa marca las zonas donde los datos son pobres, por ejemplo donde solo hay MOLA y no HiRISE. Un astronauta necesita saber dónde el mapa es fiable y dónde no. Esto conecta directamente con el enunciado ("the best map possible").

**Sombras y luz según la hora.** Calculad las sombras sobre el DTM según la posición del sol en cada momento de la EVA. Así la ruta puede evitar tramos en sombra, que son más fríos, tienen menos energía solar y peor visibilidad. Visualmente es espectacular y técnicamente es sencillo.

**Replanificación en tiempo real.** Añadid un botón tipo "tormenta de polvo detectada" o "consumibles al 40 %" que recalcule la ruta de vuelta al instante. Demuestra que la herramienta sirve *durante* la EVA, no solo para planificarla, y en una demo en vivo es muy convincente.

## Diferenciadores de "pensamiento de misión"

**Retardo y ventanas de comunicación.** Entre la Tierra y Marte hay de 4 a 24 minutos de retardo, así que el astronauta tiene que ser autónomo. Mostrad cuándo pasan por encima los orbitadores de relevo (MRO, MAVEN, TGO) y en qué tramos de la ruta hay cobertura. Es un detalle que los evaluadores de NASA reconocen enseguida.

**Valor científico frente a riesgo.** En lugar de una sola ruta, ofreced dos o tres opciones: "segura", "equilibrada" y "máxima ciencia", con su coste y su beneficio en un gráfico. Así el planificador ayuda a decidir en vez de imponer.

**Dosis de radiación acumulada.** Usad los datos de RAD (Curiosity) para estimar la dosis según la duración de la EVA, y mostradla junto al consumo de oxígeno y batería.

**Conexión con Mars Sample Return.** Incluid el depósito de muestras que dejó Perseverance como punto de interés. Le da al proyecto un vínculo con una misión real y actual.

## "Wow" para la demo (solo si sobra tiempo)

- **Asistente de voz** que responde preguntas como "¿cuánto me falta para el siguiente punto?" o "¿qué hay en esta roca?" usando los datos de las capas. Vosotros sabéis de agentes LLM, así que es terreno conocido.
- **Vista en primera persona o VR** del recorrido sobre el terreno real.
- **Modo multi-astronauta** con roles distintos (geólogo y apoyo) y sus rutas coordinadas.

## Para el pitch
- Abrid con una **historia**: "Sol 1, 08:00, la comandante sale del hábitat…". Después enseñad la herramienta resolviendo un problema en vivo.
- Mencionad cuántas misiones y datasets integráis. El reto premia la integración multi-misión, así que decidlo explícitamente.
- Si publicáis el código abierto y documentáis bien las fuentes, el proyecto parece reutilizable, no un simple prototipo.

Mi recomendación: **validación con Perseverance + capa de confianza + replanificación en vivo**. Las tres refuerzan el núcleo del producto en vez de dispersaros.
