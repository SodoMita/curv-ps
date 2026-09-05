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
  // so a toolbar keeps equal buttons while there is room and degrades to intrinsic widths when there is not
  hstack_fit gap pad s labels b items = [
    hstack gap b items,
    for (i in 0..<count items) items.[i].w >= (text_size labels.[i] s).[X] + 2*pad,
    soft (same_w items) ];
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
`;
