// WebGL1 3D Solar System renderer with equirectangular planetary textures,
// relief bump shading, atmospheric scattering, 3D rings with shadow, and Milky Way sky.

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
  gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`Program link error: ${gl.getProgramInfoLog(prog)}`);
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

  // Pitch-dark NASA Eyes style deep cosmos
  vec3 col = vec3(0.004, 0.008, 0.018);

  // Subtle Milky Way galactic band
  float plane = abs(dot(dir, normalize(vec3(0.32, 0.86, -0.40))));
  float band = exp(-plane * 8.0);
  float dust = fbm(dir * 5.2 + vec3(1.4, 0.6, 2.3));
  float rift = smoothstep(0.42, 0.75, fbm(dir * 12.0 + vec3(4.0)));
  vec3 milky = mix(vec3(0.025, 0.045, 0.095), vec3(0.09, 0.08, 0.14), dust);
  col += milky * band * (0.35 + 0.65 * (1.0 - rift * 0.7));

  // Crisp pinpoint starfields
  vec3 g1 = floor(dir * 290.0);
  float h1 = hash3(g1);
  if (h1 > 0.9925) {
    vec3 cell = fract(dir * 290.0) - 0.5;
    float d = length(cell);
    float twinkle = 0.82 + 0.18 * sin(uTime * 1.9 + h1 * 90.0);
    float star = smoothstep(0.30, 0.02, d) * twinkle;
    vec3 starCol = mix(vec3(0.75, 0.88, 1.0), vec3(1.0, 0.88, 0.72), fract(h1 * 137.3));
    col += starCol * star * 0.95;
  }

  vec3 g2 = floor(dir * 135.0);
  float h2 = hash3(g2 + vec3(19.0));
  if (h2 > 0.9972) {
    vec3 cell = fract(dir * 135.0) - 0.5;
    float d = length(cell);
    float star = smoothstep(0.30, 0.01, d);
    vec3 starCol = mix(vec3(0.70, 0.86, 1.0), vec3(1.0, 0.94, 0.84), fract(h2 * 53.1));
    col += starCol * star * 1.25;
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

const BODY_VS = `
attribute vec3 aPos;
attribute vec3 aNorm;
attribute vec2 aUv;
uniform mat4 uViewProj;
uniform vec3 uCenter;
uniform float uRadius;
uniform float uSpin;
uniform float uTilt;
varying vec3 vWorldPos;
varying vec3 vWorldNorm;
varying vec3 vTangent;
varying vec2 vUv;

void main() {
  float ct = cos(uTilt), st = sin(uTilt);
  float cs = cos(uSpin), ss = sin(uSpin);

  vec3 p = vec3(aPos.x * cs + aPos.z * ss, aPos.y, -aPos.x * ss + aPos.z * cs);
  vec3 n = vec3(aNorm.x * cs + aNorm.z * ss, aNorm.y, -aNorm.x * ss + aNorm.z * cs);
  vec3 t = vec3(-aPos.z, 0.0, aPos.x);
  t = vec3(t.x * cs + t.z * ss, t.y, -t.x * ss + t.z * cs);

  vec3 wp = vec3(p.x * ct - p.y * st, p.x * st + p.y * ct, p.z);
  vec3 wn = vec3(n.x * ct - n.y * st, n.x * st + n.y * ct, n.z);
  vec3 wt = vec3(t.x * ct - t.y * st, t.x * st + t.y * ct, t.z);

  vUv = aUv;
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
varying vec2 vUv;

uniform sampler2D uTex;
uniform vec3 uEyePos;
uniform int uType;       // 0=sun, 1=gas, 2=terra, 3=ice, 4=exo, 5=moon
uniform float uTime;
uniform float uActive;
uniform vec3 uAtmoColor;

float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec3 N = normalize(vWorldNorm);
  vec3 V = normalize(uEyePos - vWorldPos);
  float ndv = max(dot(N, V), 0.0);

  if (uType == 0) {
    // Real textured Sun photosphere with gentle dual-layer plasma drift & limb darkening
    vec2 uv1 = vec2(vUv.x + uTime * 0.005, vUv.y);
    vec2 uv2 = vec2(vUv.x - uTime * 0.003, vUv.y + 0.02 * sin(uTime * 0.2));
    vec3 t1 = texture2D(uTex, uv1).rgb;
    vec3 t2 = texture2D(uTex, uv2).rgb;
    vec3 plasma = mix(t1, t2, 0.35);

    float limb = pow(ndv, 0.45);
    vec3 col = plasma * (0.62 + 0.70 * limb);
    // Hot white core boost + incandescent orange chromosphere edge
    col += vec3(1.0, 0.92, 0.68) * pow(ndv, 2.5) * 0.28;
    col += vec3(1.0, 0.38, 0.06) * pow(1.0 - ndv, 2.6) * 0.65;
    gl_FragColor = vec4(col, 1.0);
    return;
  }

  vec3 texCol = texture2D(uTex, vUv).rgb;

  // Tangent-space relief bump from texture luminance (makes craters & mountains pop near terminator!)
  float eps = 0.0022;
  float hL = lum(texture2D(uTex, vUv - vec2(eps, 0.0)).rgb);
  float hR = lum(texture2D(uTex, vUv + vec2(eps, 0.0)).rgb);
  float hD = lum(texture2D(uTex, vUv - vec2(0.0, eps)).rgb);
  float hU = lum(texture2D(uTex, vUv + vec2(0.0, eps)).rgb);

  vec3 T = normalize(vTangent);
  vec3 B = normalize(cross(N, T));
  float bumpStrength = (uType == 5) ? 1.85 : (uType == 2 || uType == 4) ? 0.95 : 0.28;
  vec3 Nbump = normalize(N + T * ((hL - hR) * bumpStrength) + B * ((hD - hU) * bumpStrength));

  vec3 L = normalize(-vWorldPos); // Light from Sun at (0,0,0)
  float ndl = dot(Nbump, L);
  float diff = smoothstep(-0.05, 0.88, ndl);
  float fresnel = pow(1.0 - ndv, 3.4);

  // Specular glint on oceans (Earth & Exoplanet)
  float spec = 0.0;
  if (uType == 2 || uType == 4) {
    float waterMask = smoothstep(0.02, 0.16, texCol.b - max(texCol.r, texCol.g * 0.92));
    vec3 H = normalize(L + V);
    spec = pow(max(dot(N, H), 0.0), 42.0) * waterMask * 0.55;
  }

  vec3 ambient = texCol * 0.07;
  float twilight = exp(-abs(ndl) * 14.0) * (uType == 5 ? 0.02 : 0.14);
  vec3 day = texCol * (1.04 * diff) + vec3(spec) * diff;
  vec3 atmo = uAtmoColor * fresnel * (0.20 + 0.92 * max(diff, 0.06)) * (uType == 5 ? 0.25 : 1.0);
  if (uActive > 0.5) {
    atmo += vec3(0.35, 0.92, 1.0) * fresnel * 0.42;
  }

  gl_FragColor = vec4(ambient + day + uAtmoColor * twilight + atmo, 1.0);
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
uniform vec3 uCenter;
uniform float uRadius;
uniform vec3 uRingColor;

void main() {
  float r = length(vRingPos);
  if (r < 1.32 || r > 2.45) discard;
  float t = (r - 1.32) / (2.45 - 1.32);

  float ringlets = 0.55 + 0.45 * sin(t * 110.0) * sin(t * 41.0);
  float cassini = smoothstep(0.028, 0.075, abs(t - 0.62));
  float encke = smoothstep(0.012, 0.032, abs(t - 0.87));
  float innerFade = smoothstep(0.0, 0.12, t);
  float outerFade = 1.0 - smoothstep(0.84, 1.0, t);
  float alpha = ringlets * cassini * encke * innerFade * outerFade * 0.74;

  vec3 sunDir = normalize(-uCenter);
  vec3 rel = vWorldPos - uCenter;
  float proj = dot(rel, sunDir);
  float perp = length(rel - sunDir * proj);
  float inShadow = (proj < 0.0) ? smoothstep(uRadius * 0.85, uRadius * 1.06, perp) : 1.0;

  vec3 col = uRingColor * (0.24 + 0.88 * inShadow);
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

void main() {
  float d = length(vUv);
  if (d > 1.0) discard;
  float ang = atan(vUv.y, vUv.x);
  float rays = 0.90 + 0.10 * sin(ang * 8.0 + uTime * 0.8) * cos(ang * 5.0 - uTime * 0.5);
  float glow = exp(-d * 4.2) * rays * (0.90 + 0.14 * uPulse);
  float inner = exp(-d * 10.5) * 0.85;
  vec3 col = vec3(1.0, 0.64, 0.22) * glow + vec3(1.0, 0.94, 0.74) * inner;
  gl_FragColor = vec4(col, clamp(glow + inner, 0.0, 1.0));
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

function createSphereMesh(gl, latBands = 48, lonBands = 64) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  for (let lat = 0; lat <= latBands; lat++) {
    const v = lat / latBands;
    const theta = v * Math.PI;
    const sinT = Math.sin(theta), cosT = Math.cos(theta);
    for (let lon = 0; lon <= lonBands; lon++) {
      const u = lon / lonBands;
      const phi = u * 2 * Math.PI;
      const x = Math.cos(phi) * sinT;
      const y = cosT;
      const z = Math.sin(phi) * sinT;
      positions.push(x, y, z);
      normals.push(x, y, z);
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
    uvBuf: makeBuf(uvs),
    idxBuf: makeBuf(indices, gl.ELEMENT_ARRAY_BUFFER, Uint16Array),
    count: indices.length
  };
}

function createRingMesh(gl, segments = 112) {
  const positions = [];
  const indices = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    positions.push(ca * 1.32, 0, sa * 1.32);
    positions.push(ca * 2.45, 0, sa * 2.45);
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
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  return buf;
}

function loadTexture(gl, url, fallbackRgb) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([...fallbackRgb, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const img = new Image();
  img.onload = () => {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
  };
  img.src = url;
  return tex;
}

export function createSolarGL(canvas) {
  const gl = canvas.getContext('webgl', { antialias: true, alpha: false, powerPreference: 'high-performance' })
    || canvas.getContext('experimental-webgl', { antialias: true });
  if (!gl) return null;

  const skyProg = createProgram(gl, SKY_VS, SKY_FS);
  const bodyProg = createProgram(gl, BODY_VS, BODY_FS);
  const ringProg = createProgram(gl, RING_VS, RING_FS);
  const coronaProg = createProgram(gl, CORONA_VS, CORONA_FS);
  const lineProg = createProgram(gl, LINE_VS, LINE_FS);
  const pointProg = createProgram(gl, POINT_VS, POINT_FS);

  const sphere = createSphereMesh(gl);
  const ring = createRingMesh(gl);
  const quad = createQuadMesh(gl);
  const lineBuf = gl.createBuffer();
  const pointBuf = gl.createBuffer();

  const textures = {
    0: loadTexture(gl, '/textures/sun.jpg', [255, 190, 75]),
    1: loadTexture(gl, '/textures/gas_giant.jpg', [214, 158, 102]),
    2: loadTexture(gl, '/textures/earth_day.jpg', [46, 118, 188]),
    3: loadTexture(gl, '/textures/ice_giant.jpg', [62, 118, 214]),
    4: loadTexture(gl, '/textures/exo_planet.jpg', [58, 164, 134]),
    5: loadTexture(gl, '/textures/moon.jpg', [165, 170, 178])
  };

  return {
    gl,
    render({ width, height, dpr, eye, viewProj, yaw, pitch, time, showGrid, gridSegments, bodies, rings, beltPoints }) {
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
      const skyPos = gl.getAttribLocation(skyProg, 'aPos');
      gl.enableVertexAttribArray(skyPos);
      gl.vertexAttribPointer(skyPos, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(gl.getUniformLocation(skyProg, 'uRes'), width, height);
      gl.uniform1f(gl.getUniformLocation(skyProg, 'uYaw'), yaw);
      gl.uniform1f(gl.getUniformLocation(skyProg, 'uPitch'), pitch);
      gl.uniform1f(gl.getUniformLocation(skyProg, 'uTime'), time);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      // 2. Crisp NASA-style Orbit Ellipses
      if (showGrid && gridSegments.length) {
        gl.useProgram(lineProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
        gl.bufferData(gl.ARRAY_BUFFER, gridSegments, gl.DYNAMIC_DRAW);
        const lPos = gl.getAttribLocation(lineProg, 'aPos');
        const lCol = gl.getAttribLocation(lineProg, 'aCol');
        gl.enableVertexAttribArray(lPos);
        gl.enableVertexAttribArray(lCol);
        gl.vertexAttribPointer(lPos, 3, gl.FLOAT, false, 28, 0);
        gl.vertexAttribPointer(lCol, 4, gl.FLOAT, false, 28, 12);
        gl.uniformMatrix4fv(gl.getUniformLocation(lineProg, 'uViewProj'), false, viewProj);
        gl.drawArrays(gl.LINES, 0, gridSegments.length / 7);
      }

      // 3. Asteroid Belt
      if (beltPoints.length) {
        gl.useProgram(pointProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, pointBuf);
        gl.bufferData(gl.ARRAY_BUFFER, beltPoints, gl.DYNAMIC_DRAW);
        const pPos = gl.getAttribLocation(pointProg, 'aPos');
        const pSize = gl.getAttribLocation(pointProg, 'aSize');
        const pAlpha = gl.getAttribLocation(pointProg, 'aAlpha');
        gl.enableVertexAttribArray(pPos);
        gl.enableVertexAttribArray(pSize);
        gl.enableVertexAttribArray(pAlpha);
        gl.vertexAttribPointer(pPos, 3, gl.FLOAT, false, 20, 0);
        gl.vertexAttribPointer(pSize, 1, gl.FLOAT, false, 20, 12);
        gl.vertexAttribPointer(pAlpha, 1, gl.FLOAT, false, 20, 16);
        gl.uniformMatrix4fv(gl.getUniformLocation(pointProg, 'uViewProj'), false, viewProj);
        gl.drawArrays(gl.POINTS, 0, beltPoints.length / 5);
      }

      // 4. Textured 3D Spheres (Sun, Planets, Moons)
      gl.disable(gl.BLEND);
      gl.useProgram(bodyProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, sphere.posBuf);
      const bPos = gl.getAttribLocation(bodyProg, 'aPos');
      gl.enableVertexAttribArray(bPos);
      gl.vertexAttribPointer(bPos, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, sphere.normBuf);
      const bNorm = gl.getAttribLocation(bodyProg, 'aNorm');
      gl.enableVertexAttribArray(bNorm);
      gl.vertexAttribPointer(bNorm, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, sphere.uvBuf);
      const bUv = gl.getAttribLocation(bodyProg, 'aUv');
      gl.enableVertexAttribArray(bUv);
      gl.vertexAttribPointer(bUv, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sphere.idxBuf);
      gl.uniformMatrix4fv(gl.getUniformLocation(bodyProg, 'uViewProj'), false, viewProj);
      gl.uniform3fv(gl.getUniformLocation(bodyProg, 'uEyePos'), eye);
      gl.uniform1f(gl.getUniformLocation(bodyProg, 'uTime'), time);
      gl.uniform1i(gl.getUniformLocation(bodyProg, 'uTex'), 0);

      for (const b of bodies) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, textures[b.type] ?? textures[2]);
        gl.uniform3fv(gl.getUniformLocation(bodyProg, 'uCenter'), b.center);
        gl.uniform1f(gl.getUniformLocation(bodyProg, 'uRadius'), b.radius);
        gl.uniform1f(gl.getUniformLocation(bodyProg, 'uSpin'), b.spin);
        gl.uniform1f(gl.getUniformLocation(bodyProg, 'uTilt'), b.tilt);
        gl.uniform1i(gl.getUniformLocation(bodyProg, 'uType'), b.type);
        gl.uniform1f(gl.getUniformLocation(bodyProg, 'uActive'), b.active ? 1.0 : 0.0);
        gl.uniform3fv(gl.getUniformLocation(bodyProg, 'uAtmoColor'), b.atmoColor);
        gl.drawElements(gl.TRIANGLES, sphere.count, gl.UNSIGNED_SHORT, 0);
      }

      // 5. Planetary Rings
      if (rings.length) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        gl.useProgram(ringProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, ring.posBuf);
        const rPos = gl.getAttribLocation(ringProg, 'aPos');
        gl.enableVertexAttribArray(rPos);
        gl.vertexAttribPointer(rPos, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ring.idxBuf);
        gl.uniformMatrix4fv(gl.getUniformLocation(ringProg, 'uViewProj'), false, viewProj);
        for (const r of rings) {
          gl.uniform3fv(gl.getUniformLocation(ringProg, 'uCenter'), r.center);
          gl.uniform1f(gl.getUniformLocation(ringProg, 'uRadius'), r.radius);
          gl.uniform1f(gl.getUniformLocation(ringProg, 'uTilt'), r.tilt);
          gl.uniform3fv(gl.getUniformLocation(ringProg, 'uRingColor'), r.color);
          gl.drawElements(gl.TRIANGLES, ring.count, gl.UNSIGNED_SHORT, 0);
        }
        gl.depthMask(true);
      }

      // 6. Sun Corona Glow
      const sunBody = bodies[0];
      if (sunBody && sunBody.type === 0) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.depthMask(false);
        gl.useProgram(coronaProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        const cPos = gl.getAttribLocation(coronaProg, 'aPos');
        gl.enableVertexAttribArray(cPos);
        gl.vertexAttribPointer(cPos, 2, gl.FLOAT, false, 0, 0);

        let fx = -eye[0], fy = -eye[1], fz = -eye[2];
        const fl = Math.hypot(fx, fy, fz) || 1;
        fx /= fl; fy /= fl; fz /= fl;
        let rx = -fz, ry = 0, rz = fx;
        const rl = Math.hypot(rx, ry, rz) || 1;
        rx /= rl; ry /= rl; rz /= rl;
        const ux = fy * rz - fz * ry;
        const uy = fz * rx - fx * rz;
        const uz = fx * ry - fy * rx;

        gl.uniformMatrix4fv(gl.getUniformLocation(coronaProg, 'uViewProj'), false, viewProj);
        gl.uniform3fv(gl.getUniformLocation(coronaProg, 'uCenter'), sunBody.center);
        gl.uniform3f(gl.getUniformLocation(coronaProg, 'uCamRight'), rx, ry, rz);
        gl.uniform3f(gl.getUniformLocation(coronaProg, 'uCamUp'), ux, uy, uz);
        gl.uniform1f(gl.getUniformLocation(coronaProg, 'uSize'), sunBody.radius * 3.6);
        gl.uniform1f(gl.getUniformLocation(coronaProg, 'uTime'), time);
        gl.uniform1f(gl.getUniformLocation(coronaProg, 'uPulse'), sunBody.active ? 0.5 + 0.5 * Math.sin(time * 3.5) : 0.0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.depthMask(true);
      }
    }
  };
}
