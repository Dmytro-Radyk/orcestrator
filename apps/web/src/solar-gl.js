// WebGL1 3D Solar System renderer with equirectangular planetary textures (low/2K/on-demand 4K),
// normal/specular/cloud/night maps, tangent-space relief, transparent Cassini rings,
// solar photosphere & corona, mipmaps, anisotropic filtering, and WebGL capability checks.

export function mat4Multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

export function mat4Perspective(fovRad, aspect, near, far) {
  const f = 1 / Math.tan(fovRad / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0
  ]);
}

export function mat4LookAt(eye, target, up) {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len; zy /= len; zz /= len;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len; xy /= len; xz /= len;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1
  ]);
}

export function projectWorldToScreen(worldPos, viewProj, width, height) {
  const [x, y, z] = worldPos;
  const cx = viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12];
  const cy = viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13];
  const cz = viewProj[2] * x + viewProj[6] * y + viewProj[10] * z + viewProj[14];
  const cw = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];
  if (cw <= 0.05) return null;
  const ndcX = cx / cw;
  const ndcY = cy / cw;
  const ndcZ = cz / cw;
  if (ndcZ < -1 || ndcZ > 1.2) return null;
  return {
    sx: (ndcX * 0.5 + 0.5) * width,
    sy: (-ndcY * 0.5 + 0.5) * height,
    depth: cw
  };
}

function compileShader(gl, type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Shader compile error: ${info}`);
  }
  return sh;
}

function createProgram(gl, vsSrc, fsSrc) {
  const prog = gl.createProgram();
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`Program link error: ${info}`);
  }
  return prog;
}

const NOISE_GLSL = `
float hash3(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float noise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3(i + vec3(0,0,0)), hash3(i + vec3(1,0,0)), f.x),
        mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x),
        mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z
  );
}

float fbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise3(p);
    p = p * 2.05 + vec3(13.1, 7.7, 5.3);
    a *= 0.5;
  }
  return v;
}
`;

const SKY_VS = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.999, 1.0);
}
`;

const SKY_FS = `
precision highp float;
varying vec2 vUv;
uniform vec2 uRes;
uniform float uYaw;
uniform float uPitch;
uniform float uTime;

${NOISE_GLSL}

vec3 dirFromScreen(vec2 uv) {
  vec2 p = (uv * 2.0 - 1.0);
  p.x *= uRes.x / max(1.0, uRes.y);
  vec3 d = normalize(vec3(p.x, p.y, -1.7));
  float cp = cos(uPitch), sp = sin(uPitch);
  d = vec3(d.x, d.y * cp - d.z * sp, d.y * sp + d.z * cp);
  float cy = cos(uYaw), sy = sin(uYaw);
  d = vec3(d.x * cy + d.z * sy, d.y, -d.x * sy + d.z * cy);
  return normalize(d);
}

void main() {
  vec3 dir = dirFromScreen(vUv);
  vec3 col = vec3(0.004, 0.008, 0.018);

  // Subtle Milky Way galactic band
  float plane = abs(dot(dir, normalize(vec3(0.32, 0.86, -0.40))));
  float band = exp(-plane * 7.5);
  float dust = fbm(dir * 5.2 + vec3(1.4, 0.6, 2.3));
  float rift = smoothstep(0.42, 0.75, fbm(dir * 12.0 + vec3(4.0)));
  vec3 milky = mix(vec3(0.024, 0.046, 0.098), vec3(0.095, 0.082, 0.145), dust);
  col += milky * band * (0.35 + 0.65 * (1.0 - rift * 0.72));

  // Crisp pinpoint starfields
  vec3 g1 = floor(dir * 290.0);
  float h1 = hash3(g1);
  if (h1 > 0.9922) {
    vec3 cell = fract(dir * 290.0) - 0.5;
    float d = length(cell);
    float twinkle = 0.84 + 0.16 * sin(uTime * 1.9 + h1 * 90.0);
    float star = (1.0 - smoothstep(0.02, 0.30, d)) * twinkle;
    vec3 starCol = mix(vec3(0.75, 0.88, 1.0), vec3(1.0, 0.88, 0.72), fract(h1 * 137.3));
    col += starCol * star * 0.95;
  }

  vec3 g2 = floor(dir * 135.0);
  float h2 = hash3(g2 + vec3(19.0));
  if (h2 > 0.9970) {
    vec3 cell = fract(dir * 135.0) - 0.5;
    float d = length(cell);
    float star = 1.0 - smoothstep(0.01, 0.30, d);
    vec3 starCol = mix(vec3(0.70, 0.86, 1.0), vec3(1.0, 0.94, 0.84), fract(h2 * 53.1));
    col += starCol * star * 1.25;
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

const BODY_VS = `
attribute vec3 aPos;
attribute vec3 aNorm;
attribute vec3 aTan;
attribute vec2 aUv;
uniform mat4 uViewProj;
uniform vec3 uCenter;
uniform float uRadius;
uniform float uSpin;
uniform float uTilt;
varying vec3 vWorldPos;
varying vec3 vWorldNorm;
varying vec3 vTangent;
varying vec3 vLocalPos;
varying vec2 vUv;

