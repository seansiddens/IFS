# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WebGPU-based interactive fractal renderer for Iterated Function Systems (IFS). The web frontend renders GPU shaders with an ImGui debug overlay; the Python script generates fractal images via the chaos game algorithm on CPU.

**Requirements:** Node.js 18+, Chrome 113+ or Edge 113+ (WebGPU support), Python with NumPy and Pillow (for scripts/).

## Commands

```bash
# Development
npm install
npm run dev        # Vite dev server at http://localhost:5173

# Production
npm run build      # Outputs to dist/
npm run preview    # Preview production build

# Deploy to GitHub Pages (served at /ifs/)
./deploy.sh

# Python chaos game renderer
python scripts/ifs.py [--width 800] [--height 800] [--iterations 1000000] [--output out.png] [--log-scale] [--seed 42]
```

## Architecture

### Frontend (TypeScript + WebGPU)

**`src/main.ts`** — Application entry point:
- Initializes WebGPU (adapter → device → canvas context)
- Creates a single 64-byte uniform buffer shared between all shader invocations
- Captures mouse position/clicks and window resize events (DPR-aware)
- Drives the render loop via `requestAnimationFrame`, writing uniforms each frame
- Renders an ImGui debug overlay in the same render pass

**`src/shader.wgsl`** — Full-screen shader:
- Vertex shader generates a clip-space triangle covering the screen without a vertex buffer
- Fragment shader receives uniforms and produces the visual output
- `Uniforms` struct must stay in sync with the buffer layout in `main.ts` (64 bytes total)

**Uniform buffer layout** (both files must agree):
```
resolution: vec2f    // physical pixels (post-DPR scaling)
time: f32
time_delta: f32
frame: u32
_pad: u32
mouse: vec4f         // xy = current, zw = last click
date: vec4f          // year, month, day, seconds-of-day
```

### Python Script (`scripts/ifs.py`)

Implements the IFS chaos game with vectorized NumPy walkers. Runs `batch_size` independent points in parallel, randomly selects one of the three Sierpinski affine maps per step, accumulates a visitation histogram, then normalizes to a grayscale PNG.

### Build Config

- `vite.config.ts` sets `base: '/ifs/'` for GitHub Pages subpath hosting — change this if deploying elsewhere.
- `tsconfig.json` targets ES2022 with strict mode.

## Key Patterns

- **Adding shader features**: Extend the `Uniforms` struct in `shader.wgsl` first, then update the buffer size constant and `writeBuffer` call in `main.ts` to match (must stay 16-byte aligned).
- **ImGui overlay**: Uses `@mori2003/jsimgui`; the debug window currently mirrors the uniform values. New UI controls go in the `imgui.Begin/End` block in the render loop.
- **Python output**: The script writes raw pixel data via Pillow; swap `mode='L'` for `mode='RGB'` if adding color output.
