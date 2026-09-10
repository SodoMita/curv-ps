
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
  let t0: f32 = length(vec2f(p0.x, p0.y));
  let t1: f32 = ((P[1] * exp((-(t0 / max(P[0], 0.000001))))) + atan2(p0.y, p0.x));
  let t2: vec3f = vec3f((t0 * cos(t1)), (t0 * sin(t1)), p0.z);
  let t3: f32 = (6.283185307179586 / P[2]);
  let t4: f32 = (1.5707963267948966 + (t3 * 0.5));
  let t5: f32 = length(vec2f(t2.x, t2.y));
  let t6: f32 = (((atan2(t2.y, t2.x) + t4) - t3 * floor((atan2(t2.y, t2.x) + t4) / t3)) - t4);
  let t7: vec3f = vec3f((cos(t6) * t5), (sin(t6) * t5), t2.z);
  let t8: f32 = (dot(vec2f(t7.x, t7.y), normalize(vec2f(P[4], P[5]))) - P[6]);
  let t9: vec4f = vec4f(P[7], P[8], P[9], P[10]);
  let t10: f32 = (dot(vec2f(t7.x, t7.y), normalize(vec2f(P[11], P[12]))) - P[13]);
  let t11: vec4f = vec4f(P[14], P[15], P[16], P[17]);
  let t12: f32 = min(t8, t10);
  let t13: f32 = (clamp((0.5 - (t8 * u.cam.z)), 0.0, 1.0) * t9.w);
  let t14: f32 = (clamp((0.5 - (t10 * u.cam.z)), 0.0, 1.0) * t11.w);
  let t15: f32 = (t14 + (t13 * (1.0 - t14)));
  let t16: vec4f = vec4f(select((((vec3f(t11.x, t11.y, t11.z) * t14) + ((vec3f(t9.x, t9.y, t9.z) * t13) * (1.0 - t14))) / max(t15, 0.00001)), vec3f(t9.x, t9.y, t9.z), (t15 < 0.00001)), min(1.0, (t15 / max(clamp((0.5 - (t12 * u.cam.z)), 0.0, 1.0), 0.00001))));
  let t17: f32 = (length(p0) - P[18]);
  let t18: f32 = max(t12, t17);
  let t19: vec4f = select(t16, vec4f(0.86, 0.82, 0.55, 1.0), (t17 > t12));
  let d = t18; let col = t19;
  let aa = clamp(0.5 - d * u.cam.z, 0.0, 1.0) * col.a;
  return vec4f(mix(u.bg.rgb, col.rgb, aa), 1.0);
}