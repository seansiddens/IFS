"""
Fractal IFS chaos game — Sierpinski triangle variant.

Three affine maps:
  f1(p) = p / 2
  f2(p) = (p + (0, 1)) / 2
  f3(p) = (p + (1, 0)) / 2

Runs multiple independent walkers in parallel for vectorized throughput.
"""
from __future__ import annotations
import argparse
import numpy as np
from PIL import Image

# Translation offsets for f1, f2, f3 — shape (3, 2)
OFFSETS = np.array([[0, 0], [0, 1], [1, 0]], dtype=np.float64)


def run_chaos_game(
    m: int,
    cutoff: int,
    resolution: tuple[int, int],
    batch_size: int = 1000,
    rng: np.random.Generator | None = None,
) -> np.ndarray:
    """Run the chaos game and return a (height, width) histogram of visit counts."""
    if rng is None:
        rng = np.random.default_rng()

    width, height = resolution
    hist = np.zeros(height * width, dtype=np.int64)

    # Initialise walkers at random points in [-1, 1]^2
    p = rng.uniform(-1.0, 1.0, size=(batch_size, 2))

    for i in range(m):
        choices = rng.integers(0, 3, size=batch_size)
        p = (p + OFFSETS[choices]) * 0.5

        if i >= cutoff:
            col = np.floor(p[:, 0] * width).astype(np.int32).clip(0, width - 1)
            row = np.floor((1.0 - p[:, 1]) * height).astype(np.int32).clip(0, height - 1)
            hist += np.bincount(row * width + col, minlength=height * width)

    return hist.reshape(height, width)


def render(hist: np.ndarray, log_scale: bool = True) -> Image.Image:
    """Normalise histogram to [0, 255] and return a grayscale PIL Image."""
    data = np.log1p(hist.astype(np.float64)) if log_scale else hist.astype(np.float64)
    max_val = data.max()
    if max_val > 0:
        data /= max_val
    return Image.fromarray((data * 255).astype(np.uint8), mode="L")


def main() -> None:
    parser = argparse.ArgumentParser(description="IFS chaos game renderer")
    parser.add_argument("--width",        type=int,   default=800)
    parser.add_argument("--height",       type=int,   default=800)
    parser.add_argument("--iterations",   type=int,   default=1_000_000,
                        help="Iterations per walker")
    parser.add_argument("--cutoff",       type=int,   default=20,
                        help="Initial iterations to discard (burn-in)")
    parser.add_argument("--batch-size",   type=int,   default=1000,
                        help="Number of parallel walkers")
    parser.add_argument("--log-scale",    dest="log_scale", action="store_true",  default=True)
    parser.add_argument("--no-log-scale", dest="log_scale", action="store_false")
    parser.add_argument("--seed",         type=int,   default=None)
    parser.add_argument("--output",       type=str,   default="output.png")
    args = parser.parse_args()

    rng = np.random.default_rng(args.seed)
    hist = run_chaos_game(
        m=args.iterations,
        cutoff=args.cutoff,
        resolution=(args.width, args.height),
        batch_size=args.batch_size,
        rng=rng,
    )
    img = render(hist, log_scale=args.log_scale)
    img.save(args.output)
    print(f"Saved {args.output}  ({args.width}x{args.height}, "
          f"{args.iterations * args.batch_size:,} total point evaluations)")


if __name__ == "__main__":
    main()
