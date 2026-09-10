
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

@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let px = fc.xy / u.atlas.w;
  // 3D-native body: the point is a vec3 on the z = 0 plane (the exact 2D slice)
  let p0 = vec3f(vec2f(1.0, -1.0) * (px - u.res * 0.5) / u.cam.z + u.cam.xy, 0.0);
  let t0: f32 = (P[0] * 0.5);
  let t1: f32 = (P[1] * 0.5);
  let t2: vec3f = vec3f((((p0.x + t0) - P[0] * floor((p0.x + t0) / P[0])) - t0), (((p0.y + t1) - P[1] * floor((p0.y + t1) / P[1])) - t1), p0.z);
  let t3: f32 = (length(t2) - P[2]);
  let t4: vec4f = vec4f(P[3], P[4], P[5], P[6]);
  let t5: f32 = (abs(t3) - P[7]);
  let t6: vec3f = (p0 - vec3f(P[8], P[9], 0.0));
  let t7: vec3f = (vec3f(((P[10] * t6.x) + (P[11] * t6.y)), ((P[10] * t6.y) - (P[11] * t6.x)), t6.z) / P[12]);
  let t8: f32 = (P[13] * 0.5);
  let t9: f32 = (P[14] * 0.5);
  let t10: vec3f = vec3f((((t7.x + t8) - P[13] * floor((t7.x + t8) / P[13])) - t8), (((t7.y + t9) - P[14] * floor((t7.y + t9) / P[14])) - t9), t7.z);
  let t11: f32 = (length(t10) - P[15]);
  let t12: vec4f = vec4f(P[16], P[17], P[18], P[19]);
  let t13: f32 = (abs(t11) - P[20]);
  let t14: f32 = (t13 * P[12]);
  let t15: f32 = min(t5, t14);
  let t16: f32 = (clamp((0.5 - (t5 * u.cam.z)), 0.0, 1.0) * t4.w);
  let t17: f32 = (clamp((0.5 - (t14 * u.cam.z)), 0.0, 1.0) * t12.w);
  let t18: f32 = (t17 + (t16 * (1.0 - t17)));
  let t19: vec4f = vec4f(select((((vec3f(t12.x, t12.y, t12.z) * t17) + ((vec3f(t4.x, t4.y, t4.z) * t16) * (1.0 - t17))) / max(t18, 0.00001)), vec3f(t4.x, t4.y, t4.z), (t18 < 0.00001)), min(1.0, (t18 / max(clamp((0.5 - (t15 * u.cam.z)), 0.0, 1.0), 0.00001))));
  let d = t15; let col = t19;
  let aa = clamp(0.5 - d * u.cam.z, 0.0, 1.0) * col.a;
  return vec4f(mix(u.bg.rgb, col.rgb, aa), 1.0);
}