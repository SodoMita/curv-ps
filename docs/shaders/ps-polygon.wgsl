
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
  let t0: vec3f = (p0 - vec3f(P[0], P[1], 0.0));
  let t1: vec3f = (vec3f(((P[2] * t0.x) + (P[3] * t0.y)), ((P[2] * t0.y) - (P[3] * t0.x)), t0.z) / P[4]);
  let t2: vec3f = (t1 - vec3f(P[5], P[6], 0.0));
  let t3: vec3f = (vec3f(((P[7] * t2.x) + (P[8] * t2.y)), ((P[7] * t2.y) - (P[8] * t2.x)), t2.z) / P[9]);
  let t4: f32 = ((atan2(t3.x, t3.y) - (2.0 * P[12]) * floor(atan2(t3.x, t3.y) / (2.0 * P[12]))) - P[12]);
  let t5: vec2f = ((length(t3) * vec2f(cos(t4), abs(sin(t4)))) - (P[13] * vec2f(P[10], P[11])));
  let t6: vec2f = vec2f(t5.x, (t5.y + clamp((-t5.y), 0.0, (P[14] * vec2f(P[10], P[11]).y))));
  let t7: f32 = (length(t6) * sign(t6.x));
  let t8: f32 = (t7 * P[9]);
  let t9: f32 = (t8 * P[4]);
  let t10: vec4f = vec4f(P[15], P[16], P[17], P[18]);
  let t11: vec3f = (p0 - vec3f(P[19], P[20], 0.0));
  let t12: vec3f = (vec3f(((P[21] * t11.x) + (P[22] * t11.y)), ((P[21] * t11.y) - (P[22] * t11.x)), t11.z) / P[23]);
  let t13: vec3f = (t12 - vec3f(P[24], P[25], 0.0));
  let t14: vec3f = (vec3f(((P[26] * t13.x) + (P[27] * t13.y)), ((P[26] * t13.y) - (P[27] * t13.x)), t13.z) / P[28]);
  let t15: f32 = ((atan2(t14.x, t14.y) - (2.0 * P[31]) * floor(atan2(t14.x, t14.y) / (2.0 * P[31]))) - P[31]);
  let t16: vec2f = ((length(t14) * vec2f(cos(t15), abs(sin(t15)))) - (P[32] * vec2f(P[29], P[30])));
  let t17: vec2f = vec2f(t16.x, (t16.y + clamp((-t16.y), 0.0, (P[33] * vec2f(P[29], P[30]).y))));
  let t18: f32 = (length(t17) * sign(t17.x));
  let t19: f32 = (t18 * P[28]);
  let t20: f32 = (t19 * P[23]);
  let t21: vec4f = vec4f(P[34], P[35], P[36], P[37]);
  let t22: f32 = min(t9, t20);
  let t23: f32 = (clamp((0.5 - (t9 * u.cam.z)), 0.0, 1.0) * t10.w);
  let t24: f32 = (clamp((0.5 - (t20 * u.cam.z)), 0.0, 1.0) * t21.w);
  let t25: f32 = (t24 + (t23 * (1.0 - t24)));
  let t26: vec4f = vec4f(select((((vec3f(t21.x, t21.y, t21.z) * t24) + ((vec3f(t10.x, t10.y, t10.z) * t23) * (1.0 - t24))) / max(t25, 0.00001)), vec3f(t10.x, t10.y, t10.z), (t25 < 0.00001)), min(1.0, (t25 / max(clamp((0.5 - (t22 * u.cam.z)), 0.0, 1.0), 0.00001))));
  let t27: vec3f = (p0 - vec3f(P[38], P[39], 0.0));
  let t28: vec3f = (vec3f(((P[40] * t27.x) + (P[41] * t27.y)), ((P[40] * t27.y) - (P[41] * t27.x)), t27.z) / P[42]);
  let t29: vec3f = (t28 - vec3f(P[43], P[44], 0.0));
  let t30: vec3f = (vec3f(((P[45] * t29.x) + (P[46] * t29.y)), ((P[45] * t29.y) - (P[46] * t29.x)), t29.z) / P[47]);
  let t31: f32 = ((atan2(t30.x, t30.y) - (2.0 * P[50]) * floor(atan2(t30.x, t30.y) / (2.0 * P[50]))) - P[50]);
  let t32: vec2f = ((length(t30) * vec2f(cos(t31), abs(sin(t31)))) - (P[51] * vec2f(P[48], P[49])));
  let t33: vec2f = vec2f(t32.x, (t32.y + clamp((-t32.y), 0.0, (P[52] * vec2f(P[48], P[49]).y))));
  let t34: f32 = (length(t33) * sign(t33.x));
  let t35: f32 = (t34 * P[47]);
  let t36: f32 = (t35 * P[42]);
  let t37: vec4f = vec4f(P[53], P[54], P[55], P[56]);
  let t38: f32 = min(t22, t36);
  let t39: f32 = (clamp((0.5 - (t22 * u.cam.z)), 0.0, 1.0) * t26.w);
  let t40: f32 = (clamp((0.5 - (t36 * u.cam.z)), 0.0, 1.0) * t37.w);
  let t41: f32 = (t40 + (t39 * (1.0 - t40)));
  let t42: vec4f = vec4f(select((((vec3f(t37.x, t37.y, t37.z) * t40) + ((vec3f(t26.x, t26.y, t26.z) * t39) * (1.0 - t40))) / max(t41, 0.00001)), vec3f(t26.x, t26.y, t26.z), (t41 < 0.00001)), min(1.0, (t41 / max(clamp((0.5 - (t38 * u.cam.z)), 0.0, 1.0), 0.00001))));
  let t43: vec3f = (p0 - vec3f(P[57], P[58], 0.0));
  let t44: vec3f = (vec3f(((P[59] * t43.x) + (P[60] * t43.y)), ((P[59] * t43.y) - (P[60] * t43.x)), t43.z) / P[61]);
  let t45: vec3f = (t44 - vec3f(P[62], P[63], 0.0));
  let t46: vec3f = (vec3f(((P[64] * t45.x) + (P[65] * t45.y)), ((P[64] * t45.y) - (P[65] * t45.x)), t45.z) / P[66]);
  let t47: f32 = ((atan2(t46.x, t46.y) - (2.0 * P[69]) * floor(atan2(t46.x, t46.y) / (2.0 * P[69]))) - P[69]);
  let t48: vec2f = ((length(t46) * vec2f(cos(t47), abs(sin(t47)))) - (P[70] * vec2f(P[67], P[68])));
  let t49: vec2f = vec2f(t48.x, (t48.y + clamp((-t48.y), 0.0, (P[71] * vec2f(P[67], P[68]).y))));
  let t50: f32 = (length(t49) * sign(t49.x));
  let t51: f32 = (t50 * P[66]);
  let t52: f32 = (t51 * P[61]);
  let t53: vec4f = vec4f(P[72], P[73], P[74], P[75]);
  let t54: f32 = min(t38, t52);
  let t55: f32 = (clamp((0.5 - (t38 * u.cam.z)), 0.0, 1.0) * t42.w);
  let t56: f32 = (clamp((0.5 - (t52 * u.cam.z)), 0.0, 1.0) * t53.w);
  let t57: f32 = (t56 + (t55 * (1.0 - t56)));
  let t58: vec4f = vec4f(select((((vec3f(t53.x, t53.y, t53.z) * t56) + ((vec3f(t42.x, t42.y, t42.z) * t55) * (1.0 - t56))) / max(t57, 0.00001)), vec3f(t42.x, t42.y, t42.z), (t57 < 0.00001)), min(1.0, (t57 / max(clamp((0.5 - (t54 * u.cam.z)), 0.0, 1.0), 0.00001))));
  let t59: vec3f = (p0 - vec3f(P[76], P[77], 0.0));
  let t60: vec3f = (vec3f(((P[78] * t59.x) + (P[79] * t59.y)), ((P[78] * t59.y) - (P[79] * t59.x)), t59.z) / P[80]);
  let t61: vec3f = (t60 - vec3f(P[81], P[82], 0.0));
  let t62: vec3f = (vec3f(((P[83] * t61.x) + (P[84] * t61.y)), ((P[83] * t61.y) - (P[84] * t61.x)), t61.z) / P[85]);
  let t63: f32 = ((atan2(t62.x, t62.y) - (2.0 * P[88]) * floor(atan2(t62.x, t62.y) / (2.0 * P[88]))) - P[88]);
  let t64: vec2f = ((length(t62) * vec2f(cos(t63), abs(sin(t63)))) - (P[89] * vec2f(P[86], P[87])));
  let t65: vec2f = vec2f(t64.x, (t64.y + clamp((-t64.y), 0.0, (P[90] * vec2f(P[86], P[87]).y))));
  let t66: f32 = (length(t65) * sign(t65.x));
  let t67: f32 = (t66 * P[85]);
  let t68: f32 = (t67 * P[80]);
  let t69: vec4f = vec4f(P[91], P[92], P[93], P[94]);
  let t70: f32 = min(t54, t68);
  let t71: f32 = (clamp((0.5 - (t54 * u.cam.z)), 0.0, 1.0) * t58.w);
  let t72: f32 = (clamp((0.5 - (t68 * u.cam.z)), 0.0, 1.0) * t69.w);
  let t73: f32 = (t72 + (t71 * (1.0 - t72)));
  let t74: vec4f = vec4f(select((((vec3f(t69.x, t69.y, t69.z) * t72) + ((vec3f(t58.x, t58.y, t58.z) * t71) * (1.0 - t72))) / max(t73, 0.00001)), vec3f(t58.x, t58.y, t58.z), (t73 < 0.00001)), min(1.0, (t73 / max(clamp((0.5 - (t70 * u.cam.z)), 0.0, 1.0), 0.00001))));
  let t75: vec3f = (p0 - vec3f(P[95], P[96], 0.0));
  let t76: vec2f = ((abs(vec2f(t75.x, t75.y)) - vec2f(P[97], P[98])) + 0.0);
  let t77: f32 = ((length(max(t76, vec2f(0.0))) + min(max(t76.x, t76.y), 0.0)) - 0.0);
  var v78: f32 = (t77 + (1.5 / u.cam.z));
  var v79: vec4f = vec4f(0.0, 0.0, 0.0, 0.0);
  if ((t77 < (1.5 / u.cam.z))) {
    var v80: f32 = dot((p0 - vec3f(P[u32(P[99])], P[u32((P[99] + 1.0))], 0.0)), (p0 - vec3f(P[u32(P[99])], P[u32((P[99] + 1.0))], 0.0)));
    var v81: f32 = 1.0;
    for (var i82: f32 = 0.0; i82 < 5.0; i82 += 1.0) {
      let t83: f32 = ((i82 + 4.0) - 5.0 * floor((i82 + 4.0) / 5.0));
      let t84: vec3f = vec3f(P[u32(((P[99] + (i82 * 2.0)) + 0.0))], P[u32(((P[99] + (i82 * 2.0)) + 1.0))], 0.0);
      let t85: vec3f = vec3f(P[u32(((P[99] + (t83 * 2.0)) + 0.0))], P[u32(((P[99] + (t83 * 2.0)) + 1.0))], 0.0);
      let t86: vec3f = (t85 - t84);
      let t87: vec3f = (p0 - t84);
      let t88: vec3f = (t87 - (t86 * clamp((dot(t87, t86) / max(dot(t86, t86), 1.0e-9)), 0.0, 1.0)));
      v80 = min(v80, dot(t88, t88));
      if (((((p0.y >= t84.y) & (p0.y < t85.y)) & (((t86.x * t87.y) - (t86.y * t87.x)) > 0.0)) | (((!(p0.y >= t84.y)) & (!(p0.y < t85.y))) & (!(((t86.x * t87.y) - (t86.y * t87.x)) > 0.0))))) {
        v81 = (-v81);
      }
    }
    let t89: f32 = (v81 * sqrt(v80));
    let t90: vec4f = vec4f(P[100], P[101], P[102], P[103]);
    v78 = t89;
    v79 = t90;
  }
  let t91: f32 = min(t70, v78);
  let t92: f32 = (clamp((0.5 - (t70 * u.cam.z)), 0.0, 1.0) * t74.w);
  let t93: f32 = (clamp((0.5 - (v78 * u.cam.z)), 0.0, 1.0) * v79.w);
  let t94: f32 = (t93 + (t92 * (1.0 - t93)));
  let t95: vec4f = vec4f(select((((vec3f(v79.x, v79.y, v79.z) * t93) + ((vec3f(t74.x, t74.y, t74.z) * t92) * (1.0 - t93))) / max(t94, 0.00001)), vec3f(t74.x, t74.y, t74.z), (t94 < 0.00001)), min(1.0, (t94 / max(clamp((0.5 - (t91 * u.cam.z)), 0.0, 1.0), 0.00001))));
  let d = t91; let col = t95;
  let aa = clamp(0.5 - d * u.cam.z, 0.0, 1.0) * col.a;
  return vec4f(mix(u.bg.rgb, col.rgb, aa), 1.0);
}