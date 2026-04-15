// Struct byte layout (80 bytes total):
//   0  : resolution  (vec3<f32>, align=16, size=12)
//   12 : time        (f32)
//   16 : time_delta  (f32)
//   20 : frame       (u32)
//   24 : mode        (u32)
//   28 : colormap    (u32)
//   32 : mouse       (vec4<f32>)
//   48 : date        (vec4<f32>)
//   64 : zoom_pan    (vec4<f32>)  x=center_re, y=center_im, z=scale, w=unused
struct Uniforms {
  resolution  : vec3<f32>,
  time        : f32,
  time_delta  : f32,
  frame       : u32,
  // 0 = Julia Rotating, 1 = Julia/Mandelbrot side-by-side, 2 = Julia Tiling
  mode        : u32,
  // 0=Jet, 1=Hot, 2=Cool, 3=Viridis, 4=Grayscale, 5=Rainbow
  colormap    : u32,
  mouse       : vec4<f32>,
  date        : vec4<f32>,
  // Camera for the Julia/complex plane view.
  // xy = center in complex coords, z = zoom scale (1.0 = default).
  zoom_pan    : vec4<f32>,
}

@group(0) @binding(0) var<uniform> u : Uniforms;

// Full-screen triangle — no vertex buffer needed.
@vertex
fn vs_main(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  var pos = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  return vec4<f32>(pos[vi], 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Fractal helpers
// ---------------------------------------------------------------------------

const MAX_ITER: i32 = 500;

// ---------------------------------------------------------------------------
// Colormap functions — all accept t in [0, 1].
// ---------------------------------------------------------------------------

fn colormap_jet(t: f32) -> vec3<f32> {
  var r: f32; var g: f32; var b: f32;
  if (t < 0.7) { r = 4.0 * t - 1.5; } else { r = -4.0 * t + 4.5; }
  if (t < 0.5) { g = 4.0 * t - 0.5; } else { g = -4.0 * t + 3.5; }
  if (t < 0.3) { b = 4.0 * t + 0.5; } else { b = -4.0 * t + 2.5; }
  return clamp(vec3<f32>(r, g, b), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn colormap_hot(t: f32) -> vec3<f32> {
  // black → red → yellow → white
  return clamp(vec3<f32>(t * 3.0, t * 3.0 - 1.0, t * 3.0 - 2.0), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn colormap_cool(t: f32) -> vec3<f32> {
  // cyan → magenta
  return vec3<f32>(t, 1.0 - t, 1.0);
}

fn colormap_viridis(t: f32) -> vec3<f32> {
  // Piecewise linear approximation of Viridis.
  let c0 = vec3<f32>(0.267, 0.005, 0.329);
  let c1 = vec3<f32>(0.283, 0.141, 0.558);
  let c2 = vec3<f32>(0.128, 0.566, 0.551);
  let c3 = vec3<f32>(0.369, 0.788, 0.383);
  let c4 = vec3<f32>(0.993, 0.906, 0.144);
  let s  = clamp(t, 0.0, 1.0) * 4.0;
  let f  = fract(s);
  let i  = i32(s);
  if (i == 0) { return mix(c0, c1, f); }
  if (i == 1) { return mix(c1, c2, f); }
  if (i == 2) { return mix(c2, c3, f); }
  return mix(c3, c4, clamp(f, 0.0, 1.0));
}

fn colormap_gray(t: f32) -> vec3<f32> {
  return vec3<f32>(clamp(t, 0.0, 1.0));
}

// Compact HSV → RGB (no branches).
fn hsv2rgb(h: f32, s: f32, v: f32) -> vec3<f32> {
  let k = vec3<f32>(1.0, 2.0 / 3.0, 1.0 / 3.0);
  let p = abs(fract(h + k) * 6.0 - 3.0);
  return v * mix(vec3<f32>(1.0), clamp(p - 1.0, vec3<f32>(0.0), vec3<f32>(1.0)), s);
}

fn colormap_rainbow(t: f32) -> vec3<f32> {
  // Full hue cycle — used with fract(mu * period) for cyclic banding.
  return hsv2rgb(t, 1.0, 1.0);
}

// Apply the selected colormap. Interior (INTERIOR sentinel) → black.
// All exterior points (mu can be negative for quick-escape) are colored via
// fract so the palette cycles continuously with no black bands.
fn colorize(mu: f32, map: u32) -> vec3<f32> {
  if (mu > 1.0e10) { return vec3<f32>(0.0); } // interior sentinel
  // Jet receives mu*0.03 raw: per-component clamping gives dim blue for
  // slightly-negative mu fading to black further out (original behaviour).
  // Smooth colormaps clamp to [0,1]: negative mu → start of palette (dark),
  // avoiding the fract wrap that was mapping outer regions to the bright end.
  // Rainbow stays fully cyclic.
  let t = clamp(mu * 0.03, 0.0, 1.0);
  switch map {
    case 1u: { return colormap_hot(t); }
    case 2u: { return colormap_cool(t); }
    case 3u: { return colormap_viridis(t); }
    case 4u: { return colormap_gray(t); }
    case 5u: { return colormap_rainbow(fract(mu * 0.07)); }
    default: { return colormap_jet(mu * 0.03); }
  }
}

// ---------------------------------------------------------------------------
// Fractal iteration
// ---------------------------------------------------------------------------

// Complex squaring: z^2
fn sq(n: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(n.x * n.x - n.y * n.y, 2.0 * n.x * n.y);
}

// Interior sentinel — larger than any possible exterior mu (which is ≤ MAX_ITER ≈ 500).
const INTERIOR: f32 = 1.0e20;

// Returns smooth iteration count for exterior points, or INTERIOR for the set.
// Exterior mu can be negative (quick-escape points far from the boundary).
fn smooth_iter(z_in: vec2<f32>, c: vec2<f32>) -> f32 {
  var z = z_in;
  var iter: i32 = 0;
  for (var i: i32 = 0; i < MAX_ITER; i++) {
    if (dot(z, z) >= 4.0) { break; }
    z = sq(z) + c;
    iter++;
  }
  if (iter == MAX_ITER) { return INTERIOR; }
  // Two extra iterations reduce the smooth-coloring error term.
  z = sq(z) + c;
  z = sq(z) + c;
  return f32(iter) - log(log(length(z))) / log(2.0);
}

// Maps a pixel coordinate `px` inside a panel [origin .. origin+size] to
// complex-plane coordinates centered at (cx, cy), `span` units wide.
// Y is bottom-left origin (matching frag_coord / mouse convention).
fn to_complex(
  px          : vec2<f32>,
  panel_origin: vec2<f32>,
  panel_size  : vec2<f32>,
  cx          : f32,
  cy          : f32,
  span        : f32,
) -> vec2<f32> {
  let uv     = (px - panel_origin) / panel_size; // [0,1]^2
  let aspect = panel_size.y / panel_size.x;
  return vec2<f32>(
    (uv.x - 0.5) * span          + cx,
    (uv.y - 0.5) * span * aspect + cy,
  );
}

// ---------------------------------------------------------------------------
// Fragment shader
// ---------------------------------------------------------------------------

// Tile size for mode 2 (Julia Tiling) is passed via zoom_pan.w (see main.ts).

@fragment
fn fs_main(@builtin(position) frag : vec4<f32>) -> @location(0) vec4<f32> {
  let res    = u.resolution.xy;
  let cx     = u.zoom_pan.x;
  let cy     = u.zoom_pan.y;
  let scale  = u.zoom_pan.z;
  let span   = 4.0 / scale;   // base span is 4 units; shrinks as scale grows

  // ------------------------------------------------------------------
  // Mode 0: Julia Rotating
  // Full screen shows the Julia set for c rotating around a circle.
  // Scroll wheel zooms into the complex plane toward the cursor.
  // ------------------------------------------------------------------
  if (u.mode == 0u) {
    let z = to_complex(frag.xy, vec2<f32>(0.0), res, cx, cy, span);
    let c = vec2<f32>(0.5 * cos(u.time), 0.5 * sin(u.time));
    return vec4<f32>(colorize(smooth_iter(z, c), u.colormap), 1.0);
  }

  // ------------------------------------------------------------------
  // Mode 2: Julia Tiling
  // The complex plane is divided into cells of size TILE_SIZE.
  // Each cell shows the Julia set for c = its center coordinate.
  // Start with the tiling camera at high scale (one tile fills screen → c=0 Julia set).
  // Zoom out to watch the Mandelbrot set emerge from the tile boundaries.
  // ------------------------------------------------------------------
  if (u.mode == 2u) {
    let ts      = u.zoom_pan.w;  // tile size in complex units, controlled via ImGui
    let z_world = to_complex(frag.xy, vec2<f32>(0.0), res, cx, cy, span);
    // Snap to the nearest tile center (tile centers sit on the ts lattice).
    let tile   = round(z_world / ts);
    let c      = tile * ts;
    // Local position within the tile in [-0.5, 0.5]^2.
    // Zoom factor 3 (was 4) crops the outer quick-escape ring so the Julia
    // set boundary fills more of each tile with less empty exterior.
    let z_iter = (z_world - c) / ts * 3.0;
    return vec4<f32>(colorize(smooth_iter(z_iter, c), u.colormap), 1.0);
  }

  // ------------------------------------------------------------------
  // Mode 1: Side-by-side Mandelbrot / Julia
  // Left  = Mandelbrot with zoom/pan (zoom_pan carries the Mandelbrot camera).
  // Right = Julia set for c = Mandelbrot coordinate under the cursor.
  //         A small dot follows the cursor in the left panel as an indicator.
  // ------------------------------------------------------------------
  let half_size = vec2<f32>(res.x * 0.5, res.y);
  let mand_span = 3.5 / scale;   // Mandelbrot base span is 3.5

  // Cursor position: mouse.xy is bottom-left → convert to top-left for to_complex.
  let cursor_px = vec2<f32>(min(u.mouse.x, res.x * 0.5 - 1.0), res.y - u.mouse.y);
  let mouse_c   = to_complex(cursor_px, vec2<f32>(0.0), half_size, cx, cy, mand_span);

  if (frag.x < res.x * 0.5) {
    // Left — Mandelbrot; draw a cursor-following dot showing the active c.
    let c = to_complex(frag.xy, vec2<f32>(0.0), half_size, cx, cy, mand_span);
    var color = colorize(smooth_iter(vec2<f32>(0.0), c), u.colormap);
    let d    = length(frag.xy - cursor_px);
    let fill = smoothstep(5.0, 3.5, d);
    let ring = (1.0 - fill) * smoothstep(7.0, 5.5, d);
    color = mix(color, vec3<f32>(0.05), ring);
    color = mix(color, vec3<f32>(1.0, 0.95, 0.2), fill);
    return vec4<f32>(color, 1.0);
  } else {
    // Right — Julia set for the cursor's Mandelbrot coordinate.
    let z = to_complex(frag.xy, vec2<f32>(res.x * 0.5, 0.0), half_size, 0.0, 0.0, 4.0);
    return vec4<f32>(colorize(smooth_iter(z, mouse_c), u.colormap), 1.0);
  }
}
