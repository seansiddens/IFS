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

  // Uniform buffer — 64 bytes, matches the Uniforms struct in shader.wgsl.
  // Two views into the same ArrayBuffer: f32 for most fields, u32 for `frame`.
  //
  //  f32 index | offset | field
  //  ----------|--------|---------------------------
  //   0,1,2    |  0     | resolution (vec3)
  //   3        | 12     | time
  //   4        | 16     | time_delta
  //  u32[5]    | 20     | frame
  //   6,7      | 24     | _pad (vec2)
  //   8,9,10,11| 32     | mouse (vec4)
  //  12,13,14,15| 48    | date (vec4)
  const uniformBuffer = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const uniformRaw = new ArrayBuffer(64);
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

  // --- Mouse ---
  // All mouse coordinates are in physical pixels (post-DPR), matching the same
  // space as `resolution` and `frag_coord` in the shader.
  //
  // Origin is bottom-left (Y increases upward), matching GLSL/Shadertoy convention.
  // This differs from DOM offsetX/Y, which have Y increasing downward from the top
  // of the element — so Y is flipped: physicalY = canvas.height - offsetY * dpr.
  //
  // mouse.xy — cursor position, updated every mousemove (0,0 before first move)
  // mouse.zw — position of last mousedown (0,0 if the canvas was never clicked)
  let mouseX = 0, mouseY = 0, clickX = 0, clickY = 0;
  canvas.addEventListener("mousemove", (e) => {
    const dpr = devicePixelRatio;
    mouseX = e.offsetX * dpr;
    mouseY = canvas.height - e.offsetY * dpr;
  });
  canvas.addEventListener("mousedown", (e) => {
    const dpr = devicePixelRatio;
    clickX = e.offsetX * dpr;
    clickY = canvas.height - e.offsetY * dpr;
  });

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

    // _pad: f32[6], f32[7] — padding only, not used in the shader.

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
    ImGuiImplWeb.BeginRender();

    // Top-right corner with 10px margin. Cond.FirstUseEver means this only applies
    // on window creation — the user can move it freely within the session.
    ImGui.SetNextWindowPos(
      { x: canvas.clientWidth - 10, y: 10 },
      ImGui.Cond.FirstUseEver,
      { x: 1.0, y: 0.0 }, // pivot: anchor the top-right corner of the window to the pos
    );
    ImGui.Begin("Uniforms");
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
