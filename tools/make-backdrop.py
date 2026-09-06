"""
Generate the 8-bit backdrop for the demo render.

Deliberately original pixel art rather than a copy of anything: an interstellar
comet trailing a rainbow, which is a nod to a certain internet cat without
reproducing a character somebody else owns.

Drawn at 160x90 and scaled with nearest-neighbour, so it stays honestly blocky
at any output size. Deterministic -- the same seed always yields the same sky.

    python3 tools/make-backdrop.py docs/demo-backdrop.png

Standard library only: PNG is a container around a zlib stream, and the point
of the pipeline is that it reproduces without a package install.
"""
import sys, zlib, struct, random

W, H, SCALE = 224, 126, 6
SEED = 20260906


def png(pixels, w, h, path):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            raw.extend(pixels[y * w + x])
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(bytes(raw), 9)))
        f.write(chunk(b"IEND", b""))


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


rng = random.Random(SEED)
px = [(0, 0, 0)] * (W * H)


def put(x, y, c):
    if 0 <= x < W and 0 <= y < H:
        px[int(y) * W + int(x)] = c


def blend(x, y, c, t):
    if 0 <= x < W and 0 <= y < H:
        px[int(y) * W + int(x)] = lerp(px[int(y) * W + int(x)], c, t)


# Deep space: a vertical gradient, darkest at the top.
TOP, BOTTOM = (5, 4, 14), (18, 10, 38)
for y in range(H):
    row = lerp(TOP, BOTTOM, y / (H - 1))
    for x in range(W):
        put(x, y, row)

# Two nebulae, built from overlapping soft discs and then dithered so they read
# as pixel art rather than as a blurred gradient.
for cx, cy, radius, tint in ((44, 40, 40, (120, 40, 150)), (172, 88, 34, (30, 90, 140))):
    for y in range(H):
        for x in range(W):
            d = ((x - cx) ** 2 + ((y - cy) * 1.5) ** 2) ** 0.5
            if d < radius:
                falloff = (1 - d / radius) ** 2
                # Ordered dither: keeps the edges chunky instead of smooth.
                if ((x * 7 + y * 13) % 11) / 11 < falloff:
                    blend(x, y, tint, falloff * 0.55)

# Stars. Most are single pixels; a few are bright enough to earn a sparkle.
for _ in range(340):
    x, y = rng.randrange(W), rng.randrange(H)
    v = rng.random()
    if v > 0.97:
        put(x, y, (255, 255, 255))
        for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            blend(x + dx, y + dy, (200, 210, 255), 0.55)
    elif v > 0.75:
        put(x, y, (215, 220, 245))
    else:
        blend(x, y, (170, 180, 220), 0.5 + v * 0.4)

# The comet: a rainbow wake, then the body, so the sprite sits on top of it.
RAINBOW = [(255, 60, 60), (255, 150, 40), (255, 225, 60),
           (90, 220, 90), (70, 150, 255), (170, 90, 230)]
cx, cy = 170, 17
for i in range(80):
    x = cx - 8 - i
    # A gentle sine wave, quantised to whole pixels so the trail stays blocky.
    wave = round(1.8 * __import__("math").sin(i / 5.0))
    for band, colour in enumerate(RAINBOW):
        put(x, cy + wave + band - 3, colour)

# Comet body: a compact original sprite, not a likeness of anything.
BODY = [
    "  ....  ",
    " .OOOO. ",
    ".OWWWWO.",
    ".OWccWO.",
    ".OWWWWO.",
    " .OOOO. ",
    "  ....  ",
]
PALETTE = {"O": (255, 170, 60), "W": (255, 240, 210), "c": (90, 60, 40), ".": (200, 110, 40)}
for j, row in enumerate(BODY):
    for i, ch in enumerate(row):
        if ch != " ":
            put(cx + i - 4, cy + j - 3, PALETTE[ch])

# Scale up with nearest neighbour: no smoothing, the pixels stay pixels.
out = [(0, 0, 0)] * (W * SCALE * H * SCALE)
for y in range(H * SCALE):
    for x in range(W * SCALE):
        out[y * W * SCALE + x] = px[(y // SCALE) * W + (x // SCALE)]

path = sys.argv[1] if len(sys.argv) > 1 else "docs/demo-backdrop.png"
png(out, W * SCALE, H * SCALE, path)
print(f"wrote {path} ({W * SCALE}x{H * SCALE})")