void main() {
  float ct = cos(uTilt), st = sin(uTilt);
  float cs = cos(uSpin), ss = sin(uSpin);

  vec3 p = vec3(aPos.x * cs + aPos.z * ss, aPos.y, -aPos.x * ss + aPos.z * cs);
  vec3 n = vec3(aNorm.x * cs + aNorm.z * ss, aNorm.y, -aNorm.x * ss + aNorm.z * cs);
  vec3 t = vec3(aTan.x * cs + aTan.z * ss, aTan.y, -aTan.x * ss + aTan.z * cs);

  vec3 wp = vec3(p.x * ct - p.y * st, p.x * st + p.y * ct, p.z);
  vec3 wn = vec3(n.x * ct - n.y * st, n.x * st + n.y * ct, n.z);
  vec3 wt = vec3(t.x * ct - t.y * st, t.x * st + t.y * ct, t.z);

  vUv = aUv;
  vLocalPos = aPos;
  vWorldPos = uCenter + wp * uRadius;
  vWorldNorm = normalize(wn);
  vTangent = normalize(wt);
  gl_Position = uViewProj * vec4(vWorldPos, 1.0);
}
`;

const BODY_FS = `
precision highp float;
varying vec3 vWorldPos;
varying vec3 vWorldNorm;
varying vec3 vTangent;
varying vec3 vLocalPos;
varying vec2 vUv;

uniform sampler2D uTex;
uniform sampler2D uNormalTex;
uniform sampler2D uSpecTex;
uniform sampler2D uCloudTex;
uniform sampler2D uNightTex;
uniform float uHasDetailMaps;
uniform float uHasRing;
uniform vec3 uEyePos;
uniform int uType;       // 0=sun, 1=gas, 2=terra, 3=ice, 4=exo, 5=moon
uniform float uTime;
uniform float uActive;
uniform vec3 uAtmoColor;
uniform vec3 uSurfaceTint;

${NOISE_GLSL}

float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec3 N = normalize(vWorldNorm);
  vec3 T = normalize(vTangent - N * dot(N, vTangent));
  vec3 B = normalize(cross(N, T));
  vec3 V = normalize(uEyePos - vWorldPos);
  float ndv = max(dot(N, V), 0.0);

  // Damp UV derivative bump smoothly near UV poles so meridian pinch never forms stars
  float poleAtten = 1.0 - smoothstep(0.88, 0.995, abs(vLocalPos.y));

  if (uType == 0) {
    // Solar photosphere: counter-rotating granulation layers + fbm magnetic cells + limb darkening
    vec2 uv1 = vec2(vUv.x + uTime * 0.0045, clamp(vUv.y, 0.002, 0.998));
    vec2 uv2 = vec2(vUv.x - uTime * 0.0025, clamp(vUv.y + 0.014 * sin(uTime * 0.18 + vUv.x * 6.283), 0.002, 0.998));
    vec3 t1 = texture2D(uTex, uv1).rgb;
    vec3 t2 = texture2D(uTex, uv2).rgb;
    vec3 plasma = mix(t1, t2, 0.34);

    float granules = fbm(vLocalPos * 14.0 + vec3(uTime * 0.08, -uTime * 0.05, uTime * 0.04));
    plasma *= (0.86 + 0.30 * granules);

    float limb = pow(ndv, 0.48);
    vec3 col = plasma * (0.58 + 0.72 * limb);
    col += vec3(1.0, 0.94, 0.72) * pow(ndv, 2.8) * 0.24;
    col += vec3(1.0, 0.36, 0.05) * pow(1.0 - ndv, 2.7) * 0.58;
    if (uActive > 0.5) {
      col += vec3(0.24, 0.12, 0.02) * pow(1.0 - ndv, 1.8) * (0.65 + 0.35 * sin(uTime * 2.5));
    }
    gl_FragColor = vec4(col, 1.0);
    return;
  }

  vec3 texCol = texture2D(uTex, vUv).rgb;
  vec3 L = normalize(-vWorldPos); // Light from Sun at world origin (0,0,0)

  // Compute perturbed surface normal per planet class
  vec3 Nsurf = N;
  if (uType == 2 && uHasDetailMaps > 0.5) {
    vec3 nmap = texture2D(uNormalTex, vUv).xyz * 2.0 - 1.0;
    nmap.xy *= 0.85 * poleAtten;
    Nsurf = normalize(T * nmap.x + B * nmap.y + N * nmap.z);
  } else {
    float epsU = 0.0014;
    float epsV = 0.0014;
    float vUp = clamp(vUv.y + epsV, 0.002, 0.998);
    float vDn = clamp(vUv.y - epsV, 0.002, 0.998);
    float hL = lum(texture2D(uTex, vec2(vUv.x - epsU, vUv.y)).rgb);
    float hR = lum(texture2D(uTex, vec2(vUv.x + epsU, vUv.y)).rgb);
    float hD = lum(texture2D(uTex, vec2(vUv.x, vDn)).rgb);
    float hU = lum(texture2D(uTex, vec2(vUv.x, vUp)).rgb);

    // Moons & rocky worlds have deep crater relief; gas/ice giants have subtle cloud shear
    float bumpStrength = (uType == 5) ? 2.4 : (uType == 4) ? 1.55 : (uType == 2) ? 0.9 : 0.32;
    bumpStrength *= poleAtten;
    Nsurf = normalize(N + T * ((hL - hR) * bumpStrength) + B * ((hD - hU) * bumpStrength));
  }

  float ndl = dot(Nsurf, L);
  float macroNdl = dot(N, L);
  float diff = smoothstep(-0.07, 0.88, ndl);
  float geomDay = smoothstep(-0.08, 0.18, macroNdl);
  float fresnel = pow(1.0 - ndv, 3.6);

  // Subtle zonal atmospheric micro-turbulence on gas/ice giants for close-up sharpness
  if (uType == 1 || uType == 3) {
    float bands = fbm(vec3(vLocalPos.x * 5.0 + vLocalPos.y * 2.5, vLocalPos.y * 18.0, vLocalPos.z * 5.0));
    texCol *= 0.94 + 0.14 * bands;
  }

  // Analytic soft equatorial ring shadow on ringed Gas Giants
  float ringShadow = 1.0;
  if (uType == 1 && uHasRing > 0.5) {
    float eqBand = exp(-abs(vLocalPos.y) * 9.5) * step(0.0, -dot(vLocalPos, normalize(L)));
    ringShadow = 1.0 - 0.36 * eqBand;
  }

  // Specular highlights: ocean specular mask for Terra, matte dusty regolith for Moon/Rocky
  float spec = 0.0;
  if (uType == 2) {
    float oceanMask = (uHasDetailMaps > 0.5)
      ? texture2D(uSpecTex, vUv).r
      : smoothstep(0.02, 0.16, texCol.b - max(texCol.r, texCol.g * 0.92));
    vec3 H = normalize(L + V);
    spec = pow(max(dot(Nsurf, H), 0.0), 46.0) * oceanMask * 0.62 * geomDay;
  } else if (uType == 4) {
    vec3 H = normalize(L + V);
    spec = pow(max(dot(Nsurf, H), 0.0), 18.0) * 0.05 * geomDay;
  }

  // Drifting clouds & city night lights on Terra when detail maps are available
  vec3 cloudLayer = vec3(0.0);
  float cloudCover = 0.0;
  vec3 nightLights = vec3(0.0);
  if (uType == 2 && uHasDetailMaps > 0.5) {
    vec2 cloudUv = vec2(vUv.x + uTime * 0.0022, vUv.y);
    cloudCover = texture2D(uCloudTex, cloudUv).r;
    float cloudShadow = texture2D(uCloudTex, cloudUv - vec2(0.003, 0.001)).r;
    texCol *= (1.0 - cloudShadow * 0.28 * diff);
    float cloudLit = smoothstep(-0.08, 0.78, macroNdl);
    cloudLayer = vec3(0.95, 0.98, 1.0) * cloudCover * (0.04 + 0.96 * cloudLit) * 0.85;

    float nightFactor = 1.0 - smoothstep(-0.24, 0.08, macroNdl);
    vec3 city = texture2D(uNightTex, vUv).rgb;
    nightLights = city * nightFactor * (1.0 - cloudCover * 0.7) * 0.78;
  }

  // Natural dark side ambient (subtle starlight only, stronger craters contrast on moons)
  texCol *= uSurfaceTint;
  float ambientLevel = (uType == 5) ? 0.045 : 0.065;
  vec3 ambient = texCol * ambientLevel;

  // Warm atmospheric twilight along the terminator & Rayleigh limb scattering
  float twilightMask = exp(-abs(macroNdl) * 11.5);
  vec3 twilightTint = mix(uAtmoColor, vec3(0.98, 0.56, 0.28), (uType == 2 || uType == 4) ? 0.45 : 0.15);
  float atmoStrength = (uType == 5) ? 0.12 : (uType == 4) ? 0.55 : 0.95;
  vec3 day = (texCol * (1.06 * diff * ringShadow) + vec3(spec)) * (1.0 - cloudCover * 0.35) + cloudLayer;
  vec3 atmoRim = uAtmoColor * fresnel * (0.14 + 0.92 * max(diff, 0.05)) * atmoStrength;

  if (uActive > 0.5) {
    atmoRim += vec3(0.32, 0.92, 1.0) * fresnel * 0.42;
  }

  vec3 finalCol = ambient + day + nightLights + twilightTint * twilightMask * atmoStrength * 0.18 + atmoRim;
  gl_FragColor = vec4(finalCol, 1.0);
}
`;

const RING_VS = `
attribute vec3 aPos;
uniform mat4 uViewProj;
uniform vec3 uCenter;
uniform float uRadius;
uniform float uTilt;
varying vec3 vWorldPos;
varying vec2 vRingPos;

