#!/usr/bin/env python3
"""Generate the QwenPaw WebChannel PWA icon set.

Everything is drawn with Pillow geometry (no external assets) and rendered at
4x then downsampled, so edges stay clean at every size. Run from anywhere:

    python3 spa/scripts/gen_icons.py

Outputs, located relative to this file (spa/public/):
    icons/icon-192.png            rounded square, glyph at 68%
    icons/icon-512.png            rounded square, glyph at 68%
    icons/icon-maskable-512.png   full-bleed square, glyph inside the 60% safe area
    apple-touch-icon.png          180x180, full-bleed opaque, no rounded corners
"""

from pathlib import Path

from PIL import Image, ImageDraw

BG = (201, 100, 66, 255)  # #c96442 (--accent)
FG = (255, 255, 255, 255)
SUPERSAMPLE = 4


def _box(x0, y0, x1, y1):
    return [int(round(x0)), int(round(y0)), int(round(x1)), int(round(y1))]


def _draw_glyph(draw, size, glyph_ratio):
    """White chat bubble with three terracotta dots, centred on the canvas."""
    g = size * glyph_ratio
    cx = cy = size / 2.0
    left, right = cx - g / 2.0, cx + g / 2.0
    top, bottom = cy - 0.42 * g, cy + 0.22 * g

    draw.rounded_rectangle(
        _box(left, top, right, bottom),
        radius=int(round(0.20 * g)),
        fill=FG,
    )

    # Tail hanging from the lower-left edge; its base overlaps the bubble body.
    tail = [
        (left + 0.20 * g, bottom - 0.03 * g),
        (left + 0.38 * g, bottom - 0.03 * g),
        (left + 0.14 * g, bottom + 0.24 * g),
    ]
    draw.polygon([(int(round(x)), int(round(y))) for x, y in tail], fill=FG)

    dot_r = 0.058 * g
    dot_y = (top + bottom) / 2.0
    for offset in (-0.20 * g, 0.0, 0.20 * g):
        draw.ellipse(
            _box(cx + offset - dot_r, dot_y - dot_r, cx + offset + dot_r, dot_y + dot_r),
            fill=BG,
        )


def render(size, glyph_ratio, rounded):
    canvas = size * SUPERSAMPLE
    image = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    if rounded:
        draw.rounded_rectangle(
            _box(0, 0, canvas - 1, canvas - 1),
            radius=int(round(canvas * 0.225)),
            fill=BG,
        )
    else:
        # Full-bleed background: maskable / apple icons must stay opaque.
        draw.rectangle(_box(0, 0, canvas - 1, canvas - 1), fill=BG)

    _draw_glyph(draw, canvas, glyph_ratio)
    return image.resize((size, size), Image.LANCZOS)


def main():
    public_dir = Path(__file__).resolve().parents[1] / 'public'
    icons_dir = public_dir / 'icons'
    icons_dir.mkdir(parents=True, exist_ok=True)

    outputs = [
        (render(192, 0.68, rounded=True), icons_dir / 'icon-192.png'),
        (render(512, 0.68, rounded=True), icons_dir / 'icon-512.png'),
        (render(512, 0.60, rounded=False), icons_dir / 'icon-maskable-512.png'),
        (render(180, 0.64, rounded=False), public_dir / 'apple-touch-icon.png'),
    ]
    for image, path in outputs:
        image.save(path, format='PNG', optimize=True)
        print(f'wrote {path}')


if __name__ == '__main__':
    main()
