
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
  let t0: f32 = (length(p0) - P[1]);
  let t1: vec4f = vec4f(P[2], P[3], P[4], P[5]);
  let t2: vec3f = (p0 - vec3f(P[6], P[7], P[8]));
  let t3: f32 = (((P[9] * t2.x) + (P[10] * t2.y)) + (P[11] * t2.z));
  let t4: f32 = (((P[12] * t2.x) + (P[13] * t2.y)) + (P[14] * t2.z));
  let t5: f32 = (((P[15] * t2.x) + (P[16] * t2.y)) + (P[17] * t2.z));
  let t6: f32 = (length(vec3f(t3, t4, t5)) - P[18]);
  let t7: vec4f = vec4f(P[19], P[20], P[21], P[22]);
  let t8: f32 = clamp((0.5 + ((0.5 * (t0 - t6)) / max(P[0], 0.0001))), 0.0, 1.0);
  let t9: f32 = clamp((0.5 + ((0.5 * (t6 - t0)) / max(P[0], 0.0001))), 0.0, 1.0);
  let t10: f32 = (mix(t6, t0, t9) - ((P[0] * t9) * (1.0 - t9)));
  let t11: vec4f = mix(t1, t7, t8);
  let t12: vec3f = (p0 - vec3f(P[23], P[24], P[25]));
  let t13: f32 = (((P[26] * t12.x) + (P[27] * t12.y)) + (P[28] * t12.z));
  let t14: f32 = (((P[29] * t12.x) + (P[30] * t12.y)) + (P[31] * t12.z));
  let t15: f32 = (((P[32] * t12.x) + (P[33] * t12.y)) + (P[34] * t12.z));
  let t16: f32 = (length(vec3f(t13, t14, t15)) - P[35]);
  let t17: vec4f = vec4f(P[36], P[37], P[38], P[39]);
  let t18: f32 = clamp((0.5 + ((0.5 * (t10 - t16)) / max(P[0], 0.0001))), 0.0, 1.0);
  let t19: f32 = clamp((0.5 + ((0.5 * (t16 - t10)) / max(P[0], 0.0001))), 0.0, 1.0);
  let t20: f32 = (mix(t16, t10, t19) - ((P[0] * t19) * (1.0 - t19)));
  let t21: vec4f = mix(t11, t17, t18);
  let t22: vec3f = (p0 - vec3f(P[40], P[41], P[42]));
  let t23: vec3f = (vec3f(P[43], P[44], P[45]) - vec3f(P[40], P[41], P[42]));
  let t24: f32 = clamp((dot(t22, t23) / max(dot(t23, t23), 0.000001)), 0.0, 1.0);
  let t25: f32 = (length((t22 - (t23 * t24))) - P[46]);
  let t26: f32 = clamp((0.5 + ((0.5 * (t20 - t25)) / max(P[0], 0.0001))), 0.0, 1.0);
  let t27: f32 = clamp((0.5 + ((0.5 * (t25 - t20)) / max(P[0], 0.0001))), 0.0, 1.0);
  let t28: f32 = (mix(t25, t20, t27) - ((P[0] * t27) * (1.0 - t27)));
  let t29: vec4f = mix(t21, vec4f(0.86, 0.82, 0.55, 1.0), t26);
  let t30: vec3f = (p0 - vec3f(P[47], P[48], P[49]));
  let t31: vec3f = (vec3f(P[50], P[51], P[52]) - vec3f(P[47], P[48], P[49]));
  let t32: f32 = clamp((dot(t30, t31) / max(dot(t31, t31), 0.000001)), 0.0, 1.0);
  let t33: f32 = (length((t30 - (t31 * t32))) - P[53]);
  let t34: f32 = clamp((0.5 + ((0.5 * (t28 - t33)) / max(P[0], 0.0001))), 0.0, 1.0);
  let t35: f32 = clamp((0.5 + ((0.5 * (t33 - t28)) / max(P[0], 0.0001))), 0.0, 1.0);
  let t36: f32 = (mix(t33, t28, t35) - ((P[0] * t35) * (1.0 - t35)));
  let t37: vec4f = mix(t29, vec4f(0.86, 0.82, 0.55, 1.0), t34);
  return t36;
}
fn colf(q: vec3f) -> vec4f {
  let p0 = q;
  let t0: f32 = (length(p0) - P[1]);
  let t1: vec4f = vec4f(P[2], P[3], P[4], P[5]);
  let t2: vec3f = (p0 - vec3f(P[6], P[7], P[8]));
  let t3: f32 = (((P[9] * t2.x) + (P[10] * t2.y)) + (P[11] * t2.z));
  let t4: f32 = (((P[12] * t2.x) + (P[13] * t2.y)) + (P[14] * t2.z));
  let t5: f32 = (((P[15] * t2.x) + (P[16] * t2.y)) + (P[17] * t2.z));
  let t6: f32 = (length(vec3f(t3, t4, t5)) - P[18]);
  let t7: vec4f = vec4f(P[19], P[20], P[21], P[22]);
  let t8: f32 = clamp((0.5 + ((0.5 * (t0 - t6)) / max(P[0], 0.0001))), 0.0, 1.0);
  let t9: f32 = clamp((0.5 + ((0.5 * (t6 - t0)) / max(P[0], 0.0001))), 0.0, 1.0);
  let t10: f32 = (mix(t6, t0, t9) - ((P[0] * t9) * (1.0 - t9)));
  let t11: vec4f = mix(t1, t7, t8);
  let t12: vec3f = (p0 - vec3f(P[23], P[24], P[25]));
  let t13: f32 = (((P[26] * t12.x) + (P[27] * t12.y)) + (P[28] * t12.z));
  let t14: f32 = (((P[29] * t12.x) + (P[30] * t12.y)) + (P[31] * t12.z));
  let t15: f32 = (((P[32] * t12.x) + (P[33] * t12.y)) + (P[34] * t12.z));
  let t16: f32 = (length(vec3f(t13, t14, t15)) - P[35]);
  let t17: vec4f = vec4f(P[36], P[37], P[38], P[39]);
  let t18: f32 = clamp((0.5 + ((0.5 * (t10 - t16)) / max(P[0], 0.0001))), 0.0, 1.0);
  let t19: f32 = clamp((0.5 + ((0.5 * (t16 - t10)) / max(P[0], 0.0001))), 0.0, 1.0);
  let t20: f32 = (mix(t16, t10, t19) - ((P[0] * t19) * (1.0 - t19)));
  let t21: vec4f = mix(t11, t17, t18);
  let t22: vec3f = (p0 - vec3f(P[40], P[41], P[42]));
  let t23: vec3f = (vec3f(P[43], P[44], P[45]) - vec3f(P[40], P[41], P[42]));
  let t24: f32 = clamp((dot(t22, t23) / max(dot(t23, t23), 0.000001)), 0.0, 1.0);
  let t25: f32 = (length((t22 - (t23 * t24))) - P[46]);
  let t26: f32 = clamp((0.5 + ((0.5 * (t20 - t25)) / max(P[0], 0.0001))), 0.0, 1.0);
  let t27: f32 = clamp((0.5 + ((0.5 * (t25 - t20)) / max(P[0], 0.0001))), 0.0, 1.0);
  let t28: f32 = (mix(t25, t20, t27) - ((P[0] * t27) * (1.0 - t27)));
  let t29: vec4f = mix(t21, vec4f(0.86, 0.82, 0.55, 1.0), t26);
  let t30: vec3f = (p0 - vec3f(P[47], P[48], P[49]));
  let t31: vec3f = (vec3f(P[50], P[51], P[52]) - vec3f(P[47], P[48], P[49]));
  let t32: f32 = clamp((dot(t30, t31) / max(dot(t31, t31), 0.000001)), 0.0, 1.0);
  let t33: f32 = (length((t30 - (t31 * t32))) - P[53]);
  let t34: f32 = clamp((0.5 + ((0.5 * (t28 - t33)) / max(P[0], 0.0001))), 0.0, 1.0);
  let t35: f32 = clamp((0.5 + ((0.5 * (t33 - t28)) / max(P[0], 0.0001))), 0.0, 1.0);
  let t36: f32 = (mix(t33, t28, t35) - ((P[0] * t35) * (1.0 - t35)));
  let t37: vec4f = mix(t29, vec4f(0.86, 0.82, 0.55, 1.0), t34);
  return t37;
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