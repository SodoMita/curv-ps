export interface Example { id: string; name: string; blurb: string; src: string; group: "solve" | "curv" }

// One coordinate system for everything: ordinary Curv space (y up, origin in the
// middle, arbitrary units).  `solve { }` is just another way of producing numbers.
// Programs that mention `viewport` (the visible world rectangle) are responsive:
// they are re-solved whenever the canvas or the camera changes.
export const EXAMPLES: Example[] = [
  {
    group: "solve",
    id: "packed",
    name: "Packed circles",
    blurb: "Constraints in plain Curv units, no pixels: circles of given diameters touch their neighbours and the row is centred; the camera fits the result.",
    src: `// Constraints are an extension of ordinary Curv: the solve block
// returns numbers, and those numbers feed regular shape operators.
let
  d = [3, 1.5, 2.2, 0.9, 2.8, 1.2, 2];
  n = count d;  gap = 0.25;
  L = solve {
    var x : num[n];
    for (i in 1..n-1) x.[i] - x.[i-1] == (d.[i] + d.[i-1]) / 2 + gap;   // tangent + gap
    x.[0] - d.[0]/2 == -(x.[n-1] + d.[n-1]/2);                          // symmetric about x = 0
  };
  hue i = sRGB.HSV (i / n, 0.55, 0.95);
in union [
  for (i in 0..n-1)
    circle d.[i] >> translate (L.x.[i], d.[i]/2) >> colour (hue i),
  for (i in 0..n-1)
    text (d.[i]) 0.5 >> colour ink >> translate (L.x.[i], d.[i]/2),
  line ((L.x.[0] - d.[0]/2 - 1, 0), (L.x.[n-1] + d.[n-1]/2 + 1, 0)) 0.06 >> colour muted,
]`,
  },
  {
    group: "solve",
    id: "split",
    name: "Responsive split",
    blurb: "Cassowary-style layout against the visible `viewport` box: resize the canvas (or zoom) and psolve re-solves the constraints.",
    src: `// Two panes sharing the viewport.  Nothing here is positioned by hand:
// every x/y/w/h comes out of the \`solve\` block, which psolve (convex QP,
// active-set) solves in microseconds whenever the viewport changes.
// Coordinates are ordinary Curv: y up, origin in the centre of the view.
let
  pad = 20;
  L = solve {
    var left, right : box;

    left.left == viewport.left + pad;      left.top == viewport.top - pad;
    left.right + 16 == right.x;            right.top == left.top;
    right.right == viewport.right - pad;
    left.bottom == viewport.bottom + pad;
    right.h == left.h;

    left.w == 2 * right.w;                 // the classic AutoLayout ratio
    weak: right.w == 260;                  // preferred width, yields under pressure
  };
in union [
  card L.left,
  card L.right,
  text "left.w == 2 * right.w" 16 >> colour fg >> at L.left,
  text (strcat ["left ", round L.left.w, " units"]) 13 >> colour muted
    >> translate (L.left.cx, L.left.cy - 28),
  text (strcat ["right ", round L.right.w, " units"]) 13 >> colour muted
    >> translate (L.right.cx, L.right.cy - 28),
  text "right" 16 >> colour fg >> at L.right,
  text "viewport = visible world rect (y up)" 11 >> colour muted
    >> translate (0, viewport.bottom + 8),
]`,
  },
  {
    group: "solve",
    id: "dashboard",
    name: "Dashboard",
    blurb: "Sidebar, header and an equal-width card grid — all from one constraint system, with soft preferences.",
    src: `// A whole dashboard from one solve block.  Try dragging the preview
// width: the sidebar shrinks between its bounds before the cards do.
let
  pad = 16; gap = 14; n = 6; cols = 3;
  L = solve {
    var side, head, main : box;
    var cards : box[n];

    // frame (y up: top is the larger y)
    side.left == viewport.left + pad;  side.top == viewport.top - pad;
    side.bottom == viewport.bottom + pad;
    head.top == side.top;              head.h == 56;
    head.x == side.right + gap;        head.right == viewport.right - pad;
    main.x == head.x;                  main.right == head.right;
    main.top == head.bottom - gap;     main.bottom == side.bottom;

    // sidebar prefers 200 but may compress
    weak: side.w == 200;   side.w >= 96;   side.w <= 220;

    // 3-column grid of equal cards filling main (a prelude combinator: it
    // returns constraints, see the "Layout combinators" example)
    grid gap cols main cards;
  };
  titles = ["Revenue", "Sessions", "Latency", "Errors", "Signups", "Churn"];
  values = ["$48.2k", "128k", "42 ms", "0.3%", "1,204", "1.9%"];
  ratios = [0.72, 0.55, 0.31, 0.12, 0.64, 0.22];
  colours = [accent, accent_2, success, danger, accent_3, warning];
  nav i = box (L.side.x + 12, L.side.top - 96 - i*40, L.side.w - 24, 32);
in union [
  card L.side,
  avatar (box (L.side.x + 12, L.side.top - 48, 36, 36)) "CV",
  for (i in 0..4)
    union [ frame_r 8 (nav i) >> colour (if i == 0 then surface_3 else surface),
            circle 8 >> colour (if i == 0 then accent else border)
              >> translate ((nav i).x + 14, (nav i).cy) ],
  panel L.head,
  text_left "Overview" 18 >> colour fg >> translate (L.head.x + 18, L.head.cy - 6),
  button (box (L.head.right - 116, L.head.cy - 17, 104, 34)) "New report",
  for (i in 0..n-1)
    let b = cards.[i]; in union [
      card b,
      text_left titles.[i] 12 >> colour muted >> translate (b.x + 16, b.top - 26),
      text_left values.[i] 22 >> colour fg >> translate (b.x + 16, b.top - 56),
      progress (box (b.x + 16, b.y + 18, b.w - 32, 6)) ratios.[i] colours.[i],
    ]
] where cards = L.cards`,
  },
  {
    group: "solve",
    id: "stacks",
    name: "Layout combinators",
    blurb: "hstack / vstack / grid / pin are ordinary prelude functions that *return constraints*: a comparison on solver variables is a first-class value, so layouts compose.",
    src: `// Comparisons on solver variables evaluate to constraint values, so plain
// functions can generate constraints.  The prelude ships a small set of
// AutoLayout-style combinators; \`fit_col\` below is a user-defined one.
let
  pad = 16; gap = 12;
  fit_col b items = [ vstack gap b items, same_h items ];          // your own combinator
  L = solve {
    var root, head, body, foot : box;
    var cols : box[3];  var rows : box[4];  var cells : box[6];

    pin pad viewport root;                 // root = viewport minus a margin
    vstack gap root [head, body, foot];    // top-to-bottom (y up: head is at the top)
    head.h == 52;  foot.h == 30;

    hstack gap body cols;                  // left-to-right, widths still free…
    weak: same_w cols;                     // …prefer equal columns
    cols.[0].w >= 120;  cols.[2].w <= 220; // but bounded

    fit_col (inset 10 cols.[0]) rows;      // 4 equal rows in the first column
    grid 8 2 (inset 10 cols.[1]) cells;    // 2 x 3 grid in the second

    var logo : box;  size_of (36, 36) logo;
    logo.left == head.left + 12;  logo.cy == head.cy;
  };
  hue i = sRGB.HSV (0.55 + i * 0.06, 0.6, 0.95);
in union [
  panel L.head, panel L.foot,
  avatar L.logo "C+",
  text_left "vstack gap root [head, body, foot]" 14 >> colour fg >> translate (L.logo.right + 12, L.head.cy - 5),
  for (c in L.cols) card c,
  for (i in 0..3) union [ frame_r 6 L.rows.[i] >> colour surface_3,
                          text (strcat ["row ", i]) 12 >> colour fg_dim >> at L.rows.[i] ],
  for (i in 0..5) frame_r 6 L.cells.[i] >> colour (hue i),
  text "cols.[2]" 13 >> colour muted >> at L.cols.[2],
  text (strcat ["cols ", round L.cols.[0].w, " / ", round L.cols.[1].w, " / ", round L.cols.[2].w]) 12
    >> colour muted >> at L.foot,
]`,
  },
  {
    group: "solve",
    id: "buttons",
    name: "Intrinsic sizing",
    blurb: "Buttons measure their labels (text_width) and the solver distributes the leftover space.",
    src: `// Content-driven layout: each button must be at least as wide as its
// label + padding, all buttons share one width if possible (weak), and
// the row is centred in the viewport.  Change a label and watch it re-flow.
let
  labels = ["Cancel", "Save draft", "Publish now", "Schedule for later"];
  n = count labels;  gap = 10;  h = 42;
  L = solve {
    var b : box[n];
    var row : box;
    row.h == h;   row.center == (0, 0);          // centred in the view
    row.w <= viewport.w - 32;
    for (i in 0..n-1) {
      b.[i].h == h;   b.[i].y == row.y;
      b.[i].w >= text_width labels.[i] 14 + 36;  // intrinsic minimum
      weak: b.[i].w == b.[0].w;                  // equal widths when room allows
    }
    b.[0].x == row.x;
    for (i in 1..n-1) b.[i].x == b.[i-1].right + gap;
    b.[n-1].right == row.right;
    maximize row.w;                              // stretch (bounded above)
  };
in union [
  frame_r 14 (inset (-14) L.row) >> colour surface,
  ghost_button L.b.[0] labels.[0],
  ghost_button L.b.[1] labels.[1],
  button L.b.[2] labels.[2],
  button L.b.[3] labels.[3],
  text "b[i].w >= text_width label 14 + 36" 12 >> colour muted
    >> translate (0, L.row.bottom - 44),
]`,
  },
  {
    group: "solve",
    id: "toolbar",
    name: "Toolbar & wrapping tags",
    blurb: "hstack_fit sizes a toolbar from its labels; flow_text wraps chips of intrinsic size into rows; soft / strength tag priorities inside combinators. Resize the preview to see it reflow.",
    src: `// Intrinsic sizes + wrapping.  hstack_fit keeps the toolbar's buttons equal
// while there is room and falls back to label widths when there is not (the
// equality is tagged \`soft\` inside the combinator).  flow_text decides the
// line breaks from the measured chip sizes, so only positions are solved.
let
  pad = 16; gap = 10;
  tools = ["File", "Edit", "View", "Insert", "Format", "Tools", "Window", "Help"];
  tags  = ["WebGPU", "F-Rep", "Curv", "psolve", "LP + QP", "WGSL", "kerning: AVATAR WAVE", "Latin-1: café · naïve · Ærø",
           "→ arrows ←", "≤ ≥ ≠ ≈ ∞", "★ ✓ ♥", "£ € ° ±", "Constraint values", "hstack_fit", "flow_text", "soft", "strength", "weight"];
  chip_w = viewport.w - 2*pad - 2*14;      // width available to the chip flow (a number)
  L = solve {
    var root, bar, body, tagbox, footer, space : box;
    var buttons : box[count tools];
    var chips : box[count tags];
    pin pad viewport root;
    vstack gap root [bar, body, footer, space];    // top-down; heights still free…
    bar.h == 44;  footer.h == 28;  space.h >= 0;   // …the trailing space absorbs the slack
    hstack_fit 6 14 13 tools (inset 6 bar) buttons;  // buttons ≥ label width, equal if possible (soft)
    // chips wrap inside the body; the flow decides tagbox.h from the measured sizes
    tagbox.left == body.left + 14;  tagbox.top == body.top - 14;
    flow_text 8 chip_w 8 12 tags tagbox chips;
    body.h >= tagbox.h + 28;                       // the body must contain them…
    weight 4 (body.h == tagbox.h + 28);            // …and prefers to hug them (a tagged soft constraint)
    strength "strong" (space.h <= viewport.h / 3); // priorities: strong < required, so tiny viewports still solve
  };
  chip b t = union [ frame_r (b.h/2) b >> colour surface_3, frame_r (b.h/2) b >> stroke 1 >> colour border,
                     text t 12 >> colour fg >> at b ];
in union [
  panel L.bar,
  for (i in 0 ..< count tools) (if (i == 2) then button L.buttons.[i] tools.[i] else ghost_button L.buttons.[i] tools.[i]),
  card L.body,
  for (i in 0 ..< count tags) chip L.chips.[i] tags.[i],
  text (strcat ["flow_text 8 ", round chip_w, " · body.h = ", round L.body.h, " · ", count tags, " chips in ",
                round ((L.tagbox.h + 8) / (12*1.25 + 16 + 8)), " rows"]) 12 >> colour muted >> at L.footer,
]`,
  },
  {
    group: "solve",
    id: "tooltip",
    name: "Constrained tooltip",
    blurb: "Move the mouse: the tooltip wants to follow the cursor (weak) but must stay inside the viewport (required).",
    src: `// Soft goals vs. hard limits.  The tooltip *wants* to sit centred above
// the cursor, but it *must* stay 10 units inside the viewport.  psolve
// finds the least-squares compromise (this is an honest convex QP).
let
  title = "tip.cx == mouse.x  (weak)";
  L = solve {
    var tip, arrow : box;
    tip.w == text_width title 12 + 32;  tip.h == 54;   // sized by its label
    arrow.size == (14, 14);
    weak: tip.cx == mouse.x;
    weak: tip.bottom == mouse.y + 18;                  // above the cursor (y up)
    tip.left >= viewport.left + 10;    tip.right <= viewport.right - 10;
    tip.bottom >= viewport.bottom + 10; tip.top <= viewport.top - 10;
    arrow.cx == tip.cx;  arrow.cy == tip.bottom;
    medium: arrow.cx == mouse.x;
  };
  label = strcat ["(", round mouse.x, ", ", round mouse.y, ")"];
  v = viewport;
in union [
  frame v >> gradient (surface, ink) ((0, v.top), (0, v.bottom)),
  for (x in 0..v.right by 40) line ((x, v.bottom), (x, v.top)) 1 >> colour surface_2,
  for (x in 0..v.right by 40) line ((-x, v.bottom), (-x, v.top)) 1 >> colour surface_2,
  for (y in 0..v.top by 40) line ((v.left, y), (v.right, y)) 1 >> colour surface_2,
  for (y in 0..v.top by 40) line ((v.left, -y), (v.right, -y)) 1 >> colour surface_2,
  circle 10 >> colour accent_2 >> translate mouse.pos,
  ring 26 2 >> colour accent_2 >> opacity 0.5 >> translate mouse.pos,
  union [
    rect (14, 14) >> rotate (pi/4) >> colour surface_3 >> at L.arrow,
    frame_r 12 L.tip >> colour surface_3,
  ] >> shadow (0, -6) 14,
  text title 12 >> colour fg >> translate (L.tip.cx, L.tip.top - 20),
  text label 12 >> colour muted >> translate (L.tip.cx, L.tip.top - 38),
]`,
  },
  {
    group: "solve",
    id: "chart",
    name: "Animated chart",
    blurb: "Bars re-solved every frame: equal spacing, bounded widths, heights from data driven by time.",
    src: `// Live data + layout solver at 60 fps.  Bar spacing/width is decided
// by psolve (LP/QP), the bar heights are plain Curv math on \`time\`.
let
  n = 12;  pad = 28;  gap_min = 6;
  data = [for (i in 0..n-1) 0.5 + 0.45 * sin (time*1.3 + i*0.7) * cos (time*0.4 + i)];
  L = solve {
    var plot : box;   var bars : box[n];   var gap;
    plot.left == viewport.left + pad;   plot.right == viewport.right - pad;
    plot.top == viewport.top - pad;     plot.bottom == viewport.bottom + pad + 24;
    gap >= gap_min;
    for (i in 0..n-1) {
      bars.[i].w == bars.[0].w;   bars.[i].bottom == plot.bottom;
      bars.[i].h == plot.h * data.[i];
      bars.[i].w <= 64;
    }
    bars.[0].x == plot.x;
    for (i in 1..n-1) bars.[i].x == bars.[i-1].right + gap;
    bars.[n-1].right == plot.right;
    weak: gap == 14;                       // preferred gap; width absorbs the rest
  };
in union [
  frame_r 18 (inset (-12) L.plot) >> colour surface,
  for (k in 0..4) line ((L.plot.x, L.plot.y + k*L.plot.h/4), (L.plot.right, L.plot.y + k*L.plot.h/4)) 1 >> colour border,
  for (i in 0..n-1)
    frame_r 6 L.bars.[i] >> gradient (accent, accent_2) ((0, L.plot.bottom), (0, L.plot.top)),
  for (i in 0..n-1)
    text (round (data.[i] * 100)) 11 >> colour muted
      >> translate (L.bars.[i].cx, L.bars.[i].top + 10),
  text (strcat ["gap = ", round L.gap, "   bar = ", round L.bars.[0].w]) 12
    >> colour muted >> translate (0, viewport.bottom + 16),
]`,
  },
  {
    group: "solve",
    id: "frep",
    name: "F-Rep + solve",
    blurb: "Classic Curv signed-distance CSG (smooth union, difference, offset) in world units; the solver only places the parts.",
    src: `// Curv's soul: shapes are distance fields, combined with CSG.  The
// solver only decides *where* the three blobs live — in plain units,
// with no viewport involved, so the camera simply fits the shape.
let
  L = solve {
    var a, b, c : box;
    a.size == (8, 8);  b.size == (6, 6);  c.size == (4.5, 4.5);
    a.cy == 0;  b.cy == a.cy + 2;  c.cy == a.cy - 2.5;
    b.x == a.cx + 1;   c.x == b.cx + 0.5;
    a.cx + (c.right - a.x) / 2 == 0;      // group centred on the origin
  };
  blob = smooth_union 1.5 [
    circle a.w >> translate a.center,
    circle b.w >> translate b.center,
    rrect c.size 1 >> rotate (time*0.7) >> translate c.center,
  ] where {a = L.a; b = L.b; c = L.c};
  hole = circle 3.5 >> translate (L.a.cx - 1.5, L.a.cy - 0.5);
  body = difference [blob, hole >> offset (0.5 * sin time)];
in union [
  body >> gradient (accent, accent_3) ((L.a.x, 0), (L.c.right, 0)),
  body >> stroke 0.1 >> colour white >> opacity 0.35,
  hole >> stroke 0.05 >> colour accent_2 >> opacity 0.6,
  text "difference [smooth_union 1.5 [..], circle 3.5]" 0.6 >> colour muted
    >> translate (0, -7),
]`,
  },
  {
    group: "curv",
    id: "mandelbrot",
    name: "Mandelbrot",
    blurb: "curv/examples/mandelbrot.curv \u2014 a make_shape whose colour function runs a 100-iteration escape loop in the fragment shader (do/local/:=/for \u2026 until).",
    src: "make_shape {\n    dist = everything.dist;\n    colour [x,y,_,_] =\n        do\n            local z = [x,y];\n            local hsv = [0,0,0];\n            local done = false;\n            for (i in 0 ..< 100 until done) (\n                z := csqr z + [x,y];\n                if (dot[z,z] > 4) (\n                    local cr = (i-1)-log(log(dot[z,z])/log 2)/log 2;\n                    hsv := [0.95+.012*cr, 1, .2+.4*(1+sin(.3*cr))];\n                    done := true;\n                )\n            );\n        in sRGB.HSV hsv;\n    bbox = [[-2.5,-2,-2],[1.5,2,2]];\n    is_2d = true;\n}",
  },
  {
    group: "curv",
    id: "liquid_paint",
    name: "Liquid paint",
    blurb: "curv/examples/liquid_paint.curv \u2014 parametric sliders + animated plasma texture (uses t = time).",
    src: "// Liquid Paint 2D plasma.\n// try: Iter=2, Amp=3 and zoom out a bit\n// Inspired by: http://glslsandbox.com/e#8067.3\n\nparametric\n    Iter :: int_slider[0,50] = 50;\n    Amp :: slider[0,3] = 0.6;\n    Speed :: slider[0,4] = 1;\nin\nmake_shape {\n    colour [x,y,z,t] =\n        do\n            local p = [x,y];\n            local t = t*Speed;\n            for (i in 1..Iter)\n                p := p + Amp/i*sin(i*p.[[Y,X]] + t + [0,tau/2]) + 1;\n        in sRGB[0.5*sin(3.0*p.[X])+0.5, 0.5*sin(3.0*p.[Y])+0.5, sin(p.[X]+p.[Y])];\n    dist p = -inf;\n    bbox = [[-1,-1,0],[1,1,0]];\n    is_2d = true;\n}",
  },
  {
    group: "curv",
    id: "log_spiral",
    name: "Log spiral",
    blurb: "curv/examples/log_spiral.curv \u2014 user distance field with nested lets and an if/else in SubCurv.",
    src: "// Logarithmic spiral.\n// https://swiftcoder.wordpress.com/2010/06/21/logarithmic-spiral-distance-field/\n//\n// `s` is a scaling parameter. You could also use `scale(s)`.\n//\n// Growth rate parameter `g` controls how tightly and in which direction\n// the spiral spirals.\n// `g=0.1759` is a measured growth rate for a Nautilus shell.\n// This implementation requires 0 < g < 1 for a counterclockwise spiral,\n// or -1 < g < 0 for a clockwise spiral.\n//\n// The spiral makes a constant angle t with any radius vector.\n// You can define `g` as `cot t`.\n//\n// Distance field looks okay for g=.2, is bonkers for more extreme values.\n\nlet\n    log_spiral [s, g] = make_shape {\n        dist [x,y,_,_] =\n            let r = mag[x,y];\n                t = phase[x,y];\n            in if (r == 0)\n                0\n            else\n                let n = (log(r/s)/g - t) / tau;\n                    upper_r = s * e^(g*(t+tau*ceil n));\n                    lower_r = s * e^(g*(t+tau*floor n));\n                in (min[abs(upper_r-r), abs(r-lower_r)] - r*abs g)\n                    / 1.24; /* empirical Lipschitz factor for g=.2 */\n        is_2d = true;\n    };\n\nin\nlog_spiral [1, 0.2]",
  },
  {
    group: "curv",
    id: "plot",
    name: "Function plot",
    blurb: "curv/examples/plot.curv \u2014 plot f = make_shape { dist p = p.[Y] - f(p.[X]) } >> show_axes. Drag to pan, wheel to zoom.",
    src: "let\n    plot f = make_shape {\n        dist p = p.[Y] - f(p.[X]);\n        is_2d = true;\n    } >> show_axes;\n\nin\nplot (x->sin x * sin(x*10))",
  },
  {
    group: "curv",
    id: "polygon",
    name: "Polygons",
    blurb: "curv/examples/polygon.curv \u2014 regular_polygon, polygon, list comprehension, sRGB.hue, move/rotate/colour.",
    src: "let\n    n = 5;\nin\nunion [\n    for (i in 0..<n)\n        regular_polygon (i+3) >> move[0,3] >> rotate(tau/n*i)\n          >> colour (sRGB.hue(i/n)),\n    polygon ([for (a in 0..<tau by tau/5) cis(a+tau/4)*2].[[0,2,4,1,3]])\n        >> colour black\n]",
  },
  {
    group: "curv",
    id: "smoke",
    name: "Smoke",
    blurb: "curv/examples/smoke.curv \u2014 fbm noise (Book of Shaders) as a colour function; loops with := on let-bound variables.",
    src: "// Credit: Patricio Gonzalez 2015 https://thebookofshaders.com/13/\n\nlet\n    random xy = frac(sin(dot[xy, [12.9898,78.233]])*43758.5453123);\n\n    // Based on Morgan McGuire @morgan3d\n    // https://www.shadertoy.com/view/4dS3Wd\n    noise xy =\n        let i = floor xy;\n            f = xy - i;\n\n            // Four corners in 2D of a tile\n            a = random(i);\n            b = random(i + [1, 0]);\n            c = random(i + [0, 1]);\n            d = random(i + [1, 1]);\n\n            u = f * f * (3 - 2 * f);\n\n        in lerp[a, b, u.[X]] +\n            (c - a) * u.[Y] * (1 - u.[X]) +\n            (d - b) * u.[X] * u.[Y];\n\n    fbm xy =\n        let shift = [100,100];\n            rot = cis(0.5);   // Rotate to reduce axial bias\n            st = xy;\n            v = 0;\n            a = 0.5;\n        in do\n            for (i in 1..5) (\n                v := v + a * noise st;\n                st := cmul[rot, st] * 2 + shift;\n                a := a * 0.5;\n            );\n        in v;\n\n    smoke [x,y,z,t] =\n        let st = [x,y];\n            q = [ fbm(st), fbm(st + 1) ];\n            r = [ fbm(st + q + [1.7,9.2] + 0.150*t),\n                  fbm(st + q + [8.3,2.8] + 0.126*t) ];\n            f = fbm(st + r);\n            c = lerp[[0.101961,0.619608,0.666667],\n                     [0.666667,0.666667,0.498039],\n                     clamp[f*f*4, 0, 1]];\n        in do\n            c := lerp[c,\n                     [0,0,0.164706],\n                     clamp[mag q, 0, 1]];\n            c := lerp[c,\n                     [0.666667,1,1],\n                     clamp[r.[X], 0, 1]];\n        in (f*f*f+.6*f*f+.5*f)*c;\n\nin\ncircle 2 >> colour smoke",
  },
  {
    group: "curv",
    id: "voronoi",
    name: "Voronoi",
    blurb: "curv/examples/voronoi.curv \u2014 make_texture with nested for loops in a do block.",
    src: "let\n    random2f[x,y] =\n        let t = sin(x+y*1e3);\n        in [frac(t*1e4), frac(t*1e6)];\n\n    voronoi[x,y] =\n        do\n            local p = floor[x,y];\n            local f = frac[x,y];\n            local res = 8;\n            for (i in -1 .. 1)\n                for (j in -1 .. 1) (\n                    local b = [i,j];\n                    local r = b - f + random2f(p+b);\n                    local d = dot[r,r];\n                    res := min[res, d];\n                )\n        in sqrt res;\n\nin\nmake_texture ([x,y,_,_] -> sRGB.grey(voronoi[x,y]))",
  },
  {
    group: "curv",
    id: "circlattice",
    name: "Circle lattice",
    blurb: "curv/examples/circlattice.curv \u2014 repeat_xy, shell, << reverse pipe.",
    src: "let\n    c = repeat_xy [2,2] << shell .2 << colour black << circle 2;\nin\nunion[c,translate[1,1]<<c]",
  },
  {
    group: "curv",
    id: "peppermint",
    name: "Peppermint",
    blurb: "curv/examples/peppermint.curv \u2014 rect{xmin}, repeat_radial, swirl, into intersection, parametric sliders.",
    src: "// demo of 'swirl' transformation\n\nparametric\n    Swirl_Strength: ss :: slider[-10,10] = 4;\n    Swirl_Diameter: sd :: slider[4,40] = 16;\nin\nunion[rect{xmin:0} >> colour red, rect{xmax:0} >> colour(sRGB[1,1,.8])]\n  >> repeat_radial 8\n  >> swirl{strength: ss, d: sd}\n  >> into intersection [circle 8]\n  >> pancake 2",
  },
];
