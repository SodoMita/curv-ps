const sections: { title: string; rows: [string, string][] }[] = [
  {
    title: "solve { … }  (the extension)",
    rows: [
      ["var a, b;", "scalar unknowns"],
      ["var p : point;  var b : box;", "point [x,y]; box {x,y,w,h} with (x,y) = bottom-left (y up) + derived left/right/bottom/top, cx, cy, center, size, pos"],
      ["var cards : box[n];", "list of n unknown boxes (cards.[i])"],
      ["a.right + 10 == b.x;", "required linear constraint (==, <=, >=; chains like 0 <= x <= w)"],
      ["weak: b.w == 200;", "soft constraint: weak | medium | strong, optional weight: weak 3: …"],
      ["minimize (a.w - 1.618*a.h)^2;", "linear or convex-quadratic objective (also maximize)"],
      ["for (i in 0..n-1) { … }", "loops / if (c) { … } generate constraints; name = expr; binds locals"],
      ["L = solve { … };  L.a.w", "an ordinary expression: returns a record of plain numbers (+ L.solver.status / time_ms / engine) for any shape operator"],
      ["viewport.left/right/top/bottom/w/h/cx/cy", "the visible world rectangle as a box record; constraining against it makes a layout responsive (re-solved on resize/pan/zoom)"],
      ["c = a.w == 2*b.w;  [c, b.h >= 40]", "a comparison on solver variables is a first-class constraint value (lists / boxes broadcast); any statement whose value holds constraints adds them, `weak:` etc. apply to the whole value"],
      ["my_rule b items = [ … constraints … ];", "so ordinary functions are layout combinators; box (x,y,w,h) and inset d box accept solver expressions"],
      ["fit_labels gap pad s maxw labels", "numeric adaptation: the longest prefix (+1) whose chips fit maxw, from font metrics — drop items instead of going infeasible"],
      ["F = flow_fit gap maxw maxh pad s labels b items;", "wrap like flow_text but first bisect the largest font ≤ s whose rows fit maxh; read F.size (export via a var) and add F.cells"],
    ],
  },
  {
    title: "layout combinators (prelude, return constraints)",
    rows: [
      ["hstack gap b items · vstack gap b items", "items fill box b left→right / top→bottom with `gap` between them (sizes along the axis stay free)"],
      ["hsplit gap b items · vsplit gap b items", "hstack / vstack with equal-sized items"],
      ["grid gap cols b items", "equal cells, `cols` per row, filling b exactly"],
      ["pin pad outer inner · inside pad outer inner · centre_in outer inner", "inner fills outer minus a margin (==) · stays inside it (<=, >=) · shares its centre"],
      ["same_w · same_h · same_size · align_left/right/top/bottom/cx/cy  items", "equalities between list items"],
      ["size_of (w,h) b · min_size (w,h) b · max_size (w,h) b · aspect r b", "size constraints on one box"],
      ["fit_text pad s t b · hug_text pad s t b", "b is at least (exactly) as big as label t at font size s, plus padding"],
      ["hstack_fit gap pad s labels b items", "hstack whose items are ≥ their label widths; equal widths are only a `soft` preference"],
      ["flow gap maxw b items sizes · flow_text gap maxw pad s labels b items", "wrapping flow: items of known (w,h) packed into rows ≤ maxw (a number) from b's top-left; b.h == total height"],
      ["soft c · strength \"medium\" c · weight 3 c", "tag constraint values with their own priority (wins over the statement's strength); weight multiplies weak"],
    ],
  },
  {
    title: "Curv shapes (2D)",
    rows: [
      ["make_shape { dist p = …; colour p = …; bbox = [[x0,y0,0],[x1,y1,0]]; is_2d = true }", "user distance/colour functions compiled to the GPU (SubCurv: let, if, do/local/:=/for/while, vectors, math)"],
      ["make_texture (p -> colour) · colour f shape · texture f shape", "procedural colour functions (p = [x,y,z,t])"],
      ["circle d · square d · rect [w,h] · rect {xmin,xmax,ymin,ymax} · ellipse [w,h] · regular_polygon n · polygon [pts] · half_plane {d,normal} · stroke {d,from,to} · everything · nothing", "primitives"],
      ["union · intersection · difference · complement · smooth k .union · morph t [a,b] · offset d · shell d · lipschitz k", "CSG & distance operators"],
      ["move [x,y] · rotate a · scale k|[sx,sy] · reflect v · repeat_x d · repeat_xy [dx,dy] · repeat_radial n · repeat_mirror_x · swirl {strength,d} · row · into f [..] · show_axes · show_bbox", "transforms"],
      ["sRGB [r,g,b] · sRGB.HSV · sRGB.hue h · sRGB.grey g · webRGB · red/green/blue/…", "colours"],
      ["parametric Name :: slider[lo,hi] = v; … in shape", "sliders (also int_slider, checkbox, scale_picker, colour_picker)"],
      ["phase · cis · cmul · csqr · mag · dot · cross · normalize · lerp [a,b,t] · clamp [x,lo,hi] · smoothstep · mod [a,b] · frac · sign · min/max/sum [..] · bit", "math (vectorised)"],
    ],
  },
  {
    title: "3D shapes (solid raymarch view)",
    rows: [
      ["Preview bar: 2D ⇄ 3D toggle", "2D = the z = 0 slice of the tree; 3D = solid raymarch of the same tree — separate cameras, only one ever renders; drag orbits, wheel/pinch zooms, fit frames the 3D bounding box"],
      ["sphere d|[dx,dy,dz] · ellipsoid [dx,dy,dz] · box3 [w,h,d] | (lo,hi) | {xmin,…} · cube", "primitives take DIAMETERS (C++ std.curv convention); cube = box3 alias"],
      ["cylinder d | {d,h,mode} · cone d | {d,h} · capped_cone {h,bottom,top} · capsule {from,to,d} · torus {major,minor}", "d = diameter, h = full height (mode: 'mitred'); capsule from/to are 3-points; capped_cone bottom/top = base diameters"],
      ["revolve s · perimeter_extrude p c · loft h [a,b] · extrude h s · extrude_mitred h s", "surface of revolution · sweep cross-section c around profile p · interpolate a→b over distance h · lift a 2D shape to height h (mitred caps optional)"],
      ["twist a s · bend {angle,d} s · shear_x k s · local_taper_x {range,scale} s · local_taper_xy {range,scale} s", "warp operators: twist rate around Z · roll into a cylinder of diameter d over `angle` · x-shear · x(x,y)-taper across a y-range"],
      ["gyroid", "cos x sin y + cos y sin z + cos z sin x; period 2π, field ∈ [−3,3], Lipschitz 4/3 (C++ reference)"],
      ["slice_xy s · slice_xz s · slice_yz s", "a 2D shape: the coordinate-plane section of s (is_2d — draws in the 2D view)"],
      ["repeat_xyz [dx,dy,dz] s · repeat_finite [dx,dy,dz] [nx,ny,nz] s", "periodic tiling · the same, bounded to an n box"],
      ["distance_field s · show_gradient [j,k] s · show_dist s", "diagnostics: raw field · gradient magnitude as a rainbow (black ≤ j, white ≥ k, HSV between) · field as grey; with a 3D child they union the shape in the solid view (C++ semantics)"],
      ["chamfer r .union [..] · .intersection · .difference", "CSG with a fillet/chamfer radius r"],
      ["warp_domain_xy {inverse, fix_distance} s", "domain warp: inverse (x,y)→(x',y') remaps the shape, fix_distance rescales the warped field"],
      ["translate [x,y,z] · rotate {angle, axis} s · scale [sx,sy,sz] · stretch [sx,sy,sz] · reflect [nx,ny,nz] s", "3D transforms; rotate = Rodrigues rotation about an arbitrary axis"],
      ["s.is_2d · s.is_3d · s.bbox", "shape-record fields follow the true dimensionality (3D shapes report a 3D bbox; show_dist/show_gradient are both, as in C++)"],
    ],
  },
  {
    title: "Layout helpers (same Curv space, y up)",
    rows: [
      ["circle d · rect (w,h) · rrect (w,h) r · ellipse (w,h)", "centred primitives"],
      ["line (p1,p2) th · half_plane n · nothing", ""],
      ["text \"hi\" 14 · text_left \"hi\" 14 · text_width \"hi\" 14 · text_size \"hi\" 14", "SDF glyphs (ASCII + Latin-1 + →←≤≥★✓…, kerned); text_width / text_size (w,h) are numbers you can constrain on"],
      ["box (x,y,w,h) · box_at c sz · inset d b · bbox_box s", "box records (x,y = bottom-left corner)"],
      ["frame b · frame_r r b · at b shape · fit_in b shape", "turn a box into a rect / place a shape at a box"],
      ["union [..] · intersection [..] · difference [a,b]", "CSG; union composes colours painter-style"],
      ["smooth_union k [..] · offset r · stroke w", "F-Rep operators on the distance field"],
      ["colour c · opacity a · gradient (c1,c2) (p0,p1) · shadow (dx,dy) blur", "appearance (colours: \"#hex\", (r,g,b), white, accent, …); shadow (0,-4) drops downwards"],
      ["translate (x,y) · rotate a · scale k · shape >> op", "transforms and Curv's pipe"],
      ["card b · panel b · button b \"label\" · avatar b \"AB\" · progress b t c · toggle b on", "prelude components written in Curv"],
    ],
  },
  {
    title: "Core Curv",
    rows: [
      ["let a = 1; f x = x*2; in …  /  expr where (…)", "definitions"],
      ["x -> x+1 · [a,b] -> a*b · f a b (curried) · a >> f · f << a", "functions & pipes"],
      ["do local x = 0; for (i in 1..n until done) x := x + i; in x", "imperative blocks (compiled to shader loops inside make_shape)"],
      ["[for (i in 0..9) if (i%2==0) i*i] · 1..10 by 2 · 0..<n", "comprehensions & ranges"],
      ["{a: 1, b: 2} · r.a · list.[i] · count · sum · map · strcat", "records, lists"],
      ["viewport · time · mouse.x/y/pos/down", "live inputs in world units: re-evaluated on viewport change / every frame (pause button) / on move"],
    ],
  },
  {
    title: "What is cached between frames",
    rows: [
      ["solve { … }  → memoised", "a block whose free variables (incl. shapes, closures, time/mouse/viewport) have the same values as before is not re-evaluated at all"],
      ["solve { … }  → cached", "re-evaluated, but the numeric problem was seen before: presolve + psolve skipped"],
      ["f x  (pure user functions)", "calls dearer than twice their key hash (~≥25 µs warm, adaptive) are memoised on (function, free variables, argument); results are immutable so the same tree is reused — `x := outer`, `parametric` and `print` disable it. The status line shows hits/calls"],
      ["whole program → static", "a program that read no time/mouse/viewport and whose src and parametric inputs are unchanged is not re-evaluated at all — pan/zoom of a static scene only re-renders (status line: 'static')"],
      ["shader", "a tree with the same structure only refills its parameter buffer (no recompile); programs animated only inside shader code ([x,y,z,t]) just get a new time uniform; resolution adapts to the GPU + CPU budget"],
    ],
  },
];

export function Reference() {
  return (
    <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
      {sections.map((s) => (
        <div key={s.title}>
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">{s.title}</h4>
          <dl className="space-y-1.5">
            {s.rows.map(([k, v]) => (
              <div key={k} className="rounded-md border border-line/60 bg-surface/50 px-3 py-1.5">
                <dt className="font-mono text-[11.5px] text-accent-2">{k}</dt>
                {v && <dd className="text-[11.5px] text-muted">{v}</dd>}
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}
