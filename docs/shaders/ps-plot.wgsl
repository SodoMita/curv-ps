
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
  let t0: vec4f = vec4f(p0, u.time);
  let t1: f32 = (t0.y - (sin(t0.x) * sin((t0.x * 10.0))));
  let t2: vec4f = vec4f(0.86, 0.82, 0.55, 1.0);
  let t3: vec3f = (p0 - vec3f(P[0], P[1], P[2]));
  let t4: vec3f = (vec3f(P[3], P[4], P[5]) - vec3f(P[0], P[1], P[2]));
  let t5: f32 = clamp((dot(t3, t4) / max(dot(t4, t4), 0.000001)), 0.0, 1.0);
  let t6: f32 = (length((t3 - (t4 * t5))) - P[6]);
  let t7: vec4f = vec4f(P[7], P[8], P[9], P[10]);
  let t8: f32 = min(t1, t6);
  let t9: f32 = (clamp((0.5 - (t1 * u.cam.z)), 0.0, 1.0) * t2.w);
  let t10: f32 = (clamp((0.5 - (t6 * u.cam.z)), 0.0, 1.0) * t7.w);
  let t11: f32 = (t10 + (t9 * (1.0 - t10)));
  let t12: vec4f = vec4f(select((((vec3f(t7.x, t7.y, t7.z) * t10) + ((vec3f(t2.x, t2.y, t2.z) * t9) * (1.0 - t10))) / max(t11, 0.00001)), vec3f(t2.x, t2.y, t2.z), (t11 < 0.00001)), min(1.0, (t11 / max(clamp((0.5 - (t8 * u.cam.z)), 0.0, 1.0), 0.00001))));
  let t13: vec3f = (p0 - vec3f(P[11], P[12], P[13]));
  let t14: vec3f = (vec3f(P[14], P[15], P[16]) - vec3f(P[11], P[12], P[13]));
  let t15: f32 = clamp((dot(t13, t14) / max(dot(t14, t14), 0.000001)), 0.0, 1.0);
  let t16: f32 = (length((t13 - (t14 * t15))) - P[17]);
  let t17: vec4f = vec4f(P[18], P[19], P[20], P[21]);
  let t18: f32 = min(t8, t16);
  let t19: f32 = (clamp((0.5 - (t8 * u.cam.z)), 0.0, 1.0) * t12.w);
  let t20: f32 = (clamp((0.5 - (t16 * u.cam.z)), 0.0, 1.0) * t17.w);
  let t21: f32 = (t20 + (t19 * (1.0 - t20)));
  let t22: vec4f = vec4f(select((((vec3f(t17.x, t17.y, t17.z) * t20) + ((vec3f(t12.x, t12.y, t12.z) * t19) * (1.0 - t20))) / max(t21, 0.00001)), vec3f(t12.x, t12.y, t12.z), (t21 < 0.00001)), min(1.0, (t21 / max(clamp((0.5 - (t18 * u.cam.z)), 0.0, 1.0), 0.00001))));
  let d = t18; let col = t22;
  let aa = clamp(0.5 - d * u.cam.z, 0.0, 1.0) * col.a;
  return vec4f(mix(u.bg.rgb, col.rgb, aa), 1.0);
}