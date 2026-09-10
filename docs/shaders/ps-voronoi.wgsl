
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
  var v1: vec2f = floor(vec2f(t0.x, t0.y));
  var v2: vec2f = fract(vec2f(t0.x, t0.y));
  var v3: f32 = 8.0;
  let t4: f32 = floor((((1.0 - -1.0) / 1.0) + 1.000000001));
  for (var i5: f32 = 0.0; i5 < t4; i5 += 1.0) {
    let t6: f32 = (-1.0 + (i5 * 1.0));
    let t7: f32 = floor((((1.0 - -1.0) / 1.0) + 1.000000001));
    for (var i8: f32 = 0.0; i8 < t7; i8 += 1.0) {
      let t9: f32 = (-1.0 + (i8 * 1.0));
      var v10: vec2f = vec2f(t6, t9);
      let t11: vec2f = (v1 + v10);
      var v12: vec2f = ((v10 - v2) + vec2f(fract((sin((t11.x + (t11.y * 1000.0))) * 10000.0)), fract((sin((t11.x + (t11.y * 1000.0))) * 1000000.0))));
      var v13: f32 = dot(v12, v12);
      v3 = min(v3, v13);
    }
  }
  let t14: f32 = -1.0e+30;
  let t15: vec4f = vec4f(vec3f(sqrt(v3), sqrt(v3), sqrt(v3)), 1.0);
  let d = t14; let col = t15;
  let aa = clamp(0.5 - d * u.cam.z, 0.0, 1.0) * col.a;
  return vec4f(mix(u.bg.rgb, col.rgb, aa), 1.0);
}