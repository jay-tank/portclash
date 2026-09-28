#!/usr/bin/env python3
"""Generate icon.png (128x128) for the PortClash VS Code extension.

Same rounded-gradient-square + 4x supersample / LANCZOS-downsample technique used across this
developer's extension icons. Design: charcoal-purple (#2B1B3D) to hot coral (#FF6F61) diagonal
gradient, a white socket in the middle with two white plugs pushing into it from the left and
right, and a small spark where they collide.
"""

import math

from PIL import Image, ImageDraw

SIZE = 128
SCALE = 4
BIG = SIZE * SCALE

TOP_COLOR = (0x2B, 0x1B, 0x3D)
BOTTOM_COLOR = (0xFF, 0x6F, 0x61)
WHITE = (255, 255, 255, 255)


def rounded_gradient_bg(size, c0, c1, radius_ratio=0.22):
    """Rounded square with a diagonal (top-left to bottom-right) gradient."""
    grad = Image.new("RGB", (size, size))
    px = grad.load()
    for y in range(size):
        for x in range(size):
            t = (x * 0.35 + y * 0.65) / (size - 1)
            t = max(0.0, min(1.0, t))
            px[x, y] = tuple(int(c0[i] + (c1[i] - c0[i]) * t) for i in range(3))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [(0, 0), (size - 1, size - 1)], radius=int(size * radius_ratio), fill=255
    )
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    img.paste(grad, (0, 0))
    img.putalpha(mask)
    return img


def draw_plug(draw, s, cx, cy, direction):
    """A plug body with two prongs pointing toward the center (direction -1 = left side)."""
    body_w = int(s * 0.17)
    body_h = int(s * 0.22)
    prong_len = int(s * 0.075)
    prong_w = int(s * 0.03)
    cable_w = int(s * 0.045)

    # body is on the outside, prongs point inward
    if direction < 0:
        bx1 = cx
        bx0 = cx - body_w
        px0 = bx1
        px1 = bx1 + prong_len
        cable = [(int(s * 0.04), cy), (bx0, cy)]
    else:
        bx0 = cx
        bx1 = cx + body_w
        px1 = bx0
        px0 = bx0 - prong_len
        cable = [(bx1, cy), (int(s * 0.96), cy)]

    draw.line(cable, fill=WHITE, width=cable_w)
    draw.rounded_rectangle(
        [(bx0, cy - body_h // 2), (bx1, cy + body_h // 2)], radius=int(s * 0.035), fill=WHITE
    )
    for dy in (-int(s * 0.05), int(s * 0.05)):
        draw.rounded_rectangle(
            [(px0, cy + dy - prong_w // 2), (px1, cy + dy + prong_w // 2)],
            radius=prong_w // 2,
            fill=WHITE,
        )


def draw_spark(draw, s, cx, cy, r_out, r_in, points=8, fill=WHITE):
    pts = []
    for i in range(points * 2):
        ang = math.pi * i / points - math.pi / 2
        r = r_out if i % 2 == 0 else r_in
        pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    draw.polygon(pts, fill=fill)


def draw_glyph(img):
    s = img.size[0]
    draw = ImageDraw.Draw(img)
    cy = int(s * 0.60)
    cx = s // 2

    # socket ring in the middle (the single port both plugs want)
    ring_r = int(s * 0.115)
    draw.ellipse(
        [(cx - ring_r, cy - ring_r), (cx + ring_r, cy + ring_r)],
        outline=WHITE,
        width=int(s * 0.03),
    )

    gap = int(s * 0.19)
    draw_plug(draw, s, cx - gap, cy, -1)
    draw_plug(draw, s, cx + gap, cy, +1)

    # spark above the collision point
    draw_spark(draw, s, cx, int(s * 0.28), int(s * 0.13), int(s * 0.045), points=6)
    # small accent sparks
    draw_spark(draw, s, int(s * 0.30), int(s * 0.25), int(s * 0.04), int(s * 0.014), points=4)
    draw_spark(draw, s, int(s * 0.70), int(s * 0.25), int(s * 0.04), int(s * 0.014), points=4)


def main():
    big = rounded_gradient_bg(BIG, TOP_COLOR, BOTTOM_COLOR)
    draw_glyph(big)
    final = big.resize((SIZE, SIZE), Image.LANCZOS)
    final.save("icon.png")
    print("Wrote icon.png (%dx%d)" % (SIZE, SIZE))


if __name__ == "__main__":
    main()
