
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
  let t1: bool = (length(vec2f(t0.x, t0.y)) == 0.0);
  let t2: f32 = select(((min(abs(((P[3] * pow(2.718281828459045, (P[2] * (atan2(t0.y, t0.x) + (6.283185307179586 * ceil((((log((length(vec2f(t0.x, t0.y)) / P[0])) / P[1]) - atan2(t0.y, t0.x)) / 6.283185307179586))))))) - length(vec2f(t0.x, t0.y)))), abs((length(vec2f(t0.x, t0.y)) - (P[5] * pow(2.718281828459045, (P[4] * (atan2(t0.y, t0.x) + (6.283185307179586 * floor((((log((length(vec2f(t0.x, t0.y)) / P[0])) / P[1]) - atan2(t0.y, t0.x)) / 6.283185307179586)))))))))) - (length(vec2f(t0.x, t0.y)) * P[6])) / 1.24), 0.0, t1);
  let t3: vec4f = vec4f(0.86, 0.82, 0.55, 1.0);
  let d = t2; let col = t3;
  let aa = clamp(0.5 - d * u.cam.z, 0.0, 1.0) * col.a;
  return vec4f(mix(u.bg.rgb, col.rgb, aa), 1.0);
}