void main() {
  float ct = cos(uTilt), st = sin(uTilt);
  vec3 wp = vec3(aPos.x * ct - aPos.y * st, aPos.x * st + aPos.y * ct, aPos.z);
  vRingPos = aPos.xz;
  vWorldPos = uCenter + wp * uRadius;
  gl_Position = uViewProj * vec4(vWorldPos, 1.0);
}
`;

const RING_FS = `
precision highp float;
varying vec3 vWorldPos;
varying vec2 vRingPos;
uniform sampler2D uRingTex;
uniform float uHasRingTex;
uniform vec3 uCenter;
uniform float uRadius;
uniform vec3 uEyePos;
uniform vec3 uRingColor;

float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  float r = length(vRingPos);
  if (r < 1.28 || r > 2.48) discard;
  float t = (r - 1.28) / (2.48 - 1.28);

  float alpha = 0.0;
  vec3 texBand = uRingColor;
  if (uHasRingTex > 0.5) {
    vec4 sampleRing = texture2D(uRingTex, vec2(t, 0.5));
    texBand = mix(uRingColor, sampleRing.rgb * uRingColor * 1.35, 0.65);
    alpha = max(sampleRing.a, lum(sampleRing.rgb) * 0.25) * 0.88;
  } else {
    float ringlets = 0.55 + 0.45 * sin(t * 115.0) * sin(t * 43.0);
    float cassini = smoothstep(0.025, 0.070, abs(t - 0.62));
    float encke = smoothstep(0.012, 0.030, abs(t - 0.87));
    alpha = ringlets * cassini * encke * 0.72;
  }

  float innerFade = smoothstep(0.0, 0.08, t);
  float outerFade = 1.0 - smoothstep(0.88, 1.0, t);
  alpha *= innerFade * outerFade;
  if (alpha < 0.02) discard;

  // Planet cylindrical umbra cast onto the ring plane opposite the Sun
  vec3 sunDir = normalize(-uCenter);
  vec3 rel = vWorldPos - uCenter;
  float proj = dot(rel, sunDir);
  float perp = length(rel - sunDir * proj);
  float inShadow = (proj < 0.0) ? smoothstep(uRadius * 0.90, uRadius * 1.08, perp) : 1.0;

  // Subtle icy dust forward scattering when viewing back towards the Sun
  vec3 viewDir = normalize(uEyePos - vWorldPos);
  float scatter = 1.0 + 0.35 * pow(max(dot(-viewDir, sunDir), 0.0), 3.0);

  vec3 col = texBand * (0.14 + 0.92 * inShadow) * scatter;
  gl_FragColor = vec4(col, alpha);
}
`;

const CORONA_VS = `
attribute vec2 aPos;
uniform mat4 uViewProj;
uniform vec3 uCenter;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform float uSize;
varying vec2 vUv;

