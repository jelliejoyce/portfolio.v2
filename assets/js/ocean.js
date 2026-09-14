/*!
 * ocean.js — physically-based underwater renderer (WebGL 1)
 * -----------------------------------------------------------------------------
 * A fullscreen fragment shader renders a continuous water column: sky and sea
 * surface from above, Snell's window below it, then the reef and the seabed at
 * 40 m. Page scroll drives camera depth, so scrolling the site *is* the dive.
 *
 * WHAT MAKES IT LOOK REAL
 *
 *   Surface caustics  Rendered once per frame into a tileable 256² texture,
 *                     then reused by the seabed, the underside of the surface
 *                     and the light shafts — so every highlight is coherent.
 *
 *   God rays          Not a screen-space effect. The view ray is integrated
 *                     through the water; at every sample the sunbeam is traced
 *                     back up to the surface and the caustic texture gives how
 *                     strongly the waves focus light there. Sunlight is
 *                     refracted on entry (18 deg of air elevation becomes
 *                     ~44 deg in water), which throws the point where all
 *                     shafts converge off the top of the frame at every
 *                     depth — so you see the shafts crossing the water and
 *                     never the starburst they radiate from.
 *
 *   Marine snow       Camera-anchored layers, gaussian-soft, sized by
 *                     perspective, attenuated by real extinction — near flecks
 *                     are fat and faint, distant ones vanish into the water.
 *
 *   Fish              Fusiform silhouette with dorsal, anal and forked caudal
 *                     fins, body undulation, and heavy water fog so they read
 *                     as shapes passing in the blue rather than stickers.
 *
 * Optics: Jerlov coastal water — separate beam attenuation (SIGMA), scattering
 * albedo (SCAT) and Lambertian surface shading (shadeLit).
 *
 * API: Ocean.mount(canvas, opts) -> { setProgress, setDepth, destroy, depth }
 * Optional URL overrides for tuning: ?rays=0.5&snow=1&fish=0&depth=12
 */
