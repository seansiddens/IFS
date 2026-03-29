// Struct byte layout (64 bytes total):
//   0  : resolution  (vec3<f32>, align=16, size=12)
//   12 : time        (f32)
//   16 : time_delta  (f32)
//   20 : frame       (u32)
//   24 : _pad        (vec2<f32>, 8 bytes — brings offset to 32 for mouse)
//   32 : mouse       (vec4<f32>)
//   48 : date        (vec4<f32>)
struct Uniforms {
  // Physical pixels (post-DPR). Divide frag_coord.xy by resolution.xy for 0..1 UV.
  // z is always 1.0 (pixel aspect ratio).
  resolution  : vec3<f32>,
  // Seconds since page load (from requestAnimationFrame).
  time        : f32,
  // Duration of the previous frame in seconds; 0.0 on the first frame.
  time_delta  : f32,
  // Frame counter, starts at 0.
  frame       : u32,
  _pad        : vec2<f32>,
  // Physical pixels, bottom-left origin (same space as frag_coord).
  // xy = current cursor pos (last mousemove).
  // zw = last mousedown pos; (0,0) if the canvas was never clicked.
  mouse       : vec4<f32>,
  // Wall-clock date: x=year, y=month (0-based), z=day (1-based), w=seconds since midnight.
  date        : vec4<f32>,
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

@fragment
fn fs_main(@builtin(position) frag_coord : vec4<f32>) -> @location(0) vec4<f32> {
  let uv = frag_coord.xy / u.resolution.xy;
  let t  = u.time * 0.4;
  let r  = 0.5 + 0.5 * sin(t + uv.x * 3.0);
  let g  = 0.5 + 0.5 * sin(t + uv.y * 3.0 + 2.0);
  let b  = 0.5 + 0.5 * sin(t + (uv.x + uv.y) * 2.0 + 4.0);
  return vec4<f32>(r, g, b, 1.0);
}
