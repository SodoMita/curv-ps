
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
  let t0: f32 = (length(p0) - P[0]);
  let t1: vec4f = vec4f(p0, u.time);
  var v2: vec2f = vec2f(t1.x, t1.y);
  var v3: f32 = 0.0;
  var v4: f32 = 0.5;
  let t5: f32 = floor((((5.0 - 1.0) / 1.0) + 1.000000001));
  for (var i6: f32 = 0.0; i6 < t5; i6 += 1.0) {
    let t7: f32 = (1.0 + (i6 * 1.0));
    let t8: vec2f = (((v2 - floor(v2)) * (v2 - floor(v2))) * (3.0 - (2.0 * (v2 - floor(v2)))));
    let t9: vec2f = (((v2 - floor(v2)) * (v2 - floor(v2))) * (3.0 - (2.0 * (v2 - floor(v2)))));
    let t10: vec2f = (((v2 - floor(v2)) * (v2 - floor(v2))) * (3.0 - (2.0 * (v2 - floor(v2)))));
    let t11: vec2f = (((v2 - floor(v2)) * (v2 - floor(v2))) * (3.0 - (2.0 * (v2 - floor(v2)))));
    let t12: vec2f = (((v2 - floor(v2)) * (v2 - floor(v2))) * (3.0 - (2.0 * (v2 - floor(v2)))));
    v3 = (v3 + (v4 * ((mix(fract((sin(dot(floor(v2), vec2f(12.9898, 78.233))) * 43758.5453123)), fract((sin(dot((floor(v2) + vec2f(1.0, 0.0)), vec2f(12.9898, 78.233))) * 43758.5453123)), t8.x) + (((fract((sin(dot((floor(v2) + vec2f(0.0, 1.0)), vec2f(12.9898, 78.233))) * 43758.5453123)) - fract((sin(dot(floor(v2), vec2f(12.9898, 78.233))) * 43758.5453123))) * t9.y) * (1.0 - t10.x))) + (((fract((sin(dot((floor(v2) + vec2f(1.0, 1.0)), vec2f(12.9898, 78.233))) * 43758.5453123)) - fract((sin(dot((floor(v2) + vec2f(1.0, 0.0)), vec2f(12.9898, 78.233))) * 43758.5453123))) * t11.x) * t12.y))));
    let t13: vec2f = vec2f(P[1], P[2]);
    v2 = ((vec2f(((t13.x * v2.x) - (t13.y * v2.y)), ((t13.x * v2.y) + (t13.y * v2.x))) * 2.0) + vec2f(100.0, 100.0));
    v4 = (v4 * 0.5);
  }
  var v14: vec2f = (vec2f(t1.x, t1.y) + 1.0);
  var v15: f32 = 0.0;
  var v16: f32 = 0.5;
  let t17: f32 = floor((((5.0 - 1.0) / 1.0) + 1.000000001));
  for (var i18: f32 = 0.0; i18 < t17; i18 += 1.0) {
    let t19: f32 = (1.0 + (i18 * 1.0));
    let t20: vec2f = (((v14 - floor(v14)) * (v14 - floor(v14))) * (3.0 - (2.0 * (v14 - floor(v14)))));
    let t21: vec2f = (((v14 - floor(v14)) * (v14 - floor(v14))) * (3.0 - (2.0 * (v14 - floor(v14)))));
    let t22: vec2f = (((v14 - floor(v14)) * (v14 - floor(v14))) * (3.0 - (2.0 * (v14 - floor(v14)))));
    let t23: vec2f = (((v14 - floor(v14)) * (v14 - floor(v14))) * (3.0 - (2.0 * (v14 - floor(v14)))));
    let t24: vec2f = (((v14 - floor(v14)) * (v14 - floor(v14))) * (3.0 - (2.0 * (v14 - floor(v14)))));
    v15 = (v15 + (v16 * ((mix(fract((sin(dot(floor(v14), vec2f(12.9898, 78.233))) * 43758.5453123)), fract((sin(dot((floor(v14) + vec2f(1.0, 0.0)), vec2f(12.9898, 78.233))) * 43758.5453123)), t20.x) + (((fract((sin(dot((floor(v14) + vec2f(0.0, 1.0)), vec2f(12.9898, 78.233))) * 43758.5453123)) - fract((sin(dot(floor(v14), vec2f(12.9898, 78.233))) * 43758.5453123))) * t21.y) * (1.0 - t22.x))) + (((fract((sin(dot((floor(v14) + vec2f(1.0, 1.0)), vec2f(12.9898, 78.233))) * 43758.5453123)) - fract((sin(dot((floor(v14) + vec2f(1.0, 0.0)), vec2f(12.9898, 78.233))) * 43758.5453123))) * t23.x) * t24.y))));
    let t25: vec2f = vec2f(P[3], P[4]);
    v14 = ((vec2f(((t25.x * v14.x) - (t25.y * v14.y)), ((t25.x * v14.y) + (t25.y * v14.x))) * 2.0) + vec2f(100.0, 100.0));
    v16 = (v16 * 0.5);
  }
  var v26: vec2f = (((vec2f(t1.x, t1.y) + vec2f(v3, v15)) + vec2f(1.7, 9.2)) + (0.15 * t1.w));
  var v27: f32 = 0.0;
  var v28: f32 = 0.5;
  let t29: f32 = floor((((5.0 - 1.0) / 1.0) + 1.000000001));
  for (var i30: f32 = 0.0; i30 < t29; i30 += 1.0) {
    let t31: f32 = (1.0 + (i30 * 1.0));
    let t32: vec2f = (((v26 - floor(v26)) * (v26 - floor(v26))) * (3.0 - (2.0 * (v26 - floor(v26)))));
    let t33: vec2f = (((v26 - floor(v26)) * (v26 - floor(v26))) * (3.0 - (2.0 * (v26 - floor(v26)))));
    let t34: vec2f = (((v26 - floor(v26)) * (v26 - floor(v26))) * (3.0 - (2.0 * (v26 - floor(v26)))));
    let t35: vec2f = (((v26 - floor(v26)) * (v26 - floor(v26))) * (3.0 - (2.0 * (v26 - floor(v26)))));
    let t36: vec2f = (((v26 - floor(v26)) * (v26 - floor(v26))) * (3.0 - (2.0 * (v26 - floor(v26)))));
    v27 = (v27 + (v28 * ((mix(fract((sin(dot(floor(v26), vec2f(12.9898, 78.233))) * 43758.5453123)), fract((sin(dot((floor(v26) + vec2f(1.0, 0.0)), vec2f(12.9898, 78.233))) * 43758.5453123)), t32.x) + (((fract((sin(dot((floor(v26) + vec2f(0.0, 1.0)), vec2f(12.9898, 78.233))) * 43758.5453123)) - fract((sin(dot(floor(v26), vec2f(12.9898, 78.233))) * 43758.5453123))) * t33.y) * (1.0 - t34.x))) + (((fract((sin(dot((floor(v26) + vec2f(1.0, 1.0)), vec2f(12.9898, 78.233))) * 43758.5453123)) - fract((sin(dot((floor(v26) + vec2f(1.0, 0.0)), vec2f(12.9898, 78.233))) * 43758.5453123))) * t35.x) * t36.y))));
    let t37: vec2f = vec2f(P[5], P[6]);
    v26 = ((vec2f(((t37.x * v26.x) - (t37.y * v26.y)), ((t37.x * v26.y) + (t37.y * v26.x))) * 2.0) + vec2f(100.0, 100.0));
    v28 = (v28 * 0.5);
  }
  var v38: vec2f = (((vec2f(t1.x, t1.y) + vec2f(v3, v15)) + vec2f(8.3, 2.8)) + (0.126 * t1.w));
  var v39: f32 = 0.0;
  var v40: f32 = 0.5;
  let t41: f32 = floor((((5.0 - 1.0) / 1.0) + 1.000000001));
  for (var i42: f32 = 0.0; i42 < t41; i42 += 1.0) {
    let t43: f32 = (1.0 + (i42 * 1.0));
    let t44: vec2f = (((v38 - floor(v38)) * (v38 - floor(v38))) * (3.0 - (2.0 * (v38 - floor(v38)))));
    let t45: vec2f = (((v38 - floor(v38)) * (v38 - floor(v38))) * (3.0 - (2.0 * (v38 - floor(v38)))));
    let t46: vec2f = (((v38 - floor(v38)) * (v38 - floor(v38))) * (3.0 - (2.0 * (v38 - floor(v38)))));
    let t47: vec2f = (((v38 - floor(v38)) * (v38 - floor(v38))) * (3.0 - (2.0 * (v38 - floor(v38)))));
    let t48: vec2f = (((v38 - floor(v38)) * (v38 - floor(v38))) * (3.0 - (2.0 * (v38 - floor(v38)))));
    v39 = (v39 + (v40 * ((mix(fract((sin(dot(floor(v38), vec2f(12.9898, 78.233))) * 43758.5453123)), fract((sin(dot((floor(v38) + vec2f(1.0, 0.0)), vec2f(12.9898, 78.233))) * 43758.5453123)), t44.x) + (((fract((sin(dot((floor(v38) + vec2f(0.0, 1.0)), vec2f(12.9898, 78.233))) * 43758.5453123)) - fract((sin(dot(floor(v38), vec2f(12.9898, 78.233))) * 43758.5453123))) * t45.y) * (1.0 - t46.x))) + (((fract((sin(dot((floor(v38) + vec2f(1.0, 1.0)), vec2f(12.9898, 78.233))) * 43758.5453123)) - fract((sin(dot((floor(v38) + vec2f(1.0, 0.0)), vec2f(12.9898, 78.233))) * 43758.5453123))) * t47.x) * t48.y))));
    let t49: vec2f = vec2f(P[7], P[8]);
    v38 = ((vec2f(((t49.x * v38.x) - (t49.y * v38.y)), ((t49.x * v38.y) + (t49.y * v38.x))) * 2.0) + vec2f(100.0, 100.0));
    v40 = (v40 * 0.5);
  }
  var v50: vec2f = (vec2f(t1.x, t1.y) + vec2f(v27, v39));
  var v51: f32 = 0.0;
  var v52: f32 = 0.5;
  let t53: f32 = floor((((5.0 - 1.0) / 1.0) + 1.000000001));
  for (var i54: f32 = 0.0; i54 < t53; i54 += 1.0) {
    let t55: f32 = (1.0 + (i54 * 1.0));
    let t56: vec2f = (((v50 - floor(v50)) * (v50 - floor(v50))) * (3.0 - (2.0 * (v50 - floor(v50)))));
    let t57: vec2f = (((v50 - floor(v50)) * (v50 - floor(v50))) * (3.0 - (2.0 * (v50 - floor(v50)))));
    let t58: vec2f = (((v50 - floor(v50)) * (v50 - floor(v50))) * (3.0 - (2.0 * (v50 - floor(v50)))));
    let t59: vec2f = (((v50 - floor(v50)) * (v50 - floor(v50))) * (3.0 - (2.0 * (v50 - floor(v50)))));
    let t60: vec2f = (((v50 - floor(v50)) * (v50 - floor(v50))) * (3.0 - (2.0 * (v50 - floor(v50)))));
    v51 = (v51 + (v52 * ((mix(fract((sin(dot(floor(v50), vec2f(12.9898, 78.233))) * 43758.5453123)), fract((sin(dot((floor(v50) + vec2f(1.0, 0.0)), vec2f(12.9898, 78.233))) * 43758.5453123)), t56.x) + (((fract((sin(dot((floor(v50) + vec2f(0.0, 1.0)), vec2f(12.9898, 78.233))) * 43758.5453123)) - fract((sin(dot(floor(v50), vec2f(12.9898, 78.233))) * 43758.5453123))) * t57.y) * (1.0 - t58.x))) + (((fract((sin(dot((floor(v50) + vec2f(1.0, 1.0)), vec2f(12.9898, 78.233))) * 43758.5453123)) - fract((sin(dot((floor(v50) + vec2f(1.0, 0.0)), vec2f(12.9898, 78.233))) * 43758.5453123))) * t59.x) * t60.y))));
    let t61: vec2f = vec2f(P[9], P[10]);
    v50 = ((vec2f(((t61.x * v50.x) - (t61.y * v50.y)), ((t61.x * v50.y) + (t61.y * v50.x))) * 2.0) + vec2f(100.0, 100.0));
    v52 = (v52 * 0.5);
  }
  var v62: vec3f = mix(vec3f(0.101961, 0.619608, 0.666667), vec3f(0.666667, 0.666667, 0.498039), clamp(((v51 * v51) * 4.0), 0.0, 1.0));
  v62 = mix(v62, vec3f(0.0, 0.0, 0.164706), clamp(length(vec2f(v3, v15)), 0.0, 1.0));
  v62 = mix(v62, vec3f(0.666667, 1.0, 1.0), clamp(v27, 0.0, 1.0));
  let t63: vec4f = vec4f((((((v51 * v51) * v51) + ((0.6 * v51) * v51)) + (0.5 * v51)) * v62), vec4f(0.86, 0.82, 0.55, 1.0).w);
  let d = t0; let col = t63;
  let aa = clamp(0.5 - d * u.cam.z, 0.0, 1.0) * col.a;
  return vec4f(mix(u.bg.rgb, col.rgb, aa), 1.0);
}