(function (global) {
  'use strict';

  /* ==========================================================================
     SHADERS
     ========================================================================== */

  var VERT_SRC = [
    'attribute vec2 aPos;',
    'void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }'
  ].join('\n');

  /* ---- shared GLSL chunks ------------------------------------------------- */
  var GLSL_COMMON = [
    'precision highp float;',
    '#define PI 3.14159265',
    '#define TAU 6.28318531',
    '',
    'float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }',
    'float hash21(vec2 p){',
    '  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));',
    '  q += dot(q, q.yzx + 33.33);',
    '  return fract((q.x + q.y) * q.z);',
    '}',
    'float vnoise(vec2 p){',
    '  vec2 i = floor(p), f = fract(p);',
    '  vec2 u = f*f*(3.0 - 2.0*f);',
    '  float a = hash21(i);',
    '  float b = hash21(i + vec2(1.0, 0.0));',
    '  float c = hash21(i + vec2(0.0, 1.0));',
    '  float d = hash21(i + vec2(1.0, 1.0));',
    '  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);',
    '}',
    'float fbm3(vec2 p){',
    '  float s = 0.5 * vnoise(p); p *= 2.03; p += 17.3;',
    '  s += 0.25 * vnoise(p);     p *= 2.01; p += 5.7;',
    '  s += 0.125 * vnoise(p);',
    '  return s * 1.1428;',
    '}',
    '',
    '/* iterated caustic web (after joltz0r) — periodic in uv, period 1 */',
    'float causticPattern(vec2 uv, float t){',
    '  vec2 p = mod(uv * TAU, TAU) - 250.0;',
    '  vec2 i = p;',
    '  float c = 1.0;',
    '  const float inten = 0.0045;',
    '  for (int n = 0; n < 5; n++){',
    '    float tt = t * (1.0 - (3.5 / float(n + 1)));',
    '    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));',
    '    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));',
    '  }',
    '  c /= 5.0;',
    '  c = 1.17 - pow(c, 1.4);',
    '  return clamp(pow(abs(c), 6.0), 0.0, 6.0);',
    '}'
  ].join('\n');

  /* ---- pass 1: bake the surface caustics into a tileable texture ---------- */
  var CAUSTIC_SRC = GLSL_COMMON + [
    '',
    'uniform float uTime;',
    'uniform vec2  uRes;',
    '',
    'void main(){',
    '  vec2 uv = gl_FragCoord.xy / uRes;',
    '  float t = uTime * 0.34;',
    '  float c1 = causticPattern(uv,        t);',
    '  float c2 = causticPattern(uv * 2.0 + 0.37, t * 0.77 + 1.7);',
    '  float c3 = causticPattern(uv * 4.0 + 0.11, t * 1.23 + 4.2);',
    '  /* slow, large-scale brightness drift so shafts breathe */',
    '  float low = 0.5 + 0.5 * sin(uv.x * TAU + t * 0.5) * sin(uv.y * TAU - t * 0.37);',
    '  float low2 = 0.5 + 0.5 * sin((uv.x + 0.37) * TAU * 2.0 - t * 0.29) *',
    '                          sin((uv.y - 0.21) * TAU * 2.0 + t * 0.23);',
    '  gl_FragColor = vec4(',
    '    clamp((c1 * 0.30 + c2 * 0.12) / 0.50, 0.0, 1.0),',
    '    clamp((c2 * 0.34 + c3 * 0.10) / 0.45, 0.0, 1.0),',
    '    low,',
    '    low2);',
    '}'
  ].join('\n');

  /* ---- pass 2: the scene --------------------------------------------------- */
  var FRAG_SRC = GLSL_COMMON + [
    '',
    'uniform vec2  uRes;',
    'uniform float uTime;',
    'uniform float uDepth;',
    'uniform float uVel;',
    'uniform vec2  uPointer;',
    'uniform float uDetail;',
    'uniform float uMotion;',
    'uniform float uDebug;    // 0 off | 1 shafts | 2 snow | 3 water only | 4 fish | 5,6 dapple | 7 bubbles',
    'uniform float uRays;     // effect intensities, 1 = default',
    'uniform float uSnow;',
    'uniform float uFish;',
    'uniform sampler2D uCaustic;',
    '',
    '#define SEABED 40.5',
    '',
    '/* ---- water optics (Jerlov coastal, type II) -------------------------- */',
    'const vec3  SIGMA  = vec3(0.550, 0.115, 0.095);  // beam attenuation 1/m',
    'const vec3  SCAT   = vec3(0.100, 0.400, 0.520);  // scattering albedo',
    'const vec3  SSK    = SCAT * 0.0795775;           // /4pi',
    'const float SUN_I  = 18.85;',
    'const vec3  DEEP   = vec3(0.019, 0.063, 0.151);',
    'const float PATHK  = 1.15;',
    'const float BROAD  = 0.050;',
    'const float BROADK = 0.070;',
    'const float FOCAL  = 1.20;                       // ~62 deg vertical fov',
    'const float CAUSC  = 0.155;                      // seabed caustics: ~6.5 m per tile',
    'const float DAPPLE = 0.026;                      // light patches: ~38 m per tile',
    'const float SHAFTC = 0.022;                      // light shafts: ~45 m per tile',
    '/* Sunlight bends towards the vertical on entering water: 18 deg of elevation in',
    '   air becomes about 44 deg below the surface (Snell, n = 1.333). Using the real',
    '   refracted direction lifts the shaft convergence well up the frame, and it is',
    '   simply the correct direction to transport light along down here. */',
    'const vec3  SUN_W  = vec3(0.465, 0.701, -0.540);',
    '',
    'vec3  gRo, gRight, gUp, gFwd, gSun, gSunW;',
    'vec2  gUV;',
    'float gT, gDepth;',
    '',
    'vec3 sRGB(vec3 c){ return pow(c, vec3(2.2)); }',
    '',
    '/* ---- radiative transfer ---------------------------------------------- */',
    'vec3 lightAt(float d){',
    '  return exp(-SIGMA * (PATHK * max(d, 0.0))) * SUN_I + DEEP;',
    '}',
    'vec3 mediumInscatter(float d){',
    '  return SSK * lightAt(d) + vec3(BROAD * exp(-max(d, 0.0) * BROADK));',
    '}',
    'float lightLevel(){ return 0.10 + exp(-max(gDepth, 0.0) * 0.075); }',
    'vec3 extinct(vec3 L, float dist, vec3 inscat){',
    '  vec3 e = exp(-SIGMA * dist);',
    '  return L * e + inscat * (1.0 - e);',
    '}',
    'vec3 shadeLit(vec3 albedo, float diff, float d){',
    '  vec3 direct = lightAt(d) * (0.25 + 0.95 * diff) * 0.31831;',
    '  return albedo * (direct + mediumInscatter(d) * 2.0);',
    '}',
    '',
    '/* ======================================================================',
    '   SURFACE TRANSMITTANCE — how hard the swell focuses sunlight at a point.',
    '   Trace from p back up to the surface along the sun and read the caustics.',
    '   ====================================================================== */',
    'vec3 causticAt(vec3 p){',
    '  vec2 s = p.xz - gSun.xz * (p.y / gSun.y);',
    '  return texture2D(uCaustic, s * CAUSC + vec2(gT * 0.010, gT * 0.006)).rgb;',
    '}',
    '/* ======================================================================',
    '   LIGHT DAPPLE — slow patches of brightness drifting through the water.',
    '   Deliberately NOT projected along the sun: anything radial converges to',
    '   a point on screen and reads as a starburst. Two smooth blob fields at',
    '   different scales give organic variation with no direction to it.',
    '   Mean 1.0, so the exposure of the water never changes.',
    '   ====================================================================== */',
    'vec3 shaftAt(vec3 p){',
    '  vec2 s = p.xz - gSunW.xz * (p.y / gSunW.y);',
    '  return texture2D(uCaustic, s * SHAFTC + vec2(gT * 0.007, gT * 0.004)).rgb;',
    '}',
    '/* Broad, gentle streaks of light. Returns the raw modulation around 1.0;',
    '   waterVolume decides how much of it to apply and where to suppress it. */',
    'float shaftFocus(vec3 p){',
    '  vec3 c = shaftAt(p);',
    '  float focus = 1.0 + (c.r - 0.175) * 2.80;',
    '  focus *= 0.90 + 0.20 * c.b;',
    '  return focus;',
    '}',
    '',
    'float dapple(vec3 p){',
    '  vec4 c = texture2D(uCaustic, p.xz * DAPPLE + vec2(p.y * 0.010, -p.y * 0.007)',
    '                     + vec2(gT * 0.0035, gT * 0.0022));',
    '  float d = 1.0 + (c.b - 0.5) * 0.34 + (c.a - 0.5) * 0.20;',
    '  float depthHere = max(0.0, -p.y);',
    '  return mix(1.0, d, clamp(exp(-depthHere * 0.045) * uRays, 0.0, 1.0));',
    '}',
    '',
    '/* ======================================================================',
    '   WATER VOLUME — single-scattering integral along the view ray.',
    '   Everything you see of the water itself, shafts included, comes out here.',
    '   ====================================================================== */',
    'vec3 waterVolume(vec3 ro, vec3 rd, float tHit, int steps){',
    '  float march = min(tHit, 30.0);',
    '  float ds    = march / float(steps);',
    '  float jitter = hash21(gl_FragCoord.xy + fract(gT) * 71.3);',
    '  float t = ds * jitter;',
    '',
    '  /* sunlight decays multiplicatively along the ray — no exp() in the loop */',
    '  vec3 sunTerm = exp(-SIGMA * (PATHK * max(-ro.y, 0.0))) * SUN_I;',
    '  vec3 sunStep = exp(-SIGMA * (PATHK * (-rd.y) * ds));',
    '  vec3 segT    = exp(-SIGMA * ds);',
    '  vec3 oneMinusSeg = vec3(1.0) - segT;',
    '',
    '  /* The one place shafts look wrong: where they all converge on the sun.',
    '     On screen that is a starburst, so the hub is faded out — the streaks',
    '     crossing the rest of the frame are all that survives. */',
    '  float toward = max(dot(rd, gSunW), 0.0);',
    '  float hub    = 1.0 - smoothstep(0.90, 0.99, toward);',
    '',
    '  vec3 vol = vec3(0.0);',
    '  vec3 trans = vec3(1.0);',
    '',
    '  for (int i = 0; i < 16; i++){',
    '    if (i >= steps) break;',
    '    vec3 p = ro + rd * t;',
    '    float focus = dapple(p);',
    '    float shaft = mix(1.0, shaftFocus(p),',
    '                      clamp(exp(-max(0.0, -p.y) * 0.050) * uRays * hub, 0.0, 1.0));',
    '    focus *= shaft;',
    '    vol   += trans * SSK * (sunTerm + DEEP) * focus * oneMinusSeg;',
    '    trans *= segT;',
    '    sunTerm *= sunStep;',
    '    t += ds;',
    '  }',
    '  /* analytic tail: everything past the march, where shafts have smoothed out */',
    '  if (tHit > march){',
    '    vol += trans * SSK * (sunTerm + DEEP);',
    '  }',
    '  return vol;',
    '}',
    '',
    '/* ======================================================================',
    '   OCEAN SURFACE',
    '   ====================================================================== */',
    'float waveH(vec2 p, float lod){',
    '  float h = 0.0, amp = 0.34, freq = 0.31;',
    '  vec2 d = vec2(0.94, 0.34);',
    '  mat2 R = mat2(0.86, 0.51, -0.51, 0.86);',
    '  for (int i = 0; i < 5; i++){',
    '    h += amp * max(0.0, 1.0 - lod * float(i) * 0.34) *',
    '         sin(dot(p, d) * freq + gT * (0.85 + 0.40 * float(i)) + float(i) * 2.1);',
    '    d = R * d; amp *= 0.60; freq *= 1.92;',
    '  }',
    '  return h;',
    '}',
    'vec3 waveN(vec2 p, float lod){',
    '  float e = 0.17;',
    '  return normalize(vec3(',
    '    waveH(p - vec2(e, 0.0), lod) - waveH(p + vec2(e, 0.0), lod),',
    '    2.0 * e,',
    '    waveH(p - vec2(0.0, e), lod) - waveH(p + vec2(0.0, e), lod)));',
    '}',
    '',
    '/* ======================================================================',
    '   SKY',
    '   ====================================================================== */',
    'vec3 skyColor(vec3 rd){',
    '  float h = max(rd.y, -0.03);',
    '  vec3 zenith  = sRGB(vec3(0.176, 0.400, 0.741));',
    '  vec3 mid     = sRGB(vec3(0.451, 0.694, 0.882));',
    '  vec3 horizon = sRGB(vec3(0.855, 0.906, 0.918));',
    '  vec3 col = mix(horizon, mid, smoothstep(0.0, 0.26, h));',
    '  col = mix(col, zenith, smoothstep(0.20, 0.95, h));',
    '  float sd = max(dot(rd, gSun), 0.0);',
    '  col += sRGB(vec3(1.0, 0.96, 0.88)) *',
    '         (pow(sd, 1500.0) * 30.0 + pow(sd, 42.0) * 0.45 + pow(sd, 6.0) * 0.11);',
    '  if (uDetail > 0.5 && rd.y > 0.006){',
    '    vec2 cp = rd.xz / (rd.y + 0.11) * 0.30 + vec2(gT * 0.006, gT * 0.0035);',
    '    float c = fbm3(cp);',
    '    float m = smoothstep(0.44, 0.80, c) * smoothstep(0.0, 0.20, rd.y);',
    '    col = mix(col, sRGB(vec3(0.97, 0.98, 1.0)) * (0.55 + 0.70 * sd), m * 0.45);',
    '  }',
    '  return col;',
    '}',
    '',
    '/* ======================================================================',
    '   SEA SURFACE SEEN FROM ABOVE',
    '   ====================================================================== */',
    'vec3 seaAbove(vec3 ro, vec3 rd){',
    '  if (rd.y > -0.0015) return skyColor(rd);',
    '  float dist = min((0.0 - ro.y) / rd.y, 8000.0);',
    '  vec3  p    = ro + rd * dist;',
    '  float haze = 1.0 - exp(-dist * 0.00055);',
    '  float lod  = clamp(dist * 0.006, 0.0, 1.0);',
    '  vec3  n    = waveN(p.xz, lod);',
    '  n = normalize(mix(vec3(0.0, 1.0, 0.0), n, clamp(1.0 - haze * 1.7, 0.10, 1.0)));',
    '  vec3  v    = -rd;',
    '  float fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 5.0);',
    '  vec3  refl = skyColor(reflect(rd, n));',
    '  vec3  body = sRGB(vec3(0.055, 0.185, 0.225));',
    '  float sss  = pow(max(dot(n, gSun), 0.0), 2.2) * 0.85 + 0.10;',
    '  float crest = smoothstep(0.10, 0.60, waveH(p.xz, lod) + 0.30) * 0.45;',
    '  vec3 col = body * (sss * 1.6 + crest);',
    '  col = mix(col, refl, fres);',
    '  vec3  hv = normalize(gSun + v);',
    '  float sd = max(dot(n, hv), 0.0);',
    '  float glit = pow(sd, 900.0) * 30.0 + pow(sd, 90.0) * 1.15 + pow(sd, 16.0) * 0.15;',
    '  col += sRGB(vec3(1.0, 0.97, 0.90)) * glit * (0.25 + 0.75 * fres) * (1.0 - haze * 0.85);',
    '  col = mix(col, sRGB(vec3(0.76, 0.85, 0.90)), haze * 0.94);',
    '  return col;',
    '}',
    '',
    '/* ======================================================================',
    '   SEABED',
    '   ====================================================================== */',
    'float sandH(vec2 p){',
    '  float h = sin(p.x * 0.85 + sin(p.y * 0.33) * 1.9) * 0.55;',
    '  h += sin(p.y * 1.15 + sin(p.x * 0.47) * 1.3) * 0.38;',
    '  h += 0.22 * sin((p.x + p.y) * 2.3);',
    '  h += (fbm3(p * 0.22) - 0.44) * 3.0;',
    '  return h * 0.15;',
    '}',
    'vec3 sandN(vec2 p){',
    '  float e = 0.10;',
    '  return normalize(vec3(sandH(p - vec2(e, 0.0)) - sandH(p + vec2(e, 0.0)),',
    '                        2.0 * e,',
    '                        sandH(p - vec2(0.0, e)) - sandH(p + vec2(0.0, e))));',
    '}',
    '/* ======================================================================',
    '   REEF FLOOR — soft coral colonies mottling the sand.',
    '   Hues are chosen to sit inside the page palette (aqua, sand, deep teal)',
    '   and are kept low-saturation: at 30+ m the water has already taken most',
    '   of the colour out, so anything vivid would read as plastic.',
    '   ====================================================================== */',
    'float coralRelief(vec2 w){ return fbm3(w * 1.15 + 3.3); }',
    '',
    'void reefFloor(vec2 w, float dcam, inout vec3 albedo, inout vec3 n){',
    '  float patch = fbm3(w * 0.085 + 4.7);',
    '  float m = smoothstep(0.34, 0.56, patch);',
    '  /* Colonies only grow on the sand close to you. Left alone they mottle the',
    '     floor all the way out to the haze line, and because that far sand sits',
    '     high in the frame the coral colour rode up with it, past the middle of',
    '     the view. Confining them keeps the colour down where the sand is. */',
    '  m *= 1.0 - smoothstep(14.0, 30.0, dcam);',
    '  if (m <= 0.002) return;',
    '  float kind = vnoise(w * 0.31 - 7.1);',
    '  /* Red is gone by 8 m, so warm corals simply cannot be seen down here.',
    '     These hues sit in the green / cyan / violet range that survives, and',
    '     they are drawn from the page palette itself - aqua, teal, deep blue. */',
    '  vec3 c1 = sRGB(vec3(0.06, 1.00, 0.30));    // vivid green -> reads green',
    '  vec3 c2 = sRGB(vec3(0.05, 0.95, 0.62));    // aqua       -> echoes the accent',
    '  vec3 c3 = sRGB(vec3(0.08, 0.88, 0.92));    // teal       -> reads cyan',
    '  vec3 c4 = sRGB(vec3(0.48, 0.28, 1.00));    // violet     -> reads deep blue',
    '  vec3 c5 = sRGB(vec3(1.00, 0.92, 0.84));    // pale       -> reads as a lit patch',
    '  vec3 tint = mix(c1, c2, smoothstep(0.16, 0.40, kind));',
    '  tint = mix(tint, c3, smoothstep(0.38, 0.58, kind));',
    '  tint = mix(tint, c4, smoothstep(0.56, 0.76, kind));',
    '  tint = mix(tint, c5, smoothstep(0.74, 0.92, kind));',
    '  albedo = mix(albedo, tint, m * 0.95);',
    '  /* colonies get real relief, so they are not just paint on the sand */',
    '  float e  = 0.22;',
    '  float h0 = coralRelief(w);',
    '  float hx = coralRelief(w + vec2(e, 0.0));',
    '  float hz = coralRelief(w + vec2(0.0, e));',
    '  /* Kept shallow on purpose: pushed any harder the colonies read as',
    '     mounds standing off the sand rather than growth on it. */',
    '  n = normalize(n + vec3(-(hx - h0), 0.0, -(hz - h0)) * m * 0.30);',
    '}',
    '',
    'vec3 seabedShade(vec3 p){',
    '  vec3  n     = sandN(p.xz);',
    '  float rockM = smoothstep(0.32, 0.46, fbm3(p.xz * 0.09 - 11.3));',
    '  vec3  albedo = sRGB(vec3(0.760, 0.720, 0.640));',
    '  albedo = mix(albedo, sRGB(vec3(0.250, 0.290, 0.310)), rockM * 0.55);',
    '  reefFloor(p.xz, length(p - gRo), albedo, n);',
    '  float diff = clamp(dot(n, gSun), 0.0, 1.0);',
    '  vec3 lit = shadeLit(albedo, diff, gDepth);',
    '  /* Underwater cameras white-balance the cast away. Without it every reef',
    '     below about 15 m is a blue monochrome, because red light is gone by 8 m',
    '     and no coral hue can survive. This gives the seabed back a whisper of',
    '     its own colour - sand warms, corals keep a hint of their tint. */',
    '  float wb = smoothstep(16.0, 32.0, gDepth);',
    '  lit += albedo * lightAt(gDepth).b * 0.045 * wb * vec3(1.35, 0.92, 0.82);',
    '  /* Seen at a shallow angle the sand sits behind a long water path, which',
    '     drags every hue toward the water\'s own blue. Push the chroma back out',
    '     rather than adding more white light, which would only wash it out. */',
    '  float lum = dot(lit, vec3(0.2126, 0.7152, 0.0722));',
    '  lit = max(mix(vec3(lum), lit, 1.0 + 0.85 * wb), vec3(0.0));',
    '  if (uDetail > 0.5){',
    '    vec3 c = causticAt(p);',
    '    float ca = (c.r * 0.55 + c.g * 0.36) * exp(-gDepth * 0.030);',
    '    lit += sRGB(vec3(0.82, 1.0, 0.94)) * ca *',
    '           lightAt(gDepth).g * 0.042 * (0.35 + 0.65 * diff);',
    '  }',
    '  return lit;',
    '}',
    '',
    '/* cheap radiance for the mirror image on the underside of the surface */',
    'vec3 deepRadianceSimple(vec3 ro, vec3 rd, float maxDist){',
    '  vec3 amb = mediumInscatter(gDepth);',
    '  if (rd.y < -0.0006){',
    '    float t = (-SEABED - ro.y) / rd.y;',
    '    if (t > 0.0 && t < maxDist) return extinct(seabedShade(ro + rd * t), t, amb);',
    '  }',
    '  return amb;',
    '}',
    '',
    '/* ======================================================================',
    '   SURFACE FROM BELOW — Snell’s window + total internal reflection',
    '   ====================================================================== */',
    'vec3 surfaceRadiance(vec3 ro, vec3 rd, float dist){',
    '  vec3  p  = ro + rd * dist;',
    '  float lod = clamp(dist * 0.02, 0.0, 1.0);',
    '  vec3  n   = waveN(p.xz, lod);',
    '  vec3  nn  = normalize(mix(vec3(0.0, 1.0, 0.0), n, 0.88));',
    '  float cosi = clamp(dot(nn, rd), 0.0, 1.0);',
    '  const float n1 = 1.333, n2 = 1.0;',
    '  float sint = (n1 / n2) * sqrt(max(0.0, 1.0 - cosi * cosi));',
    '  if (sint >= 1.0){',
    '    return deepRadianceSimple(ro, reflect(rd, nn), dist * 3.0);',
    '  }',
    '  float cost = sqrt(max(0.0, 1.0 - sint * sint));',
    '  float rs = (n1 * cosi - n2 * cost) / (n1 * cosi + n2 * cost);',
    '  float rp = (n1 * cost - n2 * cosi) / (n1 * cost + n2 * cosi);',
    '  float R  = clamp(0.5 * (rs * rs + rp * rp), 0.0, 1.0);',
    '  vec3 sky = skyColor(normalize(refract(rd, -nn, n1 / n2)));',
    '  vec3 mir = deepRadianceSimple(ro, reflect(rd, nn), dist * 3.0);',
    '  return mix(sky, mir, R);',
    '}',
    '',
    '/* ======================================================================',
    '   MARINE SNOW — soft, fogged, perspective-correct parallax layers',
    '   ====================================================================== */',
    'vec3 particleField(vec3 ro, vec3 rd, float maxDist, vec3 amb){',
    '  vec3 acc = vec3(0.0);',
    '  if (uSnow <= 0.001) return acc;',
    '  /* Snow belongs to the deep, and it arrives by fading up rather than by',
    '     sliding through frame: below 24 m there is none of it at all. */',
    '  float appear = smoothstep(24.0, 31.0, gDepth);',
    '  if (appear <= 0.001) return acc;',
    '  float fd = dot(rd, gFwd);',
    '  if (fd < 0.05) return acc;',
    '  int layers = 6;',
    '  if (uDetail < 1.5) layers = 5;',
    '  if (uDetail < 0.5) layers = 4;',
    '  float light = lightLevel();',
    '',
    '  for (int i = 0; i < 6; i++){',
    '    if (i >= layers) break;',
    '    float D = 1.30 * pow(1.75, float(i));',
    '    float t = D / fd;',
    '    if (t > maxDist) continue;',
    '    /* Sample the grid against the camera basis, not in world space. World',
    '       sampling meant every mote slid up the frame as the camera descended,',
    '       which reads as the background tracking the scroll. Pinned to right/up',
    '       the field holds still on screen and only the current moves it. */',
    '    vec3 pr  = rd * t;',
    '    vec2 scr = vec2(dot(pr, gRight), dot(pr, gUp));',
    '',
    '    float cs  = 3.0 / (1.0 + 0.42 * float(i));',
    '    float fi  = float(i) * 17.3;',
    '    float drift = -0.070 * (0.5 + 1.1 * hash21(vec2(floor(scr.x * cs), 3.0) + fi));',
    '    /* a slow lateral current as well as the sink, so motes never hang still */',
    '    vec2  q    = vec2((scr.x + gT * 0.022) * cs, (scr.y - drift * gT) * cs);',
    '    vec2  cell = floor(q);',
    '    vec2  f    = fract(q) - 0.5;',
    '',
    '    float h  = hash21(cell + fi);',
    '    float h2 = hash21(cell + fi + 5.1);',
    '    float h3 = hash21(cell + fi + 9.3);',
    '    if (h3 > 0.20 + 0.022 * float(i)) continue;',
    '',
    '    vec2 jitter = (vec2(h, h2) - 0.5) * 0.62;',
    '    vec2 dd = f - jitter;',
    '    float rw = (0.0032 + 0.0080 * h3) * (1.0 + 1.15 * float(i));',
    '    float rad = rw * cs;',
    '    float rr = length(dd) / max(rad, 1e-4);',
    '    if (rr > 1.8) continue;',
    '',
    '    /* gaussian-soft motes: near ones fat and faint, far ones pin-sharp */',
    '    float soft = mix(1.35, 3.00, clamp(1.0 - t / 14.0, 0.0, 1.0));',
    '    float a = exp(-soft * rr * rr) * (0.14 - 0.015 * float(i));',
    '    float px = rw * uRes.y / (t * FOCAL);',
    '    a *= clamp(px * 1.15, 0.0, 1.0);',
    '    if (a <= 0.0015) continue;',
    '',
    '    /* motes take the colour of the water — never whiter than it */',
    '    vec3 pcol = amb * (1.72 - 0.08 * float(i));',
    '    acc += pcol * a * exp(-SIGMA * t);',
    '',
    '    /* bioluminescent plankton, only once the light has gone */',
    '    if (gDepth > 14.0 && h > 0.94 && uDetail > 0.5){',
    '      float pulse = 0.30 + 0.70 * pow(0.5 + 0.5 * sin(gT * 1.3 + h * 57.0), 2.0);',
    '      float gl = exp(-1.9 * rr * rr) * pulse * smoothstep(14.0, 26.0, gDepth);',
    '      acc += sRGB(vec3(0.30, 1.0, 0.84)) * gl * 0.10 * exp(-SIGMA * t * 0.55);',
    '    }',
    '  }',
    '  return acc * uSnow * appear;',
    '}',
    '',
    '',
    '/* ======================================================================',
    '   BUBBLES — sparse, rising, and anchored to the camera like the snow',
    '   ====================================================================== */',
    'vec3 bubbleField(vec3 rd, float maxDist, vec3 amb){',
    '  vec3 acc = vec3(0.0);',
    '  if (uSnow <= 0.001) return acc;',
    '  /* bubbles from 10 m down, eased in over the next six metres */',
    '  float appear = smoothstep(10.0, 16.0, gDepth);',
    '  if (appear <= 0.001) return acc;',
    '  float fd = dot(rd, gFwd);',
    '  if (fd < 0.05) return acc;',
    '  int layers = 3;',
    '  if (uDetail < 1.0) layers = 2;',
    '',
    '  for (int i = 0; i < 3; i++){',
    '    if (i >= layers) break;',
    '    float D = 1.5 * pow(2.3, float(i));',
    '    float t = D / fd;',
    '    if (t > maxDist) continue;',
    /* Same camera-basis sampling as the snow: a bubble must not slide down the
       frame as the page scrolls. The only thing that moves it is its own rise. */
    '    vec3 pr  = rd * t;',
    '    vec2 scr = vec2(dot(pr, gRight), dot(pr, gUp));',
    '',
    '    float cs = 2.0 / (1.0 + 0.55 * float(i));',
    '    float fi = float(i) * 27.1 + 6.0;',
    '    /* each column rises at its own pace, and wobbles on the way up */',
    '    float rise = 0.085 + 0.11 * hash21(vec2(floor(scr.x * cs), 11.0) + fi);',
    '    float wob  = 0.05 * sin(gT * 1.6 + scr.x * 3.0 + fi * 2.1);',
    '    /* Sampling coordinate runs the opposite way to screen travel: to make a',
    '       bubble climb, the field is sampled with -rise. (Snow uses the same',
    '       relation with a negative drift, which is why it sinks.) */',
    '    vec2 q = vec2((scr.x + wob) * cs, (scr.y - gT * rise) * cs);',
    '    vec2 cell = floor(q);',
    '    vec2 f = fract(q) - 0.5;',
    '',
    '    float h  = hash21(cell + fi);',
    '    float h2 = hash21(cell + fi + 4.3);',
    '    float h3 = hash21(cell + fi + 7.9);',
    '    if (h3 > 0.085) continue;',
    '',
    '    vec2 jitter = (vec2(h, h2) - 0.5) * 0.5;',
    '    vec2 dd = f - jitter;',
    '    float rad = (0.012 + 0.010 * h3) * cs * (1.0 + 0.45 * float(i));',
    '    float rr = length(dd) / max(rad, 1e-4);',
    '    if (rr > 1.0) continue;',
    '',
    '    /* a bubble is a bright rim around a hollow middle, not a soft dot */',
    '    float rim = smoothstep(1.0, 0.60, rr) * smoothstep(0.08, 0.50, rr);',
    '    float a = rim * (0.17 - 0.035 * float(i));',
    '    float px = rad * uRes.y / (t * FOCAL);',
    '    a *= clamp(px * 0.9, 0.0, 1.0);',
    '    if (a <= 0.0015) continue;',
    '    vec3 bcol = mix(amb * 2.3, sRGB(vec3(0.75, 0.95, 1.0)), 0.5);',
    '    acc += bcol * a * exp(-SIGMA * t * 0.8);',
    '  }',
    '  return acc * uSnow * appear;',
    '}',
    '',
    '',
    '/* ======================================================================',
    '   FISH — reef species: deep disc body, tall sails, blunt snout, fanned tail',
    '   ====================================================================== */',
    '/* coverage in .x, signed height ratio in .y (for the rim light) */',
    'vec2 fishShape(vec2 q, float len, float hgt, float phase){',
    '  float s = clamp((q.x / len + 1.0) * 0.5, 0.0, 1.0);   // 0 tail, 1 snout',
    '  float bend = 0.085 * hgt * sin(TAU * (0.80 * s) - phase) * (1.05 - 0.70 * s);',
    '  float y = q.y - bend;',
    '',
    '  /* Deepest about 42% back from the tail, and the profile is floored at a fifth',
    '     of the body depth so neither end tapers to a needle, and the peak sits',
    '     62% back so the head stays short. That floor and peak together are what',
    '     removes the long snout in front and the stick behind. */',
    '  float base = pow(max(0.0, sin(PI * pow(s, 1.45))), 0.70);',
    '  float body = hgt * (0.20 + 0.80 * base);',
    '  float soft = max(hgt * 0.12, 0.004);',
    '  float cov  = 1.0 - smoothstep(body - soft, body + soft, abs(y));',
    '',
    '  /* dorsal and anal sails, moderate so they read as fins rather than discs */',
    '  float dfin = (1.0 - smoothstep(0.0, 1.0, abs((s - 0.56) / 0.32))) *',
    '               (1.0 - smoothstep(body, body + hgt * 0.58, y)) * step(body * 0.85, y);',
    '  float afin = (1.0 - smoothstep(0.0, 1.0, abs((s - 0.46) / 0.24))) *',
    '               (1.0 - smoothstep(body, body + hgt * 0.40, -y)) * step(body * 0.85, -y);',
    '  cov = max(cov, max(dfin, afin) * 0.90);',
    '',
    '  /* short caudal fan, tucked in close behind the peduncle */',
    '  float fin = clamp((-q.x / len - 0.80) / 0.40, 0.0, 1.0);',
    '  float fh  = hgt * (0.30 + 0.95 * fin);',
    '  float fan = (1.0 - smoothstep(fh - soft, fh, abs(y))) *',
    '              (1.0 - smoothstep(0.62, 1.0, fin));',
    '  cov = max(cov, fan);',
    '',
    '  /* Bound the silhouette in x. s is clamped, so without this the profile',
    '     keeps drawing at its floor height past the snout and past the peduncle -',
    '     which is what pushed a long pole out of the mouth and a stick out of the',
    '     tail on both of the earlier builds. */',
    '  float xn   = q.x / len;',
    '  float ends = smoothstep(-1.26, -1.20, xn) * (1.0 - smoothstep(0.95, 1.05, xn));',
    '  cov *= ends;',
    '',
    '  return vec2(clamp(cov, 0.0, 1.0), y / max(body, 1e-4));',
    '}',
    '',
    '/* reef palette */',
    'vec3 fishTint(float h){',
    '  /* Chosen for the hue that survives the water, not the hue on the fish:',
    '     red is gone within a few metres, so a warm albedo just reads blue. */',
    '  if (h < 0.18) return sRGB(vec3(0.22, 0.95, 0.18));   // reads green',
    '  if (h < 0.34) return sRGB(vec3(0.55, 0.95, 0.15));   // reads yellow-green',
    '  if (h < 0.50) return sRGB(vec3(0.15, 0.88, 0.72));   // reads teal',
    '  if (h < 0.66) return sRGB(vec3(0.20, 0.80, 0.95));   // reads cyan',
    '  if (h < 0.82) return sRGB(vec3(0.92, 0.25, 0.95));   // reads violet',
    '  if (h < 0.93) return sRGB(vec3(0.60, 0.86, 0.95));   // reads pale blue',
    '  return sRGB(vec3(0.96, 0.95, 0.90));                 // reads as a lit flank',
    '}',
    '',
    '/* contrasting caudal fins - the first thing you notice on a real reef fish */',
    'vec3 fishAccent(float h){',
    '  if (h < 0.28) return sRGB(vec3(0.98, 0.86, 0.32));   // yellow',
    '  if (h < 0.52) return sRGB(vec3(0.96, 0.34, 0.26));   // rust',
    '  if (h < 0.76) return sRGB(vec3(0.34, 0.92, 0.98));   // cyan',
    '  return sRGB(vec3(0.88, 0.92, 0.98));                 // pale',
    '}',
    '',
    '/* Six markings, so the water is never one fish stamped out repeatedly.',
    '   s runs tail -> snout, v runs belly -> back. */',
    'vec3 fishSkin(vec3 base, float s, float v, float kind){',
    '  vec3 dark = base * 0.30;',
    '  if (kind < 0.17){                                    // vertical bands',
    '    float b = smoothstep(0.30, 0.70, 0.5 + 0.5 * sin(s * PI * 5.0 + 1.2));',
    '    return mix(base, dark, b * 0.78);',
    '  }',
    '  if (kind < 0.34){                                    // one lateral stripe',
    '    return mix(base, dark, (1.0 - smoothstep(0.0, 0.20, abs(v - 0.12))) * 0.72);',
    '  }',
    '  if (kind < 0.50){                                    // dark back, pale belly',
    '    return mix(base * 1.22, dark, smoothstep(-0.60, 0.70, v) * 0.80);',
    '  }',
    '  if (kind < 0.66){                                    // ocellus by the tail',
    '    float d = length(vec2((s - 0.15) * 2.1, (v - 0.02) * 1.2));',
    '    return mix(base, dark, (1.0 - smoothstep(0.14, 0.28, d)) * 0.88);',
    '  }',
    '  if (kind < 0.82){                                    // speckled',
    '    float sp = vnoise(vec2(s * 9.0, v * 3.4) + 11.0);',
    '    return mix(base, dark, smoothstep(0.54, 0.80, sp) * 0.62);',
    '  }',
    '  return base;                                         // plain: colour alone',
    '}',
    '',
    '/* Each billboard is pinned to its own world position rather than to a plane',
    '   carried by the camera. A camera-locked plane descends with you, so the fish',
    '   slide along with the page instead of passing by. */',
    'vec4 fishLayer(vec3 ro, vec3 rd, float maxDist, vec3 inscat){',
    '  if (uFish <= 0.001) return vec4(0.0);',
    '  float fd = dot(rd, gFwd);',
    '  if (fd < 0.05) return vec4(0.0);',
    '  float cov   = 0.0;',
    '  float ft    = 1.0;',
    '  float fFade = 0.0;',
    '  vec3  fcol  = vec3(0.0);',
    '',
    '  /* Solitary. Every fish keeps its own lane, depth and pace — schools read as',
    '     a shoal graphic, and reef fish drift through alone or loose pairs. */',
    '  for (int i = 0; i < 18; i++){',
    '    float fi = float(i);',
    '    float h1 = hash11(fi * 12.9 + 1.7);',
    '    float h2 = hash11(fi * 7.3 + 4.4);',
    '    float h3 = hash11(fi * 3.1 + 8.8);',
    '    float h4 = hash11(fi * 5.9 + 21.3);',
    '    float h5 = hash11(fi * 4.1 + 33.7);',
    '    float h6 = hash11(fi * 8.7 + 51.9);',
    '    float h7 = hash11(fi * 6.7 + 13.3);',
    '    if (h1 < 0.12) continue;',
    '',
    '    float dir   = h2 > 0.5 ? 1.0 : -1.0;',
    '    float speed = 0.22 + 0.34 * h3;',
    '    /* Anchored to the camera basis, so it is pinned on screen: neither the',
    '       descent nor the tilt can move it. What moves it is its own swim - a steady',
    '       crossing of the frame, a slow rise and fall, and its tail. */',
    '    float dist = 10.0 + 18.0 * h4;',
    '    float swim = mod(gT * 0.06 * (0.5 + speed) + fi * 7.31, 2.4) - 1.2;',
    '    float lat  = dir * swim * dist * 0.78;',
    '    float vert = (h3 - 0.5) * dist * 0.44',
    '               + sin(gT * 0.45 + fi * 1.7) * dist * 0.022;',
    '    vec3  F    = gRo + gFwd * dist + gRight * lat + gUp * vert;',
    '    /* Dissolve before it wraps, so it swims off one edge and back in at the',
    '       other instead of teleporting across the frame. */',
    '    float edge = 1.0 - smoothstep(0.92, 1.20, abs(swim));',
    '    /* A home depth. Nothing at all above 25 m, then each fades up as you',
    '       approach it and out as you pass. */',
    '    float hd   = 28.0 + 12.0 * (fi + 0.5) / 18.0;',
    '    float fade = (1.0 - smoothstep(0.0, 7.0, abs(gDepth - hd)))',
    '               * smoothstep(24.0, 27.0, gDepth) * edge;',
    '    if (fade < 0.004) continue;',
    '',
    '    float t = dot(F - ro, gFwd) / fd;',
    '    if (t < 1.0 || t > maxDist) continue;',
    '    vec3 hit = ro + rd * t;',
    '    vec2 c = vec2(dot(hit - F, gRight), dot(hit - F, gUp));',
    '    if (abs(c.x) > 1.1 || abs(c.y) > 0.66) continue;',
    '',
    '    float len  = 0.47 + 0.40 * h5;',
    '    float hgt  = len * 0.55;                  // deep-bodied, not a mackerel',
    '    float tilt = 0.09 * cos(gT * 0.45 + fi * 1.7) * dir;',
    '    float ct = cos(tilt), st = sin(tilt);',
    '    vec2  q = vec2((c.x * ct - c.y * st) * dir, c.x * st + c.y * ct);',
    '',
    '    vec2 sh = fishShape(q, len, hgt, gT * (1.8 + 2.4 * speed) + fi * 1.7);',
    '    if (sh.x > cov){',
    '      ft  = t;',
    '      cov   = sh.x;',
    '      fFade = fade;',
    '      vec3 albedo = fishTint(h6);',
    '      float ks = clamp((q.x / len + 1.0) * 0.5, 0.0, 1.0);',
    '      float kv = clamp(q.y / hgt, -1.0, 1.0);',
    '      albedo = fishSkin(albedo, ks, kv, h7);',
    '      /* a contrasting tail on about half of them */',
    '      albedo = mix(albedo, fishAccent(fract(h7 * 3.7 + 0.31)),',
    '                   smoothstep(-0.82, -1.04, q.x / len) * step(0.52, h5) * 0.88);',
    '      fcol = shadeLit(albedo, 0.30 + 0.30 * (sh.y * 0.5 + 0.5), gDepth);',
    '      fcol += sRGB(vec3(0.60, 0.88, 0.95)) * smoothstep(0.25, 1.0, sh.y) *',
    '              0.020 * lightLevel();',
    '    }',
    '  }',
    '  if (cov <= 0.002) return vec4(0.0);',
    '  /* ghosts: distance does most of the hiding, alpha does the rest */',
    '  vec3 fogged = extinct(fcol, ft, inscat);',
    '  return vec4(fogged, cov * 0.62 * uFish * fFade);',
    '}',
    '',
    '/* ======================================================================',
    '   GRADE',
    '   ====================================================================== */',
    'vec3 aces(vec3 x){',
    '  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);',
    '}',
    '',
    '/* ======================================================================',
    '   MAIN',
    '   ====================================================================== */',
    'void main(){',
    '  vec2 frag = gl_FragCoord.xy;',
    '  gUV = (frag - 0.5 * uRes) / uRes.y;',
    '  gT  = uTime;',
    '  gDepth = uDepth;',
    '',
    '  /* ---- camera -------------------------------------------------------- */',
    '  float yaw = uPointer.x * 0.075 + sin(gT * 0.05) * 0.012 * uMotion;',
    '  float pitch = 0.035;',
    '  /* A pitch sweep that tracks the scroll drags the whole background up the',
    '     frame in step with it, which reads as glued to the page. Both tilts are',
    '     therefore shallow and spread wide, and the downward one is saved for',
    '     the last stretch where the sand is close enough to show anyway. */',
    '  pitch = mix(pitch, 0.26,  smoothstep(0.5, 7.0, gDepth));    // look up at the surface',
    '  pitch = mix(pitch, -0.05, smoothstep(22.0, 36.5, gDepth));  // then down to the sand',
    '  pitch += uPointer.y * 0.045 + sin(gT * 0.09) * 0.008 * uMotion;',
    '  gFwd   = normalize(vec3(sin(yaw) * cos(pitch), sin(pitch), -cos(yaw) * cos(pitch)));',
    '  gRight = normalize(cross(gFwd, vec3(0.0, 1.0, 0.0)));',
    '  gUp    = cross(gRight, gFwd);',
    '  gSun   = normalize(vec3(0.62, 0.31, -0.72));   // ~18 deg elevation, front-right',
    '  gSunW  = normalize(SUN_W);                     // the same sun, refracted into water',
    '',
    '  float bob    = sin(gT * 0.42) * 0.055 * uMotion + uVel * 0.25;',
    '  float driftX = sin(gT * 0.043) * 1.6 * uMotion;',
    '  float driftZ = -gT * 0.30 * uMotion;',
    '  gRo = vec3(driftX, -gDepth + bob, driftZ);',
    '',
    '  vec3 rd = normalize(gUV.x * FOCAL * gRight + gUV.y * FOCAL * gUp + gFwd);',
    '',
    '  /* debug: inspect the caustic tile itself (5 = coarse blobs, 6 = fine blobs) */',
    '  if (uDebug > 4.5 && uDebug < 6.5){',
    '    vec4 cc = texture2D(uCaustic, gl_FragCoord.xy / uRes);',
    '    gl_FragColor = vec4(vec3(uDebug < 5.5 ? cc.a : cc.b), 1.0); return;',
    '  }',
    '',
    '  int steps = 14;',
    '  if (uDetail < 1.5) steps = 9;',
    '  if (uDetail < 0.5) steps = 6;',
    '',
    '  /* ---- what the ray finally hits ------------------------------------- */',
    '  float tHit = 1e5;',
    '  vec3  bg   = vec3(0.0);',
    '  vec3  col;',
    '',
    '  if (gRo.y < 0.0){',
    '    if (rd.y > 0.0008){',
    '      tHit = (0.0 - gRo.y) / rd.y;',
    '      bg = surfaceRadiance(gRo, rd, tHit);',
    '    } else {',
    '      float tb = (-SEABED - gRo.y) / rd.y;',
    '      if (tb > 0.0 && tb < 60.0){',
    '        tHit = tb;',
    '        bg = seabedShade(gRo + rd * tHit);',
    '        /* Water alone leaves the sand legible out to about 35 m, and at that',
    '           range the floor climbs to the middle of the frame. Extra extinction',
    '           on the sand alone pulls its far reaches into the haze, so the',
    '           colonies stay low and near instead of rising up the view. */',
    '        bg *= exp(-0.05 * max(tHit - 5.0, 0.0));',
    '      }',
    '    }',
    '    vec3 vol = waterVolume(gRo, rd, tHit, steps);',
    '    col = bg * exp(-SIGMA * min(tHit, 70.0)) + vol;',
    '    if (uDebug > 0.5 && uDebug < 1.5){ gl_FragColor = vec4(aces(vol), 1.0); return; }',
    '    if (uDebug > 2.5 && uDebug < 3.5){',
    '      col = aces(col); col = pow(col, vec3(1.0/2.2));',
    '      gl_FragColor = vec4(col, 1.0); return;',
    '    }',
    '    /* Cross-fade the air/water boundary so the dive never pops. The blend',
    '       used to happen over 0.65 m, which is about 60 px of scrolling - fast',
    '       enough that the water visibly jumps from pale to saturated as you',
    '       leave the landing view. Spread over 3 m it is a gradual descent. */',
    '    if (gRo.y > -3.00){',
    '      vec3 above = seaAbove(vec3(gRo.x, max(gRo.y, 0.35), gRo.z), rd);',
    '      col = mix(col, above, smoothstep(-3.00, 0.05, gRo.y));',
    '    }',
    '  } else {',
    '    /* seaAbove measures the surface as (0 - ro.y) / rd.y, which collapses to',
    '       zero the moment the camera reaches the waterline. Unclamped that is a',
    '       singularity: the view darkens, then snaps back as you cross. Hold the',
    '       eye a little above the surface so the two sides agree. */',
    '    col = seaAbove(vec3(gRo.x, max(gRo.y, 0.35), gRo.z), rd);',
    '  }',
    '',
    '  /* ---- life ----------------------------------------------------------- */',
    '  if (gDepth > 1.0){',
    '    float bedT = 1e5;',
    '    if (rd.y < -0.0006){',
    '      float tb = (-SEABED - gRo.y) / rd.y;',
    '      if (tb > 0.0) bedT = tb;',
    '    }',
    '    float lim = min(tHit, bedT);',
    '    vec3 amb = mediumInscatter(gDepth);',
    '',
    '    if (gDepth > 24.0 && gDepth < 38.0){',
    '      vec4 fh = fishLayer(gRo, rd, lim, amb);',
    '      if (uDebug > 3.5 && uDebug < 4.5){ gl_FragColor = vec4(vec3(fh.a), 1.0); return; }',
    '      if (fh.a > 0.0) col = mix(col, fh.rgb, fh.a);',
    '    }',
    '    vec3 parts = particleField(gRo, rd, lim, amb);',
    '    if (uDebug > 1.5 && uDebug < 2.5){ gl_FragColor = vec4(aces(parts * 6.0), 1.0); return; }',
    '    vec3 bubs = bubbleField(rd, lim, amb);',
    '    if (uDebug > 6.5 && uDebug < 7.5){ gl_FragColor = vec4(aces(bubs * 6.0), 1.0); return; }',
    '    col += parts + bubs;',
    '  }',
    '',
    '  /* ---- grade ---------------------------------------------------------- */',
    '  /* Two metres down the water turns into a saturated cyan wall: hue slides',
    '     from 200 to 186 and saturation nearly doubles inside a metre. Ease the',
    '     chroma in over the first ten metres so the drop from the landing view',
    '     reads as a descent rather than a jump. */',
    '  float shallow = smoothstep(-0.25, 1.2, gDepth) * (1.0 - smoothstep(2.5, 10.0, gDepth));',
    '  float sl = dot(col, vec3(0.2126, 0.7152, 0.0722));',
    '  col = mix(col, vec3(sl), 0.42 * shallow);',
    '  col.g *= 1.0 - 0.06 * shallow;',
    '  float exposure = 1.0 + 3.6 * smoothstep(16.0, 34.0, gDepth);',
    '  col *= exposure;',
    '  col = aces(col);',
    '  col = pow(col, vec3(1.0 / 2.2));',
    '',
    '  vec2  vq  = frag / uRes - 0.5;',
    '  float vig = 1.0 - dot(vq, vq) * (0.26 + 0.06 * smoothstep(0.0, 34.0, gDepth));',
    '  col *= clamp(vig, 0.0, 1.0);',
    '',
    '  float g = hash21(frag + fract(gT) * 91.7) - 0.5;',
    '  col += g * 0.016;',
    '',
    '  gl_FragColor = vec4(max(col, 0.0), 1.0);',
    '}'
  ].join('\n');

  /* ==========================================================================
     RENDERER
     ========================================================================== */

  var TOP_DEPTH = -1.9;
  var BOTTOM_DEPTH = 36.5;
  var DEPTH_CURVE = 1.22;
  var CAUSTIC_SIZE = 256;          // power of two: WebGL1 needs POT for REPEAT

  var UNIFORMS = ['uRes', 'uTime', 'uDepth', 'uVel', 'uPointer', 'uDetail', 'uMotion',
                  'uDebug', 'uRays', 'uSnow', 'uFish', 'uCaustic'];

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(log || 'shader compile failed');
    }
    return sh;
  }

  function buildProgram(gl, vsSrc, fsSrc) {
    var vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
    var fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      var log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error(log || 'program link failed');
    }
    return prog;
  }

  function readTuning() {
    var q = {};
    try {
      var search = global.location.search.replace(/^\?/, '');
      search.split('&').forEach(function (pair) {
        if (!pair) return;
        var kv = pair.split('=');
        q[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
      });
    } catch (e) { /* file:// with no query — defaults are fine */ }
    function num(name, fallback) {
      var v = parseFloat(q[name]);
      return isFinite(v) ? Math.max(0, Math.min(3, v)) : fallback;
    }
    /* 'rays' is kept as an alias: it used to drive the light shafts, which are gone */
    var dapple = isFinite(parseFloat(q.dapple)) ? parseFloat(q.dapple) : parseFloat(q.rays);
    return {
      rays: isFinite(dapple) ? Math.max(0, Math.min(3, dapple)) : 1,
      snow: num('snow', 1), fish: num('fish', 1), depth: num('depth', NaN)
    };
  }

  function mount(canvas, options) {
    options = options || {};
    var root = document.documentElement;
    var dead = {
      supported: false, setProgress: function () {}, setDepth: function () {},
      setDebug: function () {}, destroy: function () {}
    };

    var attrs = {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: !!options.preserve,
      powerPreference: 'high-performance'
    };

    var gl = null;
    try {
      gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
    } catch (e) { gl = null; }
    if (!gl) { root.classList.add('no-webgl'); return dead; }

    var sceneProg, causticProg;
    try {
      causticProg = buildProgram(gl, VERT_SRC, CAUSTIC_SRC);
      sceneProg = buildProgram(gl, VERT_SRC, FRAG_SRC);
    } catch (err) {
      if (global.console) console.warn('[ocean] shader failed:', err.message);
      root.classList.add('no-webgl');
      return dead;
    }

    /* ---- geometry (shared by both passes) ---- */
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    function bindQuad(prog) {
      var loc = gl.getAttribLocation(prog, 'aPos');
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }

    /* ---- caustic render target ---- */
    var causticTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, causticTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, CAUSTIC_SIZE, CAUSTIC_SIZE, 0,
                  gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, causticTex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      root.classList.add('no-webgl');
      return dead;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    var U = {}, UC = {};
    function cacheUniforms() {
      UNIFORMS.forEach(function (n) { U[n] = gl.getUniformLocation(sceneProg, n); });
      UC.uTime = gl.getUniformLocation(causticProg, 'uTime');
      UC.uRes = gl.getUniformLocation(causticProg, 'uRes');
    }
    cacheUniforms();

    /* ---- state ---- */
    var reduceQuery = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : null;
    var reduced = !!(reduceQuery && reduceQuery.matches);
    var motion = reduced ? 0 : 1;
    var detail = reduced ? 1 : 2;
    var tune = readTuning();
    var debug = options.debug || 0;

    var baseScale = options.renderScale != null ? options.renderScale : (reduced ? 0.7 : 0.9);
    var scale = baseScale;
    var dprCap = options.dprCap || 1.5;

    var progress = 0;
    var targetDepth = TOP_DEPTH;
    var depth = TOP_DEPTH;
    var velocity = 0;
    var pointer = { x: 0, y: 0 }, pointerT = { x: 0, y: 0 };
    var time = options.startTime || 0;
    var last = 0, raf = 0, running = false, destroyed = false;
    var cssW = 1, cssH = 1;
    var acc = 0, frames = 0, slow = 0, fast = 0;

    function depthForProgress(p) {
      var e = Math.pow(Math.min(Math.max(p, 0), 1), DEPTH_CURVE);
      return TOP_DEPTH + (BOTTOM_DEPTH - TOP_DEPTH) * e;
    }

    function resize() {
      cssW = global.innerWidth;
      cssH = global.innerHeight;
      var dpr = Math.min(global.devicePixelRatio || 1, dprCap);
      var pw = Math.max(2, Math.round(cssW * dpr * scale));
      var ph = Math.max(2, Math.round(cssH * dpr * scale));
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
    }

    function readScroll() {
      var max = Math.max(1, document.documentElement.scrollHeight - global.innerHeight);
      var y = global.pageYOffset != null ? global.pageYOffset : document.documentElement.scrollTop;
      var next = Math.min(1, Math.max(0, y / max));
      velocity += ((next - progress) * 12 - velocity) * 0.12;
      progress = next;
      targetDepth = depthForProgress(progress);
    }

    function drawCaustics() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, CAUSTIC_SIZE, CAUSTIC_SIZE);
      gl.useProgram(causticProg);
      bindQuad(causticProg);
      gl.uniform1f(UC.uTime, time);
      gl.uniform2f(UC.uRes, CAUSTIC_SIZE, CAUSTIC_SIZE);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    function frame(now) {
      if (destroyed) return;
      raf = global.requestAnimationFrame(frame);
      var dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
      last = now;

      if (options.autoScroll !== false) readScroll();

      var k = 1 - Math.pow(0.0016, dt);
      depth += (targetDepth - depth) * k;
      velocity *= Math.pow(0.02, dt);
      var pk = 1 - Math.pow(0.02, dt);
      pointer.x += (pointerT.x - pointer.x) * pk;
      pointer.y += (pointerT.y - pointer.y) * pk;
      if (motion) time += dt;

      drawCaustics();

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(sceneProg);
      bindQuad(sceneProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, causticTex);
      gl.uniform1i(U.uCaustic, 0);
      gl.uniform2f(U.uRes, canvas.width, canvas.height);
      gl.uniform1f(U.uTime, time);
      gl.uniform1f(U.uDepth, depth);
      gl.uniform1f(U.uVel, Math.max(-1, Math.min(1, velocity)));
      gl.uniform2f(U.uPointer, pointer.x, pointer.y);
      gl.uniform1f(U.uDetail, detail);
      gl.uniform1f(U.uMotion, motion);
      gl.uniform1f(U.uDebug, debug);
      gl.uniform1f(U.uRays, tune.rays);
      gl.uniform1f(U.uSnow, tune.snow);
      gl.uniform1f(U.uFish, tune.fish);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      if (options.onFrame) options.onFrame(depth, progress);

      acc += dt; frames++;
      if (acc > 0.5) {
        var avg = acc / frames;
        if (avg > 0.026) { slow++; fast = 0; } else if (avg < 0.0155) { fast++; slow = 0; } else { slow = 0; fast = 0; }
        if (slow >= 2 && scale > 0.55) { scale = Math.max(0.55, scale - 0.12); slow = 0; resize(); }
        else if (fast >= 4 && scale < baseScale) { scale = Math.min(baseScale, scale + 0.08); fast = 0; resize(); }
        acc = 0; frames = 0;
      }
    }

    function start() { if (running || destroyed) return; running = true; last = 0; raf = global.requestAnimationFrame(frame); }
    function stop() { running = false; if (raf) global.cancelAnimationFrame(raf); raf = 0; }

    var onResize = function () { resize(); };
    var onPointerMove = function (e) {
      pointerT.x = Math.max(-1, Math.min(1, (e.clientX / cssW - 0.5) * 2));
      pointerT.y = Math.max(-1, Math.min(1, -(e.clientY / cssH - 0.5) * 2));
    };
    var onVisibility = function () { if (document.hidden) stop(); else start(); };
    var onLost = function (e) { e.preventDefault(); stop(); };
    var onRestored = function () {
      try {
        causticProg = buildProgram(gl, VERT_SRC, CAUSTIC_SRC);
        sceneProg = buildProgram(gl, VERT_SRC, FRAG_SRC);
        cacheUniforms();
        gl.bindTexture(gl.TEXTURE_2D, causticTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, CAUSTIC_SIZE, CAUSTIC_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, causticTex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        resize(); start();
      } catch (err) { root.classList.add('no-webgl'); }
    };

    global.addEventListener('resize', onResize, { passive: true });
    global.addEventListener('orientationchange', onResize, { passive: true });
    if (!reduced && global.matchMedia && global.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      global.addEventListener('pointermove', onPointerMove, { passive: true });
    }
    document.addEventListener('visibilitychange', onVisibility);
    canvas.addEventListener('webglcontextlost', onLost, false);
    canvas.addEventListener('webglcontextrestored', onRestored, false);

    if (reduceQuery) {
      var onReduce = function (e) { reduced = e.matches; motion = reduced ? 0 : 1; detail = reduced ? 1 : 2; };
      if (reduceQuery.addEventListener) reduceQuery.addEventListener('change', onReduce);
      else if (reduceQuery.addListener) reduceQuery.addListener(onReduce);
    }

    resize();
    if (options.autoScroll !== false) readScroll();
    depth = targetDepth;
    if (!isNaN(tune.depth)) { targetDepth = tune.depth; depth = tune.depth; }
    start();

    return {
      supported: true,
      setProgress: function (p) {
        progress = Math.min(1, Math.max(0, p));
        targetDepth = depthForProgress(progress);
        if (reduced || options.snap) depth = targetDepth;
      },
      setDepth: function (d) { targetDepth = d; if (reduced || options.snap) depth = d; },
      setPointer: function (x, y) { pointerT.x = x; pointerT.y = y; },
      setDetail: function (d) { detail = d; },
      setDebug: function (d) { debug = d; },
      setTuning: function (o) {
        if (o && typeof o.rays === 'number') tune.rays = o.rays;
        if (o && typeof o.snow === 'number') tune.snow = o.snow;
        if (o && typeof o.fish === 'number') tune.fish = o.fish;
      },
      get depth() { return depth; },
      get progress() { return progress; },
      destroy: function () {
        destroyed = true; stop();
        global.removeEventListener('resize', onResize);
        global.removeEventListener('orientationchange', onResize);
        global.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('visibilitychange', onVisibility);
        canvas.removeEventListener('webglcontextlost', onLost);
        canvas.removeEventListener('webglcontextrestored', onRestored);
        try {
          gl.deleteProgram(sceneProg); gl.deleteProgram(causticProg);
          gl.deleteBuffer(buf); gl.deleteTexture(causticTex); gl.deleteFramebuffer(fbo);
        } catch (e) {}
      }
    };
  }

  global.Ocean = {
    mount: mount,
    TOP_DEPTH: TOP_DEPTH,
    BOTTOM_DEPTH: BOTTOM_DEPTH,
    depthForProgress: function (p) {
      return TOP_DEPTH + (BOTTOM_DEPTH - TOP_DEPTH) * Math.pow(Math.min(Math.max(p, 0), 1), DEPTH_CURVE);
    }
  };
})(window);
