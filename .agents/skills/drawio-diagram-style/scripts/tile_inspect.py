"""Crop a diagram render into overlapping tiles for per-region visual review.

Usage:
    python tile_inspect.py IMAGE [--cols 2] [--rows 3] [--overlap 0.08] [--outdir DIR]

Writes numbered tiles (r{row}c{col}.png) and prints each path, one per line.
Tiles overlap so content near cut lines is never lost; pixel size is capped so
every tile stays comfortably inside vision-model limits.
"""
import argparse
import os
import tempfile

from PIL import Image

MAX_TILE_PIXELS = 1500


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", help="rendered diagram image to slice")
    parser.add_argument("--cols", type=int, default=2, help="tile columns (default 2)")
    parser.add_argument("--rows", type=int, default=2, help="tile rows (default 2)")
    parser.add_argument(
        "--overlap", type=float, default=0.08,
        help="tile overlap as a fraction of tile size (default 0.08)",
    )
    parser.add_argument("--outdir", default=None, help="output directory (default: temp)")
    args = parser.parse_args()

    image = Image.open(args.image).convert("RGB")
    width, height = image.size
    outdir = args.outdir or os.path.join(tempfile.gettempdir(), "diagram-tiles")
    os.makedirs(outdir, exist_ok=True)

    tile_w, tile_h = width // args.cols, height // args.rows
    longest = max(tile_w, tile_h) * (1 + args.overlap)
    scale = min(1.0, MAX_TILE_PIXELS / longest)

    for row in range(args.rows):
        for col in range(args.cols):
            x0 = max(0, int(col * tile_w - tile_w * args.overlap))
            y0 = max(0, int(row * tile_h - tile_h * args.overlap))
            x1 = min(width, int((col + 1) * tile_w + tile_w * args.overlap))
            y1 = min(height, int((row + 1) * tile_h + tile_h * args.overlap))
            tile = image.crop((x0, y0, x1, y1))
            if scale < 1.0:
                tile = tile.resize((int(tile.width * scale), int(tile.height * scale)))
            path = os.path.join(outdir, f"r{row}c{col}.png")
            tile.save(path)
            print(path)


if __name__ == "__main__":
    main()
