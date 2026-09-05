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
