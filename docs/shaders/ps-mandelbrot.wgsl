
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
  let t1: vec3f = vec3f(t0.x, t0.y, t0.z);
  let t2: f32 = -1.0e+30;
  var v3: vec2f = vec2f(t0.x, t0.y);
  var v4: vec3f = vec3f(0.0, 0.0, 0.0);
  var v5: bool = false;
  let t6: f32 = ceil((((100.0 - 0.0) / 1.0) - 1.0e-9));
  for (var i7: f32 = 0.0; i7 < t6; i7 += 1.0) {
    let t8: f32 = (0.0 + (i7 * 1.0));
    if (v5) {
      break;
    }
    v3 = (vec2f(((v3.x * v3.x) - (v3.y * v3.y)), ((2.0 * v3.x) * v3.y)) + vec2f(t0.x, t0.y));
    if ((dot(v3, v3) > 4.0)) {
      var v9: f32 = ((t8 - 1.0) - (log((log(dot(v3, v3)) / P[0])) / P[1]));
      v4 = vec3f((0.95 + (0.012 * v9)), 1.0, (0.2 + (0.4 * (1.0 + sin((0.3 * v9))))));
      v5 = true;
    }
  }
  let t10: vec4f = vec4f(hsv2rgb(v4), 1.0);
  let d = t2; let col = t10;
  let aa = clamp(0.5 - d * u.cam.z, 0.0, 1.0) * col.a;
  return vec4f(mix(u.bg.rgb, col.rgb, aa), 1.0);
}