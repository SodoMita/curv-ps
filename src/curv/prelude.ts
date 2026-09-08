// Standard prelude, written in Curv.  Parsed as a record so every definition
// is visible to user programs.  Everything lives in ordinary Curv space:
// y up, origin in the middle, one coordinate system for shapes and layout.
//
// A "box" is a plain record {x, y, w, h} whose (x, y) is the bottom-left
// corner — exactly a Curv bbox [[x,y],[x+w,y+h]] — with derived fields
// left/right/bottom/top/cx/cy/center/size/pos.  Solver variables of type
// `box` produce the same record with affine expressions inside.
export const PRELUDE = `
  // ---- palette ----
  ink = "#0b0f1a"; surface = "#141a2a"; surface_2 = "#1d2537"; surface_3 = "#273044";
  border = "#2e3950"; muted = "#7c8aa5"; fg = "#e6ebf5"; fg_dim = "#a9b4c9";
  accent = "#7c5cff"; accent_2 = "#22d3ee"; accent_3 = "#f472b6"; success = "#34d399"; warning = "#fbbf24"; danger = "#fb7185";

  // ---- geometry helpers ----
  ring d w = stroke w (circle d);
  fill c s = colour c s;
  // box helpers (records, not shapes)
  box_at c sz = box (c.[X] - sz.[X]/2, c.[Y] - sz.[Y]/2, sz.[X], sz.[Y]);   // centred box
  bbox_box s = box (s.bbox.[0].[X], s.bbox.[0].[Y], s.bbox.[1].[X] - s.bbox.[0].[X], s.bbox.[1].[Y] - s.bbox.[0].[Y]);
  // place a shape's bbox inside a box (centre it)
  fit_in b s = s >> translate (b.cx - (s.bbox.[0].[X] + s.bbox.[1].[X])/2, b.cy - (s.bbox.[0].[Y] + s.bbox.[1].[Y])/2);

  // ---- layout combinators ----
  // These return *constraint values* (a comparison on solver variables evaluates to a
  // constraint instead of a boolean).  Use them as statements inside solve { }:
  //     var cards : box[6];  grid 14 3 main cards;  weak: same_h [side, main];
  // All boxes are y-up: the first item of a vstack is at the top.
  same_w items = [for (i in 1..<count items) items.[i].w == items.[0].w];
  same_h items = [for (i in 1..<count items) items.[i].h == items.[0].h];
  same_size items = [same_w items, same_h items];
  align_left items = [for (i in 1..<count items) items.[i].left == items.[0].left];
  align_right items = [for (i in 1..<count items) items.[i].right == items.[0].right];
  align_top items = [for (i in 1..<count items) items.[i].top == items.[0].top];
  align_bottom items = [for (i in 1..<count items) items.[i].bottom == items.[0].bottom];
  align_cx items = [for (i in 1..<count items) items.[i].cx == items.[0].cx];
  align_cy items = [for (i in 1..<count items) items.[i].cy == items.[0].cy];
  size_of sz b = [b.w == sz.[X], b.h == sz.[Y]];
  min_size sz b = [b.w >= sz.[X], b.h >= sz.[Y]];
  max_size sz b = [b.w <= sz.[X], b.h <= sz.[Y]];
  aspect r b = b.w == r * b.h;
  // inner fills outer with a margin (equalities) / stays inside it (inequalities) / shares its centre
  pin pad outer inner = [inner.left == outer.left + pad, inner.right == outer.right - pad,
                         inner.bottom == outer.bottom + pad, inner.top == outer.top - pad];
  inside pad outer inner = [inner.left >= outer.left + pad, inner.right <= outer.right - pad,
                            inner.bottom >= outer.bottom + pad, inner.top <= outer.top - pad];
  centre_in outer inner = [inner.cx == outer.cx, inner.cy == outer.cy];
  center_in = centre_in;
  // items laid out left-to-right / top-to-bottom, filling box b; widths (heights) stay free
  hstack gap b items = [
    items.[0].left == b.left,  items.[count items - 1].right == b.right,
    for (i in 1..<count items) items.[i].left == items.[i-1].right + gap,
    for (it in items) [it.top == b.top, it.bottom == b.bottom] ];
  vstack gap b items = [
    items.[0].top == b.top,  items.[count items - 1].bottom == b.bottom,
    for (i in 1..<count items) items.[i].top == items.[i-1].bottom - gap,
    for (it in items) [it.left == b.left, it.right == b.right] ];
  // hstack / vstack with equal-sized items
  hsplit gap b items = [hstack gap b items, same_w items];
  vsplit gap b items = [vstack gap b items, same_h items];
  // equal cells, cols per row, filling b exactly (rows = ceil (n / cols))
  grid gap cols b items = let n = count items; rows = ceil (n / cols); in [
    same_size items,
    for (i in 0..<n) [
      items.[i].left == b.left + (i % cols) * (items.[0].w + gap),
      items.[i].top == b.top - floor (i / cols) * (items.[0].h + gap) ],
    b.left + cols * items.[0].w + (cols - 1) * gap == b.right,
    b.top - rows * items.[0].h - (rows - 1) * gap == b.bottom ];

  // ---- intrinsic sizes & priorities ----
  // Constraint values can carry their own strength:  soft c · strength "medium" c · weight 3 c
  // (an explicit tag wins over the strength of the statement that adds it).
  // b is large enough for label t at font size s, with pad on every side
  fit_text pad s t b = [b.w >= (text_size t s).[X] + 2*pad, b.h >= (text_size t s).[Y] + 2*pad];
  // b has exactly the label's intrinsic size (+ padding)
  hug_text pad s t b = [b.w == (text_size t s).[X] + 2*pad, b.h == (text_size t s).[Y] + 2*pad];
  // hstack whose items are at least as wide as their labels; the slack is shared equally (softly),
  // so a toolbar keeps equal buttons while there is room and degrades to intrinsic widths when
  // there is not.  The minimum-width bounds are *required*: below the total minimum the system
  // goes infeasible — adapt the label set instead (fit_labels), psolve's active-set QP degenerates
  // on tens of parallel softened inequalities.
  hstack_fit gap pad s labels b items = [
    hstack gap b items,
    for (i in 0..<count items) items.[i].w >= (text_size labels.[i] s).[X] + 2*pad,
    soft (same_w items) ];
  // adaptation combinator: the longest prefix of labels (plus at least the first one) whose chips
  // at font size s with the given gap/padding fit maxw (a number).  Decided with font metrics here,
  // so the solver only sees the visible row:  buttons = fit_labels 6 14 13 (viewport.w - 44) names;
  fit_labels gap pad s maxw labels = do
    local out = []; local x = 0;
    for (t in labels) (
      local w = (text_size t s).[X] + 2 * pad;
      if (count out == 0 || x + w + gap <= maxw) ( out := [...out, t]; x := x + w + gap; );
    );
  in out;
  // wrapping flow layout: items of known sizes (a list of (w,h)) are packed left-to-right into rows
  // no wider than maxw (a number), top-down from b's top-left corner; b.h becomes the total height.
  // Wrapping is decided here (greedily), so only positions are constraints.
  flow gap maxw b items sizes = do
    local x = 0; local y = 0; local rowh = 0; local out = [];
    for (i in 0 ..< count items) (
      local w = sizes.[i].[X]; local h = sizes.[i].[Y];
      if (x > 0 && x + w > maxw) ( x := 0; y := y + rowh + gap; rowh := 0; );
      out := [...out, items.[i].left == b.left + x, items.[i].top == b.top - y, items.[i].w == w, items.[i].h == h];
      x := x + w + gap; rowh := max [rowh, h];
    );
  in [out, b.h == y + rowh];
  // convenience: flow of text chips (labels at font size s, padding pad)
  flow_text gap maxw pad s labels b items = flow gap maxw b items [for (t in labels) text_size t s + 2*pad];
  // wrapping flow that fits a budget: dynamically choose the largest font size ≤ s whose greedy
  // wrap fits (maxw × maxh), then lay out like flow_text.  The wrap is computed here by bisection
  // over the measured chip widths (font metrics; 8 steps ≈ 1% precision), so the result is a plain
  // number again — use it for the font size of the chips and export it through a solved variable:
  //     var fsz : num;  F = flow_fit 8 chip_w maxh 8 14 labels tagbox chips;  F.cells;  fsz == F.size;
  //     …; in text tags.[i] L.fsz
  flow_fit gap maxw maxh pad s labels b items = do
    local lo = 0.5 * s; local hi = s;
    for (i in 0..7) (
      local m = (lo + hi) / 2;
      local x = 0; local rows = 1;
      for (t in labels) (
        local w = (text_size t m).[X] + 2 * pad;
        if (x > 0 && x + w > maxw) ( rows := rows + 1; x := w + gap; ) else x := x + w + gap;
      );
      local rowh = 1.25 * m + 2 * pad;
      if (rows * rowh + (rows - 1) * gap <= maxh) ( lo := m; ) else ( hi := m; );
    );
  in { size: lo, cells: flow_text gap maxw pad lo labels b items };

  // ---- components built from boxes ----
  card b = frame_r 16 b >> colour surface;
  card_c c b = frame_r 16 b >> colour c;
  panel b = union [ frame_r 14 b >> colour surface_2, frame_r 14 b >> stroke 1 >> colour border ];
  button b label = union [
    frame_r 10 b >> gradient (accent, "#5b3df5") ((b.x, b.top), (b.x, b.bottom)),
    text label 14 >> colour white >> at b ];
  ghost_button b label = union [
    frame_r 10 b >> stroke 1.5 >> colour border,
    text label 14 >> colour fg_dim >> at b ];
  pill b label c = union [ frame_r (b.h/2) b >> colour c, text label 12 >> colour ink >> at b ];
  label_at b s c t = text t s >> colour c >> at b;
  avatar b initials = union [
    frame_r (b.w/2) b >> gradient (accent_2, accent) ((b.x, b.top), (b.right, b.bottom)),
    text initials (b.h*0.42) >> colour white >> at b ];
  divider b = frame b >> colour border;
  progress b t c = union [ frame_r (b.h/2) b >> colour surface_3,
    frame_r (b.h/2) (box (b.x, b.y, max(b.w*t, b.h), b.h)) >> colour c ];
  slider_track b t = union [
    frame_r (b.h/2) b >> colour surface_3,
    frame_r (b.h/2) (box (b.x, b.y, b.w*t, b.h)) >> colour accent,
    circle (b.h*2.6) >> colour white >> translate (b.x + b.w*t, b.cy) >> shadow (0, -2) 6 ];
  toggle b on = union [
    frame_r (b.h/2) b >> colour (if on then success else surface_3),
    circle (b.h - 6) >> colour white >> translate ((if on then b.right - b.h/2 else b.x + b.h/2), b.cy) ];
  bar b = frame_r 6 b;
  layout_debug b = frame b >> stroke 1 >> colour accent_3;

  // ---- C++ std.curv parity: constants, math, lists, colours, shapes ----
  // index constants (X/Y/Z/T are builtins) and unit axes
  MIN = 0;
  MAX = 1;
  RE = 0;   // [RE, IM] complex convention
  IM = 1;
  X_axis = [1, 0, 0];
  Y_axis = [0, 1, 0];
  Z_axis = [0, 0, 1];
  // characters
  dol = char 36;
  tab = char 9;
  nl  = char 10;
  quot = char 34;
  // list / matrix helpers (C++ names)
  id x = x;
  product = reduce [1, [x, y] -> x*y];
  contains [list, x] =
    do
      local i = 0;
      while (i < count list && list.[i] != x) i := i + 1;
    in i < count list;
  sort a =
    if count a == 0 then []
    else do
      local first = a.[0];
      local rest = [for (i in 1..<count a) a.[i]];
    in [...sort [for (e in rest) if (e < first) e], first, ...sort [for (e in rest) if (e >= first) e]];
  perp [x, y] = [-y, x];
  idmatrix n = [for (i in 1..n) [for (j in 1..n) if (i == j) 1 else 0]];
  transpose a =
    if count a == 0 then a
    else [for (i in indices a.[0]) [for (j in indices a) a.[[j, i]]]];
  encode = ucode;
  decode = char;
  // C++-named colours the palette did not have (sRGB.hue as in std.curv)
  azure = sRGB.hue (7/12);
  indigo = sRGB.hue (3/4);
  rose = sRGB.hue (11/12);
  chartreuse = sRGB [1, 1, 0];
  spring_green = sRGB [0, 1, 0.5];
  // implicit fields
  i_linear d p = mod [p.[X]/d, 1];
  i_radial n p = mod [(phase [p.[X], p.[Y]]/tau - 0.25)*n, 1];
  i_concentric d p = mod [mag [p.[X], p.[Y]]/d, 1];
  i_gyroid p = (cos p.[X]*sin p.[Y] + cos p.[Y]*sin p.[Z] + cos p.[Z]*sin p.[X] + 1.5)/3;
  i_animate period ifield p = mod [ifield p + p.[T]/period, 1];
  show_ifield ifield = colour [ifield, sRGB.grey] everything;
  show_colour c = colour c everything;
  show_cmap f = union [
    rect [4.05, 1.05] >> colour grey,
    rect [4, 1] >> colour (p -> f ((p.[X]+2)/4)) ];
  // set the rendered bbox (C++ set_bbox, via a make_shape wrapper)
  set_bbox bbox s =
    make_shape {
      dist p = s.dist [p.[X], p.[Y], p.[Z], p.[T]];
      colour p = s.colour [p.[X], p.[Y], p.[Z], p.[T]];
      bbox = bbox;
      is_3d = s.is_3d;
      is_2d = s.is_2d;
    };
  // 2D polyline: a rounded polyline through points v of thickness d (C++ std.curv, crossing-number)
  polyline {d, v} =
    make_shape {
      dist p =
        do
          local p2 = [p.[X], p.[Y]];
          local num = count v;
          local d2 = dot [p2 - v.[0], p2 - v.[0]];
          local s = 1;
          local j = num - 1;
          for (i in 0..<num) (
            local e = v.[j] - v.[i];
            local w = p2 - v.[i];
            local b = w - e*clamp [dot [w, e]/dot [e, e], 0, 1];
            d2 := min [d2, dot [b, b]];
            local c1 = p2.[Y] >= v.[i].[Y];
            local c2 = p2.[Y] < v.[j].[Y];
            local c3 = e.[X]*w.[Y] > e.[Y]*w.[X];
            if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s := -s;
            j := i;
          );
        in s * sqrt d2 - d/2;
      bbox = [[min (map (q -> q.[X]) v), min (map (q -> q.[Y]) v)], [max (map (q -> q.[X]) v), max (map (q -> q.[Y]) v)]];
      is_2d = true;
    };
  // C++ aliases
  convex_polygon pts = polygon pts;
  prism n d h = regular_polygon_d n d >> extrude h;
  symmetric_difference shapes = difference [union shapes, intersection shapes];
  reflect_x s = reflect [1, 0] s;
  reflect_y s = reflect [0, 1] s;
  reflect_z s = reflect [0, 0, 1] s;
  reflect_xy s = reflect [1, -1] s;
  reflect_xz s = reflect [1, 0, -1] s;
  reflect_yz s = reflect [0, 1, -1] s;
`;
