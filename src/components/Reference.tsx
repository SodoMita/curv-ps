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
    title: "Layout helpers (same Curv space, y up)",
    rows: [
      ["circle d · rect (w,h) · rrect (w,h) r · ellipse (w,h)", "centred primitives"],
      ["line (p1,p2) th · half_plane n · nothing", ""],
      ["text \"hi\" 14 · text_left \"hi\" 14 · text_width \"hi\" 14", "SDF glyphs; text_width is a number you can constrain on"],
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
