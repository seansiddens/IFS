import { ImGui, ImGuiImplWeb } from "@mori2003/jsimgui";
import shaderSource from "./shader.wgsl?raw";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const fallback = document.getElementById("fallback") as HTMLDivElement;

async function init() {
  if (!navigator.gpu) {
    canvas.style.display = "none";
    fallback.style.display = "grid";
    return;
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter found.");
  const device = await adapter.requestDevice();

  const context = canvas.getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format });

  // ImGui renders into the same WebGPU render pass as the gradient, on top of it.
  await ImGuiImplWeb.Init({ canvas, device });

  // Uniform buffer — 80 bytes, matches the Uniforms struct in shader.wgsl.
  // Two views into the same ArrayBuffer: f32 for most fields, u32 for `frame`/`mode`.
  //
  //  f32 index | offset | field
  //  ----------|--------|---------------------------
  //   0,1,2    |  0     | resolution (vec3)
  //   3        | 12     | time
  //   4        | 16     | time_delta
  //  u32[5]    | 20     | frame
  //  u32[6]    | 24     | mode
  //  u32[7]    | 28     | colormap
  //   8,9,10,11| 32     | mouse (vec4)
  //  12,13,14,15| 48    | date (vec4)
  //  16,17,18  | 64     | zoom_pan.xyz (center_re, center_im, scale)
  //  19        | 76     | zoom_pan.w  (tile_size, mode 2 only)
  const uniformBuffer = device.createBuffer({
    size: 80,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const uniformRaw = new ArrayBuffer(80);
  const f32 = new Float32Array(uniformRaw);
  const u32 = new Uint32Array(uniformRaw);

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" },
    }],
  });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  const module = device.createShaderModule({ code: shaderSource });

  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex:   { module, entryPoint: "vs_main" },
    fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });

  // --- Resize ---
  function resize() {
    const dpr = devicePixelRatio;
    const w = Math.floor(canvas.clientWidth  * dpr);
    const h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width  = w;
      canvas.height = h;
    }
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  // --- Cameras ---
  // The shader uses frag_coord with Y=0 at the TOP (top-left origin).
  // All pixel math here matches that convention: py = offsetY * dpr (NOT flipped).
  // Base span is the view width in complex units at scale=1.
  //
  // Julia camera (mode 0): span=4, initial scale sets im=[-1,1] (biunit square).
  // jScale = 2*h/w so that span*aspect = (4/jScale)*(h/w) = 2 → im: [-1,1].
  let jScale = 2.0 * canvas.height / canvas.width, jCre = 0.0, jCim = 0.0;
  // Mandelbrot camera (mode 1 left panel): span=3.5, initial center = (-0.75, 0)
  let mScale = 1.0, mCre = -0.75, mCim = 0.0;
  // Tiling camera (mode 2): tScale=1 → span=4, showing ~400 tiles at tileSize=0.01.
  // Center at (-0.5, 0) to frame the full Mandelbrot set.
  let tScale = 1.0, tCre = -0.5, tCim = 0.0;
  let tileSize = 0.01; // complex units per tile; smallest value → full Mandelbrot visible

  // Zoom a camera toward the cursor, keeping the point under px/py fixed.
  function zoomAt(
    scale: number, cre: number, cim: number, baseSpan: number,
    px: number, py: number, panelW: number, panelH: number,
    factor: number,
  ): [number, number, number] {
    const span   = baseSpan / scale;
    const aspect = panelH / panelW;
    const cursorRe = cre + (px / panelW - 0.5) * span;
    const cursorIm = cim + (py / panelH - 0.5) * span * aspect;
    const newScale = scale * factor;
    const ns       = baseSpan / newScale;
    return [
      newScale,
      cursorRe - (px / panelW - 0.5) * ns,
      cursorIm - (py / panelH - 0.5) * ns * aspect,
    ];
  }

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (ImGui.GetIO().WantCaptureMouse) return;
    const px     = e.offsetX * devicePixelRatio;
    const py     = e.offsetY * devicePixelRatio;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;

    if (mode === 0) {
      [jScale, jCre, jCim] = zoomAt(jScale, jCre, jCim, 4.0,
        px, py, canvas.width, canvas.height, factor);
    } else if (mode === 1) {
      // Only zoom when cursor is on the Mandelbrot (left) panel.
      if (px >= canvas.width * 0.5) return;
      const pw = canvas.width * 0.5;
      [mScale, mCre, mCim] = zoomAt(mScale, mCre, mCim, 3.5,
        px, py, pw, canvas.height, factor);
    } else {
      [tScale, tCre, tCim] = zoomAt(tScale, tCre, tCim, 4.0,
        px, py, canvas.width, canvas.height, factor);
    }
  }, { passive: false });

  // --- Mouse ---
  // mouse.xy / mouse.zw sent to the shader use bottom-left origin (established convention).
  // Drag pan is computed in top-left coords (matching frag_coord) stored in dragLast*.
  let mouseX = 0, mouseY = 0, clickX = 0, clickY = 0;
  let isDragging = false, dragLastX = 0, dragLastY = 0;

  canvas.addEventListener("mousemove", (e) => {
    if (ImGui.GetIO().WantCaptureMouse) return;
    const dpr = devicePixelRatio;
    const px  = e.offsetX * dpr;
    const py  = e.offsetY * dpr;
    mouseX = px;
    mouseY = canvas.height - py; // bottom-left for shader uniform

    if (isDragging) {
      const dx = px - dragLastX;
      const dy = py - dragLastY;
      if (mode === 0) {
        const span   = 4.0 / jScale;
        const aspect = canvas.height / canvas.width;
        jCre -= dx / canvas.width  * span;
        jCim -= dy / canvas.height * span * aspect;
      } else if (mode === 1 && dragLastX < canvas.width * 0.5) {
        // Only pan Mandelbrot when drag started on the left panel.
        const pw     = canvas.width * 0.5;
        const span   = 3.5 / mScale;
        const aspect = canvas.height / pw;
        mCre -= dx / pw            * span;
        mCim -= dy / canvas.height * span * aspect;
      } else if (mode === 2) {
        const span   = 4.0 / tScale;
        const aspect = canvas.height / canvas.width;
        tCre -= dx / canvas.width  * span;
        tCim -= dy / canvas.height * span * aspect;
      }
      dragLastX = px;
      dragLastY = py;
    }
  });

  canvas.addEventListener("mousedown", (e) => {
    if (ImGui.GetIO().WantCaptureMouse) return;
    const dpr = devicePixelRatio;
    const px  = e.offsetX * dpr;
    const py  = e.offsetY * dpr;
    clickX    = px;
    clickY    = canvas.height - py; // bottom-left for shader uniform
    isDragging = true;
    dragLastX  = px;
    dragLastY  = py;
  });
  canvas.addEventListener("mouseup",    () => { isDragging = false; });
  canvas.addEventListener("mouseleave", () => { isDragging = false; });

  // --- Mode & colormap ---
  // 0 = Julia Rotating, 1 = Julia/Mandelbrot side-by-side, 2 = Julia Tiling
  let mode = 0;
  // 0=Jet, 1=Hot, 2=Cool, 3=Viridis, 4=Grayscale, 5=Rainbow
  let colormap = 0;

  // --- Render loop ---
  let frameCount = 0;
  let lastTime = 0;

  function frame(t: number) {
    resize();
    const seconds = t / 1000;
    const delta = lastTime === 0 ? 0 : seconds - lastTime;
    lastTime = seconds;

    const now = new Date();
    const secondsOfDay = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()
                       + now.getMilliseconds() / 1000;

    // resolution — physical pixels (canvas.width/height already include DPR).
    // Use resolution.xy in the shader to normalise frag_coord into 0..1 UV space.
    // resolution.z is always 1.0 (square pixels; no non-square display support needed).
    f32[0] = canvas.width;
    f32[1] = canvas.height;
    f32[2] = 1.0;

    // time — seconds since the page loaded (from requestAnimationFrame timestamp).
    // time_delta — duration of the previous frame in seconds; 0 on the first frame.
    f32[3] = seconds;
    f32[4] = delta;

    // frame — monotonically increasing integer, 0 on the first frame.
    // Written via the u32 view because `frame` is declared as u32 in the struct.
    u32[5] = frameCount++;

    // mode — which visualization (0 = Julia Rotating, 1 = Julia/Mandelbrot).
    u32[6] = mode;
    // colormap index passed to the fragment shader.
    u32[7] = colormap;

    // zoom_pan — active camera for the current mode: (center_re, center_im, scale, unused).
    const [activeCre, activeCim, activeScale] =
      mode === 0 ? [jCre, jCim, jScale] :
      mode === 1 ? [mCre, mCim, mScale] :
                   [tCre, tCim, tScale];
    f32[16] = activeCre;
    f32[17] = activeCim;
    f32[18] = activeScale;
    f32[19] = tileSize;

    // mouse — physical pixels, bottom-left origin (same space as resolution/frag_coord).
    // xy: current cursor position (last mousemove).
    // zw: position of the most recent mousedown; (0,0) if never clicked.
    f32[8]  = mouseX;
    f32[9]  = mouseY;
    f32[10] = clickX;
    f32[11] = clickY;

    // date — wall-clock values from JS Date, not tied to frame timing.
    // x: full year (e.g. 2026)
    // y: month, 0-based (0 = January … 11 = December), matching JS Date.getMonth()
    // z: day of month, 1-based (1–31)
    // w: seconds elapsed since midnight (including fractional milliseconds)
    f32[12] = now.getFullYear();
    f32[13] = now.getMonth();
    f32[14] = now.getDate();
    f32[15] = secondsOfDay;

    device.queue.writeBuffer(uniformBuffer, 0, uniformRaw);

    // --- ImGui debug window ---
    // BeginRender/EndRender bracket all ImGui calls for the frame.
    // EndRender receives the active render pass and appends ImGui draw calls into it,
    // on top of whatever was already drawn (the gradient).
    //
    // BeginRender sets io.DisplaySize = canvas.clientWidth/Height (CSS pixels).
    // We must also set DisplayFramebufferScale = DPR so Dear ImGui scales its
    // CSS-pixel clip rects to physical pixels before handing them to WebGPU —
    // otherwise the scissor rect can exceed the render target at non-1x DPR.
    ImGui.GetIO().DisplayFramebufferScale = { x: devicePixelRatio, y: devicePixelRatio };
    ImGuiImplWeb.BeginRender();

    // Top-right corner with 10px margin. Cond.FirstUseEver means this only applies
    // on window creation — the user can move it freely within the session.
    ImGui.SetNextWindowPos(
      { x: canvas.clientWidth - 10, y: 10 },
      ImGui.Cond.FirstUseEver,
      { x: 1.0, y: 0.0 }, // pivot: anchor the top-right corner of the window to the pos
    );
    ImGui.Begin("Debug");
    ImGui.Text(`resolution  ${f32[0].toFixed(0)} x ${f32[1].toFixed(0)} px  (z=${f32[2]})`);
    ImGui.Text(`time        ${f32[3].toFixed(3)} s`);
    ImGui.Text(`time_delta  ${(f32[4] * 1000).toFixed(2)} ms  (~${(1 / f32[4]).toFixed(0)} fps)`);
    ImGui.Text(`frame       ${u32[5]}`);
    ImGui.Separator();
    ImGui.Text(`mouse       xy (${f32[8].toFixed(0)}, ${f32[9].toFixed(0)}) px`);
    ImGui.Text(`            click (${f32[10].toFixed(0)}, ${f32[11].toFixed(0)}) px`);
    ImGui.Separator();
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const hh = Math.floor(f32[15] / 3600).toString().padStart(2, "0");
    const mm = Math.floor((f32[15] % 3600) / 60).toString().padStart(2, "0");
    const ss = Math.floor(f32[15] % 60).toString().padStart(2, "0");
    ImGui.Text(`date        ${f32[12].toFixed(0)} ${months[f32[13]]} ${f32[14].toFixed(0)}`);
    ImGui.Text(`            ${hh}:${mm}:${ss} (${f32[15].toFixed(1)} s of day)`);
    ImGui.Separator();
    ImGui.Text("Mode");
    if (ImGui.RadioButton("Julia Rotating",    mode === 0)) mode = 0;
    ImGui.SameLine();
    if (ImGui.RadioButton("Julia/Mandelbrot",  mode === 1)) mode = 1;
    ImGui.SameLine();
    if (ImGui.RadioButton("Julia Tiling",      mode === 2)) mode = 2;
    ImGui.Separator();
    const [cre, cim, sc, baseSpan, panelW] =
      mode === 0 ? [jCre, jCim, jScale, 4.0, canvas.width      ] :
      mode === 1 ? [mCre, mCim, mScale, 3.5, canvas.width * 0.5] :
                   [tCre, tCim, tScale, 4.0, canvas.width      ];
    const _span   = baseSpan / sc;
    const _aspect = canvas.height / panelW;
    ImGui.Text(`zoom        ${sc.toFixed(3)}x`);
    ImGui.Text(`center      (${cre.toFixed(6)}, ${cim.toFixed(6)})`);
    ImGui.Text(`re          [${(cre - _span * 0.5).toFixed(4)}, ${(cre + _span * 0.5).toFixed(4)}]`);
    ImGui.Text(`im          [${(cim - _span * _aspect * 0.5).toFixed(4)}, ${(cim + _span * _aspect * 0.5).toFixed(4)}]`);
    if (mode === 2) {
      const ts: [number] = [tileSize];
      if (ImGui.SliderFloat("tile size", ts, 0.005, 0.50, "%.3f")) tileSize = ts[0];
    }
    ImGui.Separator();
    const cm: [number] = [colormap];
    if (ImGui.Combo("colormap", cm, "Jet\0Hot\0Cool\0Viridis\0Grayscale\0Rainbow\0\0")) colormap = cm[0];
    if (ImGui.Button("Reset View")) {
      if      (mode === 0) { jScale = 2.0 * canvas.height / canvas.width; jCre = 0.0; jCim = 0.0; }
      else if (mode === 1) { mScale =  1.0; mCre = -0.75;  mCim = 0.0; }
      else                 { tScale =  1.0; tCre = -0.5;   tCim = 0.0; tileSize = 0.01; }
    }
    ImGui.End();

    // --- Render pass ---
    // Gradient draws first (loadOp "clear"), ImGui layers on top via EndRender.
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp:  "clear",
        storeOp: "store",
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);

    ImGuiImplWeb.EndRender(pass);

    pass.end();
    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

init().catch(console.error);
