# Solar scene texture attribution

All planetary textures in this directory are stored locally and verified for offline/local serving without runtime CDN requests.

## Sources & Licenses

1. **Solar System Scope / INOVE** — [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
   - Collection: https://www.solarsystemscope.com/textures/
   - Base (`2048×1024`), 4K (`4096×2048`), ring (`2048×128`), and `low/` (`1024×512`) maps:
     - `sun.jpg`, `low/sun.jpg` — Sun photosphere (`2k_sun`)
     - `gas_giant.jpg`, `gas_giant_4k.jpg`, `low/gas_giant.jpg` — Jupiter (`2k_jupiter`, `8k_jupiter` 4K)
     - `ice_giant.jpg`, `low/ice_giant.jpg` — Neptune (`2k_neptune`)
     - `exo_planet.jpg`, `exo_planet_4k.jpg`, `low/exo_planet.jpg` — Mars (`2k_mars`, `8k_mars` resampled to `4096×2048`)
     - `moon.jpg`, `low/moon.jpg` — Moon (`2k_moon`)
     - `earth_clouds.jpg` — Earth clouds (`2k_earth_clouds`)
     - `saturn_ring.png` — Saturn rings alpha (`8k_saturn_ring_alpha` resampled to `2048×128` power-of-two RGBA)

2. **Three.js planetary texture examples** — [MIT License](https://github.com/mrdoob/three.js/blob/dev/LICENSE)
   - The required copyright and permission notice is included in [THREE-LICENSE.txt](THREE-LICENSE.txt).
   - Source: `mrdoob/three.js` (`examples/textures/planets/`)
   - Files:
     - `earth_day.jpg` (`earth_atmos_2048.jpg`, `2048×1024`) & `low/earth_day.jpg` (`1024×512`)
     - `earth_day_4k.jpg` (`earth_day_4096.jpg`, `4096×2048`)
     - `earth_night.jpg` (`earth_night_4096.jpg`, `4096×2048`)
     - `earth_normal.jpg` (`earth_normal_2048.jpg`, `2048×1024`)
     - `earth_specular.jpg` (`earth_specular_2048.jpg`, `2048×1024`)

3. **NASA Scientific Visualization Studio — CGI Moon Kit (SVS 4720)** — Public Domain (NASA / LROC WAC)
   - Source: https://svs.gsfc.nasa.gov/4720/
   - File:
     - `moon_4k.jpg` (`lroc_color_poles_4k.tif`, `4096×2048` JPEG conversion)

Resolutions are aligned to power-of-two dimensions (`1024×512`, `2048×1024`, `4096×2048`, `2048×128`) for WebGL1 mipmap and `REPEAT` compatibility. The fictional agent planets are visual representations rather than strict astronomical reconstructions; original authors do not endorse this project.