void main() {
  vUv = aPos;
  vec3 wp = uCenter + (uCamRight * aPos.x + uCamUp * aPos.y) * uSize;
  gl_Position = uViewProj * vec4(wp, 1.0);
}
`;

const CORONA_FS = `
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform float uPulse;
uniform float uReduced;

void main() {
  float d = length(vUv);
  if (d > 1.0) discard;
  float ang = atan(vUv.y, vUv.x);
  float t = uReduced > 0.5 ? 0.0 : uTime;
  float streamer1 = 0.86 + 0.14 * sin(ang * 7.0 + t * 0.45) * cos(ang * 4.0 - t * 0.3);
  float streamer2 = 0.90 + 0.10 * sin(ang * 13.0 - t * 0.65);
  float glow = exp(-d * 4.1) * streamer1 * streamer2 * (0.78 + 0.12 * uPulse);
  float inner = exp(-d * 10.0) * 0.72;
  float edgeFade = 1.0 - smoothstep(0.75, 1.0, d);
  vec3 col = vec3(1.0, 0.62, 0.20) * glow + vec3(1.0, 0.94, 0.76) * inner;
  gl_FragColor = vec4(col, clamp((glow + inner) * edgeFade, 0.0, 1.0));
}
`;

const LINE_VS = `
attribute vec3 aPos;
attribute vec4 aCol;
uniform mat4 uViewProj;
varying vec4 vCol;
void main() {
  vCol = aCol;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

const LINE_FS = `
precision mediump float;
varying vec4 vCol;
void main() {
  gl_FragColor = vCol;
}
`;

const POINT_VS = `
attribute vec3 aPos;
attribute float aSize;
attribute float aAlpha;
uniform mat4 uViewProj;
varying float vAlpha;
void main() {
  vAlpha = aAlpha;
  gl_Position = uViewProj * vec4(aPos, 1.0);
  gl_PointSize = aSize;
}
`;

const POINT_FS = `
precision mediump float;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  gl_FragColor = vec4(0.68, 0.78, 0.90, (1.0 - d) * vAlpha);
}
`;

function createSphereMesh(gl, latBands = 64, lonBands = 96) {
  const positions = [];
  const normals = [];
  const tangents = [];
  const uvs = [];
  const indices = [];

  for (let lat = 0; lat <= latBands; lat++) {
    const v = lat / latBands;
    const theta = v * Math.PI;
    const sinT = Math.sin(theta), cosT = Math.cos(theta);
    for (let lon = 0; lon <= lonBands; lon++) {
      const u = lon / lonBands;
      const phi = u * 2 * Math.PI;
      const cosP = Math.cos(phi), sinP = Math.sin(phi);
      const x = cosP * sinT;
      const y = cosT;
      const z = sinP * sinT;
      positions.push(x, y, z);
      normals.push(x, y, z);
      // Analytic unit tangent along longitude — stays well-defined even at poles (sinT == 0)
      tangents.push(-sinP, 0, cosP);
      uvs.push(u, v);
    }
  }
  for (let lat = 0; lat < latBands; lat++) {
    for (let lon = 0; lon < lonBands; lon++) {
      const first = lat * (lonBands + 1) + lon;
      const second = first + lonBands + 1;
      indices.push(first, second, first + 1, second, second + 1, first + 1);
    }
  }
  const makeBuf = (arr, target = gl.ARRAY_BUFFER, Typed = Float32Array) => {
    const b = gl.createBuffer();
    gl.bindBuffer(target, b);
    gl.bufferData(target, new Typed(arr), gl.STATIC_DRAW);
    return b;
  };
  return {
    posBuf: makeBuf(positions),
    normBuf: makeBuf(normals),
    tanBuf: makeBuf(tangents),
    uvBuf: makeBuf(uvs),
    idxBuf: makeBuf(indices, gl.ELEMENT_ARRAY_BUFFER, Uint16Array),
    count: indices.length
  };
}

function createRingMesh(gl, segments = 144) {
  const positions = [];
  const indices = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    positions.push(ca * 1.28, 0, sa * 1.28);
    positions.push(ca * 2.48, 0, sa * 2.48);
  }
  for (let i = 0; i < segments; i++) {
    const i0 = i * 2;
    indices.push(i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2);
  }
  const posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
  const idxBuf = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
  return { posBuf, idxBuf, count: indices.length };
}

function createQuadMesh(gl) {
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  return buf;
}

const isPOT = n => n > 0 && (n & (n - 1)) === 0;

export function fitTextureDimensions(width,height,maxSize) {
  if (![width,height,maxSize].every(n=>Number.isFinite(n)&&n>0)) throw Error('Invalid texture dimensions');
  const scale=Math.min(1,maxSize/Math.max(width,height));
  return {width:Math.max(1,Math.floor(width*scale)),height:Math.max(1,Math.floor(height*scale))};
}

function createSolidTexture(gl, rgba) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

