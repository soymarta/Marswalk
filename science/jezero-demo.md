# Jezero: three science stops for the EVA demo

**Selected scenario (14 Nov 2026).** Use the existing *Safe* route: Base Alpha → Three Forks → Wildcat Ridge → Hawksbill Gap → Base Alpha. Compare it with *Max Science* for a measurable trade-off. Hani recalculated the routes after moving two marker viewpoints in his local branch; the latest model outputs are in [Issue #16](https://github.com/roberto3554/NASA-Space-Apps-Challenge-2026/issues/16). They are **team-reported model outputs**, not NASA measurements. Read the integrated app before using any figure in the pitch; do not hard-code route numbers in slides.

**Why this area?** The western delta gives the astronaut a compact, visually legible decision: reach an existing sample depot, examine a sedimentary rock with an organic signal, and read the exposed delta layers. It fits the three current POI IDs and the existing route model. Wildcat Ridge is the visual hero. Hani reports HiRISE image and relief coverage and a real rover panorama there; first-person performance on the presentation laptop still needs checking. A new mountain or terrain engine is not needed for the scientific story.

| Existing ID | What we can defend | Activity proposed for a *hypothetical* crew | Location status |
| --- | --- | --- | --- |
| `three-forks` | NASA maps ten sealed sample tubes at Three Forks, deposited between sols 653 and 690. The site motivates sample access and preservation. | Photograph terrain and access to the depot; handling tubes would require a separate mission plan. | Use a rover viewpoint in the depot area, **not a verified tube position**. See coordinate follow-up below. |
| `wildcat-ridge` | The delta rock formed from mud, fine sand and salts. SHERLOC found organic molecules spatially associated with sulfates. Organics **do not establish life**. NASA lists cores Hazeltop (sol 509) and Bearwallow (sol 516). | Photograph layers, textures and sample context. | Use a nearby rover viewpoint, **not a surveyed rock centroid**. See coordinate follow-up below. |
| `hawksbill-gap` | Rover-team stratigraphic work documents layered deposits at this delta-front sector. Their sequence helps interpret sediment delivery into the former lake. | Record an annotated layer sequence from a safe viewpoint. | Coordinate is an MMGIS track point at sol 439, **a sector proxy**. |

The existing `valor` scores (9, 9, 7) and `trabajoMin` (30, 45, 30) are **planner choices**. They are useful for comparing routes, but do not claim they are NASA ratings or measured EVA task times. The `sol` field is an image lookup hint, not the date of a sample or depot. No `id`, coordinate, `sol`, `valor` or `trabajoMin` was changed in this science pass. The revised short descriptions and primary-source URLs live in [`data/ruta/puntos_eva.json`](../data/ruta/puntos_eva.json).

## Demo handoff

1. Open the existing Jezero planner and select the *Safe* route. Lead with the decision: **"Which route gives useful science while leaving an EVA margin?"**
2. Show Wildcat Ridge, one sourced sentence about the organic signal, and the first-person view or real rover panorama if ready. Say **"organic molecules, not proof of life."**
3. Compare *Safe* with *Max Science* using a current model output (time, estimated O₂/effort, and science points). Show at least one gain **and** its cost or limit. The body/voice popup must use Hani's current `window.marswalk.cuerpo()` output, not a second calculation.
4. Three Forks and Hawksbill Gap provide the beginning and end of the story. A short label for each is enough; avoid three long geology speeches.

For the visual moment, use a brief fluid approach in astronaut mode and Hani's real rover panorama at Wildcat Ridge. Hani measured about 3 fps with full MapLibre 3D terrain on his laptop, so that mode is not the demo dependency; test again on the presentation laptop. If a separate stylized 3D shot is used, label it **"illustrative visualization"** and do not imply that illustrative rocks, vertical exaggeration or astronaut movement are measured topography. Preserve a real screen recording as the demo fallback. The slide deck and project submission must be in English; Pablo can explain orally in Spanish at the local pitch. A submitted video with Spanish speech needs English subtitles per the Granada organizer's 14 Nov notice.

## Sources and remaining checks

- [NASA/JPL on Wildcat Ridge, its depositional setting and SHERLOC findings](https://www.jpl.nasa.gov/news/nasas-perseverance-rover-investigates-geologically-rich-mars-terrain/).
- [NASA Mars 2020 rock sample table](https://science.nasa.gov/mission/mars-2020-perseverance/mars-rock-samples/) — Hazeltop and Bearwallow sampling sols.
- [NASA Three Forks depot map](https://science.nasa.gov/resource/perseverances-three-forks-sample-depot-map/) — ten tubes and depot dates.
- [Stack et al., 2024, rover-team stratigraphy of the western fan](https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2023JE008187) and [NASA NTRS abstract](https://ntrs.nasa.gov/citations/20230000582) — Hawksbill Gap.
- [NASA/JPL MMGIS M20 traverse](https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json) — track-point coordinates used by the existing catalog.

**Coordinate follow-up from Hani's MMGIS check:** the original Three Forks marker is roughly 370–420 m from the rover's depot-period positions. Hani has moved it in his local branch to a depot-zone *viewpoint* at 77.40824 E, 18.45281 N (site 32, sol 670), still not an individual tube coordinate. He moved Wildcat Ridge to a rover viewpoint at 77.40592 E, 18.45865 N (sol 502); sol 501 remains the panorama-image lookup. These moves are **not part of this science PR**. Hani owns their commit plus route-cache/panorama regeneration. Treat all three markers as approximate until checked against named features. Recheck route values after integration. Details are in [Issue #9](https://github.com/roberto3554/NASA-Space-Apps-Challenge-2026/issues/9).
