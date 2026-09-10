
struct U { res: vec2f, time: f32, pad0: f32, bg: vec4f, atlas: vec4f, cam: vec4f, cam3a: vec4f, cam3b: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> P: array<f32>;
@group(0) @binding(2) var atlasTex: texture_2d<f32>;
@group(0) @binding(3) var atlasSamp: sampler;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
fn hsv2rgb(c: vec3f) -> vec3f {
  let k = (vec3f(5.0, 3.0, 1.0) + c.x * 6.0) % 6.0;
  return c.z - c.z * c.y * max(vec3f(0.0), min(min(k, 4.0 - k), vec3f(1.0)));
}

fn stepf(q: vec3f) -> f32 {
  let p0 = q;
  let t0: vec3f = (p0 - vec3f(P[0], P[1], P[2]));
  let t1: f32 = (((P[3] * t0.x) + (P[4] * t0.y)) + (P[5] * t0.z));
  let t2: f32 = (((P[6] * t0.x) + (P[7] * t0.y)) + (P[8] * t0.z));
  let t3: f32 = (((P[9] * t0.x) + (P[10] * t0.y)) + (P[11] * t0.z));
  let t4: f32 = ((-P[12]) * vec3f(t1, t2, t3).z);
  let t5: f32 = cos(t4);
  let t6: f32 = sin(t4);
  let t7: vec3f = (vec3f(((t5 * vec3f(t1, t2, t3).x) - (t6 * vec3f(t1, t2, t3).y)), ((t6 * vec3f(t1, t2, t3).x) + (t5 * vec3f(t1, t2, t3).y)), vec3f(t1, t2, t3).z) / vec3f(P[13], P[14], P[15]));
  let t8: f32 = (u.cam.z * P[16]);
  let t9: vec3f = (abs(t7) - vec3f(P[17], P[18], P[19]));
  let t10: f32 = ((length(max(t9, vec3f(0.0))) + min(max(t9.x, max(t9.y, t9.z)), 0.0)) - P[20]);
  let t11: f32 = (t10 * P[16]);
  let t12: vec4f = vec4f(P[21], P[22], P[23], P[24]);
  return t11;
}
fn colf(q: vec3f) -> vec4f {
  let p0 = q;
  let t0: vec3f = (p0 - vec3f(P[0], P[1], P[2]));
  let t1: f32 = (((P[3] * t0.x) + (P[4] * t0.y)) + (P[5] * t0.z));
  let t2: f32 = (((P[6] * t0.x) + (P[7] * t0.y)) + (P[8] * t0.z));
  let t3: f32 = (((P[9] * t0.x) + (P[10] * t0.y)) + (P[11] * t0.z));
  let t4: f32 = ((-P[12]) * vec3f(t1, t2, t3).z);
  let t5: f32 = cos(t4);
  let t6: f32 = sin(t4);
  let t7: vec3f = (vec3f(((t5 * vec3f(t1, t2, t3).x) - (t6 * vec3f(t1, t2, t3).y)), ((t6 * vec3f(t1, t2, t3).x) + (t5 * vec3f(t1, t2, t3).y)), vec3f(t1, t2, t3).z) / vec3f(P[13], P[14], P[15]));
  let t8: f32 = (u.cam.z * P[16]);
  let t9: vec3f = (abs(t7) - vec3f(P[17], P[18], P[19]));
  let t10: f32 = ((length(max(t9, vec3f(0.0))) + min(max(t9.x, max(t9.y, t9.z)), 0.0)) - P[20]);
  let t11: f32 = (t10 * P[16]);
  let t12: vec4f = vec4f(P[21], P[22], P[23], P[24]);
  return t12;
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let tgt = u.cam3a.xyz;
  let rad = max(u.cam3a.w, 0.001);
  let cy = cos(u.cam3b.x); let sy = sin(u.cam3b.x);
  let cp = cos(u.cam3b.y); let sp = sin(u.cam3b.y);
  let ro = tgt + rad * vec3f(sy * cp, sp, cy * cp);
  let fw = normalize(tgt - ro);
  let rt = normalize(cross(fw, vec3f(0.0, 1.0, 0.0)));
  let up = cross(rt, fw);
  // normalised device coords in [-1, 1] — the CPU marcher divides by (res * 0.5); this used to
  // multiply by 2.0 instead, which made nd ~res wide (e.g. ±800), so every ray left at a right
  // angle to the view direction and the 3D view came out empty on the GPU while the CPU path
  // (and therefore every headless gate) looked fine.
  let nd = vec2f(1.0, -1.0) * (fc.xy / u.atlas.w - u.res * 0.5) / (u.res * 0.5);
  let rd = normalize(fw + rt * (nd.x * u.cam3b.z * u.cam3b.w) + up * (nd.y * u.cam3b.z));
  // the far plane follows the camera: a viewport-sized 2D program is ~900 units across and the
  // auto-fit puts the eye ~1900 units out, where a fixed 400-unit far plane never reaches it
  let FAR = max(400.0, rad * 6.0);
  var tt = 0.02;
  var hit = false;
  for (var i = 0u; i < 128u; i = i + 1u) {
    let dd = stepf(ro + rd * tt);
    // WGSL needs a compound statement for the body of an if: "if (dd > FAR) break;" is a syntax
    // error (naga: expected '{' for if statement), which is how round 17 shipped a 3D view that
    // only ever worked on the CPU fallback.
    if (dd < 0.001) { hit = true; break; }
    if (dd > FAR) { break; }
    tt += min(dd, FAR);
    if (tt > FAR) { break; }
  }
  if (!hit) { return vec4f(u.bg.rgb, 1.0); }
  let ph = ro + rd * tt;
  let e = max(0.0012, rad * 0.0006);
  let n = normalize(vec3f(
    stepf(ph + vec3f(e, 0.0, 0.0)) - stepf(ph - vec3f(e, 0.0, 0.0)),
    stepf(ph + vec3f(0.0, e, 0.0)) - stepf(ph - vec3f(0.0, e, 0.0)),
    stepf(ph + vec3f(0.0, 0.0, e)) - stepf(ph - vec3f(0.0, 0.0, e))));
  let cc = colf(ph);
  let l1 = normalize(vec3f(0.55, 0.8, 0.5));
  let l2 = normalize(vec3f(-0.5, -0.25, -0.6));
  let rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 3.0);
  let lum = 0.32 + 0.75 * max(dot(n, l1), 0.0) + 0.35 * max(dot(n, l2), 0.0) + 0.3 * rim;
  return vec4f(min(cc.rgb * lum, vec3f(1.0)), 1.0);
}