const BASE_TEXTURE_URLS = {
  0: { low: '/textures/low/sun.jpg', hd: '/textures/sun.jpg', fallback: [255, 190, 75, 255] },
  1: { low: '/textures/low/gas_giant.jpg', hd: '/textures/gas_giant.jpg', hd4k: '/textures/gas_giant_4k.jpg', fallback: [214, 158, 102, 255] },
  2: { low: '/textures/low/earth_day.jpg', hd: '/textures/earth_day.jpg', hd4k: '/textures/earth_day_4k.jpg', fallback: [46, 118, 188, 255] },
  3: { low: '/textures/low/ice_giant.jpg', hd: '/textures/ice_giant.jpg', fallback: [62, 118, 214, 255] },
  4: { low: '/textures/low/exo_planet.jpg', hd: '/textures/exo_planet.jpg', hd4k: '/textures/exo_planet_4k.jpg', fallback: [164, 96, 68, 255] },
  5: { low: '/textures/low/moon.jpg', hd: '/textures/moon.jpg', hd4k: '/textures/moon_4k.jpg', fallback: [165, 170, 178, 255] }
};

export function createSolarGL(canvas) {
  const gl = canvas.getContext('webgl', { antialias: true, alpha: false, powerPreference: 'high-performance' })
    || canvas.getContext('experimental-webgl', { antialias: true });
  if (!gl) return null;

  const maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048;
  const anisoExt = gl.getExtension('EXT_texture_filter_anisotropic')
    || gl.getExtension('MOZ_EXT_texture_filter_anisotropic')
    || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
  const maxAniso = anisoExt ? Math.min(8, gl.getParameter(anisoExt.MAX_TEXTURE_FILTER_ANISOTROPIC_EXT) || 1) : 1;

  const saveData = Boolean(typeof navigator !== 'undefined' && navigator.connection?.saveData);
  const lowMemory = Boolean(typeof navigator !== 'undefined' && navigator.deviceMemory && navigator.deviceMemory <= 2);
  const preferLow = maxTexSize < 2048 || saveData || lowMemory;
  const allow4k = maxTexSize >= 4096 && !preferLow;

  const skyProg = createProgram(gl, SKY_VS, SKY_FS);
  const bodyProg = createProgram(gl, BODY_VS, BODY_FS);
  const ringProg = createProgram(gl, RING_VS, RING_FS);
  const coronaProg = createProgram(gl, CORONA_VS, CORONA_FS);
  const lineProg = createProgram(gl, LINE_VS, LINE_FS);
  const pointProg = createProgram(gl, POINT_VS, POINT_FS);

  // Two LOD sphere meshes (both safely below 16-bit Uint16Array 65,535 vertex limit)
  const highSphere = createSphereMesh(gl, 96, 128);
  const medSphere = createSphereMesh(gl, 48, 64);
  const ring = createRingMesh(gl);
  const quad = createQuadMesh(gl);
  const lineBuf = gl.createBuffer();
  const pointBuf = gl.createBuffer();

  const bodyLocations = {
    aPos: gl.getAttribLocation(bodyProg, 'aPos'),
    aNorm: gl.getAttribLocation(bodyProg, 'aNorm'),
    aTan: gl.getAttribLocation(bodyProg, 'aTan'),
    aUv: gl.getAttribLocation(bodyProg, 'aUv'),
    uViewProj: gl.getUniformLocation(bodyProg, 'uViewProj'),
    uEyePos: gl.getUniformLocation(bodyProg, 'uEyePos'),
    uTime: gl.getUniformLocation(bodyProg, 'uTime'),
    uTex: gl.getUniformLocation(bodyProg, 'uTex'),
    uNormalTex: gl.getUniformLocation(bodyProg, 'uNormalTex'),
    uSpecTex: gl.getUniformLocation(bodyProg, 'uSpecTex'),
    uCloudTex: gl.getUniformLocation(bodyProg, 'uCloudTex'),
    uNightTex: gl.getUniformLocation(bodyProg, 'uNightTex'),
    uHasDetailMaps: gl.getUniformLocation(bodyProg, 'uHasDetailMaps'),
    uHasRing: gl.getUniformLocation(bodyProg, 'uHasRing'),
    uCenter: gl.getUniformLocation(bodyProg, 'uCenter'),
    uRadius: gl.getUniformLocation(bodyProg, 'uRadius'),
    uSpin: gl.getUniformLocation(bodyProg, 'uSpin'),
    uTilt: gl.getUniformLocation(bodyProg, 'uTilt'),
    uType: gl.getUniformLocation(bodyProg, 'uType'),
    uActive: gl.getUniformLocation(bodyProg, 'uActive'),
    uAtmoColor: gl.getUniformLocation(bodyProg, 'uAtmoColor'),
    uSurfaceTint: gl.getUniformLocation(bodyProg, 'uSurfaceTint')
  };

  const skyLoc = {
    aPos: gl.getAttribLocation(skyProg, 'aPos'),
    uRes: gl.getUniformLocation(skyProg, 'uRes'),
    uYaw: gl.getUniformLocation(skyProg, 'uYaw'),
    uPitch: gl.getUniformLocation(skyProg, 'uPitch'),
    uTime: gl.getUniformLocation(skyProg, 'uTime')
  };
  const lineLoc = {
    aPos: gl.getAttribLocation(lineProg, 'aPos'),
    aCol: gl.getAttribLocation(lineProg, 'aCol'),
    uViewProj: gl.getUniformLocation(lineProg, 'uViewProj')
  };
  const pointLoc = {
    aPos: gl.getAttribLocation(pointProg, 'aPos'),
    aSize: gl.getAttribLocation(pointProg, 'aSize'),
    aAlpha: gl.getAttribLocation(pointProg, 'aAlpha'),
    uViewProj: gl.getUniformLocation(pointProg, 'uViewProj')
  };
  const ringLoc = {
    aPos: gl.getAttribLocation(ringProg, 'aPos'),
    uViewProj: gl.getUniformLocation(ringProg, 'uViewProj'),
    uEyePos: gl.getUniformLocation(ringProg, 'uEyePos'),
    uRingTex: gl.getUniformLocation(ringProg, 'uRingTex'),
    uHasRingTex: gl.getUniformLocation(ringProg, 'uHasRingTex'),
    uCenter: gl.getUniformLocation(ringProg, 'uCenter'),
    uRadius: gl.getUniformLocation(ringProg, 'uRadius'),
    uTilt: gl.getUniformLocation(ringProg, 'uTilt'),
    uRingColor: gl.getUniformLocation(ringProg, 'uRingColor')
  };
  const coronaLoc = {
    aPos: gl.getAttribLocation(coronaProg, 'aPos'),
    uViewProj: gl.getUniformLocation(coronaProg, 'uViewProj'),
    uCenter: gl.getUniformLocation(coronaProg, 'uCenter'),
    uCamRight: gl.getUniformLocation(coronaProg, 'uCamRight'),
    uCamUp: gl.getUniformLocation(coronaProg, 'uCamUp'),
    uSize: gl.getUniformLocation(coronaProg, 'uSize'),
    uTime: gl.getUniformLocation(coronaProg, 'uTime'),
    uReduced: gl.getUniformLocation(coronaProg, 'uReduced'),
    uPulse: gl.getUniformLocation(coronaProg, 'uPulse')
  };

  let disposed = false;
  const onContextLost = event => { event.preventDefault(); };
  canvas.addEventListener('webglcontextlost', onContextLost);

  const textureCache = new Map();
  const loadingState = new Map();
  const loadedUrls = new Set();
  const failedUrls = new Set();

  function uploadTexture(url, tex, clampS = false) {
    if (!url || disposed || gl.isContextLost() || loadingState.has(url)) return tex;
    loadingState.set(url, 'loading');
    const img = new Image();
    img.onload = () => {
      if (disposed || gl.isContextLost()) return;
      const size=fitTextureDimensions(img.naturalWidth,img.naturalHeight,maxTexSize);
      let pixels=img;
      if(size.width!==img.naturalWidth||size.height!==img.naturalHeight){
        const resized=document.createElement('canvas');resized.width=size.width;resized.height=size.height;
        const ctx=resized.getContext('2d');
        if(!ctx){loadingState.set(url,'error');failedUrls.add(url);return;}
        ctx.drawImage(img,0,0,size.width,size.height);pixels=resized;
      }
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, clampS ? gl.CLAMP_TO_EDGE : gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (isPOT(size.width) && isPOT(size.height)) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.generateMipmap(gl.TEXTURE_2D);
        if (anisoExt && maxAniso > 1) {
          gl.texParameterf(gl.TEXTURE_2D, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, maxAniso);
        }
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      }
      loadingState.set(url, 'ready');
      loadedUrls.add(url);
    };
    img.onerror = () => {
      if (disposed) return;
      loadingState.set(url, 'error');
      failedUrls.add(url);
    };
    img.src = url;
    return tex;
  }

  function getLazyTexture(url, fallbackRgba, clampS = false) {
    if (!textureCache.has(url)) {
      const tex = createSolidTexture(gl, fallbackRgba);
      textureCache.set(url, tex);
      uploadTexture(url, tex, clampS);
    }
    return { tex: textureCache.get(url), ready: loadingState.get(url) === 'ready' };
  }

  const baseTextures = {};
  const hd4kTextures = {};
  const fallbackFlatNormal = createSolidTexture(gl, [128, 128, 255, 255]);
  const fallbackDark = createSolidTexture(gl, [0, 0, 0, 255]);

  function ensureBaseTexture(type) {
    if (!baseTextures[type]) {
      const spec = BASE_TEXTURE_URLS[type] ?? BASE_TEXTURE_URLS[2];
      const url = preferLow ? spec.low : spec.hd;
      const tex = createSolidTexture(gl, spec.fallback);
      baseTextures[type] = { tex, url };
      uploadTexture(url, tex, false);
    }
    return baseTextures[type];
  }

  function resolveBodyTexture(type, want4k) {
    const base = ensureBaseTexture(type);
    const spec = BASE_TEXTURE_URLS[type];
    if (want4k && allow4k && spec?.hd4k) {
      if (!hd4kTextures[type]) {
        const tex4k = createSolidTexture(gl, spec.fallback);
        hd4kTextures[type] = tex4k;
        uploadTexture(spec.hd4k, tex4k, false);
      }
      if (loadingState.get(spec.hd4k) === 'ready') {
        return hd4kTextures[type];
      }
    }
    return base.tex;
  }

  function bindSphereBuffers(sphereMesh) {
    gl.bindBuffer(gl.ARRAY_BUFFER, sphereMesh.posBuf);
    gl.enableVertexAttribArray(bodyLocations.aPos);
    gl.vertexAttribPointer(bodyLocations.aPos, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, sphereMesh.normBuf);
    gl.enableVertexAttribArray(bodyLocations.aNorm);
    gl.vertexAttribPointer(bodyLocations.aNorm, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, sphereMesh.tanBuf);
    gl.enableVertexAttribArray(bodyLocations.aTan);
    gl.vertexAttribPointer(bodyLocations.aTan, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, sphereMesh.uvBuf);
    gl.enableVertexAttribArray(bodyLocations.aUv);
    gl.vertexAttribPointer(bodyLocations.aUv, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sphereMesh.idxBuf);
  }

  let activeBoundMesh = null;

  return {
    gl,
    dispose() {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener('webglcontextlost', onContextLost);
      if (!gl.isContextLost()) {
        for (const tex of textureCache.values()) gl.deleteTexture(tex);
        gl.deleteTexture(fallbackFlatNormal);
        gl.deleteTexture(fallbackDark);
        for (const mesh of [highSphere, medSphere]) {
          gl.deleteBuffer(mesh.posBuf);
          gl.deleteBuffer(mesh.normBuf);
          gl.deleteBuffer(mesh.tanBuf);
          gl.deleteBuffer(mesh.uvBuf);
          gl.deleteBuffer(mesh.idxBuf);
        }
        gl.deleteBuffer(ring.posBuf);
        gl.deleteBuffer(ring.idxBuf);
        gl.deleteBuffer(quad);
        gl.deleteBuffer(lineBuf);
        gl.deleteBuffer(pointBuf);
        for (const prog of [skyProg, bodyProg, ringProg, coronaProg, lineProg, pointProg]) gl.deleteProgram(prog);
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
      textureCache.clear();
      loadingState.clear();
    },
    getCapabilities() {
      return {
        maxTexSize,
        maxAniso,
        tier: preferLow ? 'low' : allow4k ? '4k-on-demand' : '2k',
        loadedUrls: [...loadedUrls],
        failedUrls: [...failedUrls]
      };
    },
    render({ width, height, dpr, eye, viewProj, yaw, pitch, time, reducedMotion = false, showGrid, gridSegments, bodies, rings, beltPoints }) {
      if (disposed || gl.isContextLost()) return;
      const pw = Math.max(1, Math.round(width * dpr));
      const ph = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      gl.viewport(0, 0, pw, ph);
      gl.clearColor(0.004, 0.008, 0.018, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      // 1. Deep Space Skybox
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.useProgram(skyProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(skyLoc.aPos);
      gl.vertexAttribPointer(skyLoc.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(skyLoc.uRes, width, height);
      gl.uniform1f(skyLoc.uYaw, yaw);
      gl.uniform1f(skyLoc.uPitch, pitch);
      gl.uniform1f(skyLoc.uTime, reducedMotion ? 0 : time);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.disableVertexAttribArray(skyLoc.aPos);

      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      // 2. Orbit Ellipses
      if (showGrid && gridSegments.length) {
        gl.useProgram(lineProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
        gl.bufferData(gl.ARRAY_BUFFER, gridSegments, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(lineLoc.aPos);
        gl.enableVertexAttribArray(lineLoc.aCol);
        gl.vertexAttribPointer(lineLoc.aPos, 3, gl.FLOAT, false, 28, 0);
        gl.vertexAttribPointer(lineLoc.aCol, 4, gl.FLOAT, false, 28, 12);
        gl.uniformMatrix4fv(lineLoc.uViewProj, false, viewProj);
        gl.drawArrays(gl.LINES, 0, gridSegments.length / 7);
        gl.disableVertexAttribArray(lineLoc.aPos);
        gl.disableVertexAttribArray(lineLoc.aCol);
      }

      // 3. Asteroid Belt
      if (beltPoints.length) {
        gl.useProgram(pointProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, pointBuf);
        gl.bufferData(gl.ARRAY_BUFFER, beltPoints, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(pointLoc.aPos);
        gl.enableVertexAttribArray(pointLoc.aSize);
        gl.enableVertexAttribArray(pointLoc.aAlpha);
        gl.vertexAttribPointer(pointLoc.aPos, 3, gl.FLOAT, false, 20, 0);
        gl.vertexAttribPointer(pointLoc.aSize, 1, gl.FLOAT, false, 20, 12);
        gl.vertexAttribPointer(pointLoc.aAlpha, 1, gl.FLOAT, false, 20, 16);
        gl.uniformMatrix4fv(pointLoc.uViewProj, false, viewProj);
        gl.drawArrays(gl.POINTS, 0, beltPoints.length / 5);
        gl.disableVertexAttribArray(pointLoc.aPos);
        gl.disableVertexAttribArray(pointLoc.aSize);
        gl.disableVertexAttribArray(pointLoc.aAlpha);
      }

      // 4. Textured 3D Spheres (Sun, Planets, Moons)
      gl.disable(gl.BLEND);
      gl.useProgram(bodyProg);
      gl.uniformMatrix4fv(bodyLocations.uViewProj, false, viewProj);
      gl.uniform3fv(bodyLocations.uEyePos, eye);
      gl.uniform1f(bodyLocations.uTime, reducedMotion ? 0 : time);
      gl.uniform1i(bodyLocations.uTex, 0);
      gl.uniform1i(bodyLocations.uNormalTex, 1);
      gl.uniform1i(bodyLocations.uSpecTex, 2);
      gl.uniform1i(bodyLocations.uCloudTex, 3);
      gl.uniform1i(bodyLocations.uNightTex, 4);

      activeBoundMesh = null;

      // Lazy-fetch Terra detail maps only when Terra planet exists and not in low tier
      const hasTerra = bodies.some(b => b.type === 2);
      let terraMapsReady = false;
      let nMap = null, sMap = null, cMap = null, nightMap = null;
      if (hasTerra && !preferLow) {
        nMap = getLazyTexture('/textures/earth_normal.jpg', [128, 128, 255, 255]);
        sMap = getLazyTexture('/textures/earth_specular.jpg', [0, 0, 0, 255]);
        cMap = getLazyTexture('/textures/earth_clouds.jpg', [0, 0, 0, 255]);
        nightMap = getLazyTexture('/textures/earth_night.jpg', [0, 0, 0, 255]);
        terraMapsReady = nMap.ready && sMap.ready && cMap.ready && nightMap.ready;
      }

      for (const b of bodies) {
        const distToEye = Math.hypot(eye[0] - b.center[0], eye[1] - b.center[1], eye[2] - b.center[2]);
        const isClose = distToEye < b.radius * 12.0;
        const targetMesh = (b.type !== 5 || isClose) ? highSphere : medSphere;
        if (activeBoundMesh !== targetMesh) {
          bindSphereBuffers(targetMesh);
          activeBoundMesh = targetMesh;
        }

        const want4k = isClose || Boolean(b.highDetail);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, resolveBodyTexture(b.type, want4k));

        if (b.type === 2 && terraMapsReady) {
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, nMap.tex);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, sMap.tex);
          gl.activeTexture(gl.TEXTURE3);
          gl.bindTexture(gl.TEXTURE_2D, cMap.tex);
          gl.activeTexture(gl.TEXTURE4);
          gl.bindTexture(gl.TEXTURE_2D, nightMap.tex);
          gl.uniform1f(bodyLocations.uHasDetailMaps, 1.0);
        } else {
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, fallbackFlatNormal);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, fallbackDark);
          gl.activeTexture(gl.TEXTURE3);
          gl.bindTexture(gl.TEXTURE_2D, fallbackDark);
          gl.activeTexture(gl.TEXTURE4);
          gl.bindTexture(gl.TEXTURE_2D, fallbackDark);
          gl.uniform1f(bodyLocations.uHasDetailMaps, 0.0);
        }

        gl.uniform1f(bodyLocations.uHasRing, b.hasRing ? 1.0 : 0.0);
        gl.uniform3fv(bodyLocations.uCenter, b.center);
        gl.uniform1f(bodyLocations.uRadius, b.radius);
        gl.uniform1f(bodyLocations.uSpin, b.spin);
        gl.uniform1f(bodyLocations.uTilt, b.tilt);
        gl.uniform1i(bodyLocations.uType, b.type);
        gl.uniform1f(bodyLocations.uActive, b.active ? 1.0 : 0.0);
        gl.uniform3fv(bodyLocations.uAtmoColor, b.atmoColor);
        gl.uniform3fv(bodyLocations.uSurfaceTint, b.surfaceTint ?? [1, 1, 1]);
        gl.drawElements(gl.TRIANGLES, targetMesh.count, gl.UNSIGNED_SHORT, 0);
      }

      gl.disableVertexAttribArray(bodyLocations.aPos);
      gl.disableVertexAttribArray(bodyLocations.aNorm);
      gl.disableVertexAttribArray(bodyLocations.aTan);
      gl.disableVertexAttribArray(bodyLocations.aUv);

      // 5. Planetary Rings with radial texture alpha and sunlight scattering
      if (rings.length) {
        const ringMap = !preferLow ? getLazyTexture('/textures/saturn_ring.png', [214, 194, 158, 200], true) : null;
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        gl.useProgram(ringProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, ring.posBuf);
        gl.enableVertexAttribArray(ringLoc.aPos);
        gl.vertexAttribPointer(ringLoc.aPos, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ring.idxBuf);
        gl.uniformMatrix4fv(ringLoc.uViewProj, false, viewProj);
        gl.uniform3fv(ringLoc.uEyePos, eye);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, ringMap?.ready ? ringMap.tex : fallbackDark);
        gl.uniform1i(ringLoc.uRingTex, 0);
        gl.uniform1f(ringLoc.uHasRingTex, ringMap?.ready ? 1.0 : 0.0);
        for (const r of rings) {
          gl.uniform3fv(ringLoc.uCenter, r.center);
          gl.uniform1f(ringLoc.uRadius, r.radius);
          gl.uniform1f(ringLoc.uTilt, r.tilt);
          gl.uniform3fv(ringLoc.uRingColor, r.color);
          gl.drawElements(gl.TRIANGLES, ring.count, gl.UNSIGNED_SHORT, 0);
        }
        gl.disableVertexAttribArray(ringLoc.aPos);
        gl.depthMask(true);
      }

      // 6. Sun Corona Glow (soft atmospheric corona that keeps planets/HUD readable)
      const sunBody = bodies[0];
      if (sunBody && sunBody.type === 0) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.depthMask(false);
        gl.useProgram(coronaProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.enableVertexAttribArray(coronaLoc.aPos);
        gl.vertexAttribPointer(coronaLoc.aPos, 2, gl.FLOAT, false, 0, 0);

        let fx = -eye[0], fy = -eye[1], fz = -eye[2];
        const fl = Math.hypot(fx, fy, fz) || 1;
        fx /= fl; fy /= fl; fz /= fl;
        let rx = -fz, ry = 0, rz = fx;
        const rl = Math.hypot(rx, ry, rz) || 1;
        rx /= rl; ry /= rl; rz /= rl;
        const ux = fy * rz - fz * ry;
        const uy = fz * rx - fx * rz;
        const uz = fx * ry - fy * rx;

        gl.uniformMatrix4fv(coronaLoc.uViewProj, false, viewProj);
        gl.uniform3fv(coronaLoc.uCenter, sunBody.center);
        gl.uniform3f(coronaLoc.uCamRight, rx, ry, rz);
        gl.uniform3f(coronaLoc.uCamUp, ux, uy, uz);
        gl.uniform1f(coronaLoc.uSize, sunBody.radius * 3.45);
        gl.uniform1f(coronaLoc.uTime, reducedMotion ? 0 : time);
        gl.uniform1f(coronaLoc.uReduced, reducedMotion ? 1.0 : 0.0);
        gl.uniform1f(coronaLoc.uPulse, (!reducedMotion && sunBody.active) ? 0.5 + 0.5 * Math.sin(time * 3.2) : 0.0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.disableVertexAttribArray(coronaLoc.aPos);
        gl.depthMask(true);
      }
    }
  };
}
