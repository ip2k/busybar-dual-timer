"""
Generate the animated 8-bit backdrop for the demo render.

An 8-bit galaxy with the Flipper dolphin flying through it on a rainbow, which
waves behind him as he goes. One PNG per output frame.

    python3 tools/make-backdrop.py --out docs/backdrop --frames 59

**Licence:** the dolphin sprite is Flipper's, under GPL-3.0 -- see
tools/vendor/README.md. The images this produces therefore inherit GPL-3.0,
unlike the rest of this MIT project. The sky itself is original work.

Drawn at 224x126 and scaled with nearest-neighbour, so it stays honestly blocky
at any output size. Deterministic: the same seed always yields the same sky, and
frame N always looks the same.

Standard library only. PNG is a container around a zlib stream, and the point of
this pipeline is that it reproduces without a package install.
"""
import sys, os, zlib, struct, random, math

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

# --------------------------------------------------------------- dolphin ---

def load_sprite(path):
    """
    Read the 1-bit dolphin PNG and work out which pixels are actually the
    sprite.

    The artwork is black outline on white with no alpha, and the space *outside*
    the dolphin is the same white as its belly, so colour alone cannot separate
    them. Flood-filling the white that touches the border marks the outside;
    whatever white is left is enclosed, and therefore part of the animal.
    """
    data = open(path, "rb").read()
    pos, w, h, idat = 8, 0, 0, b""
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if tag == b"IHDR":
            w, h, depth, ctype = struct.unpack(">IIBB", body[:10])
            assert depth == 1 and ctype == 0, f"expected 1-bit greyscale, got {depth}/{ctype}"
        elif tag == b"IDAT":
            idat += body
        elif tag == b"IEND":
            break
        pos += 12 + length

    raw = zlib.decompress(idat)
    stride = (w + 7) // 8
    bits = [[0] * w for _ in range(h)]
    prev = bytearray(stride)
    at = 0
    for y in range(h):
        filt = raw[at]; at += 1
        line = bytearray(raw[at:at + stride]); at += stride
        # Only filters 0 and 2 appear in these assets, but handle both properly.
        if filt == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif filt != 0:
            raise SystemExit(f"unsupported PNG filter {filt} in {path}")
        for x in range(w):
            bits[y][x] = (line[x >> 3] >> (7 - (x & 7))) & 1
        prev = line

    # 1 = white. Flood the white that reaches the border; that is the outside.
    outside = [[False] * w for _ in range(h)]
    stack = [(x, y) for x in range(w) for y in (0, h - 1) if bits[y][x] == 1]
    stack += [(x, y) for y in range(h) for x in (0, w - 1) if bits[y][x] == 1]
    while stack:
        x, y = stack.pop()
        if not (0 <= x < w and 0 <= y < h) or outside[y][x] or bits[y][x] != 1:
            continue
        outside[y][x] = True
        stack += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]

    # "ink" for the outline, "fill" for the body, None for transparent.
    sprite = [[None] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            if bits[y][x] == 0:
                sprite[y][x] = "ink"
            elif not outside[y][x]:
                sprite[y][x] = "fill"
    return sprite, w, h


HERE = os.path.dirname(os.path.abspath(__file__))
SPRITE, SW, SH = load_sprite(os.path.join(HERE, "vendor", "dolphin_71x25.png"))

RAINBOW = [(255, 60, 60), (255, 150, 40), (255, 225, 60),
           (90, 220, 90), (70, 150, 255), (170, 90, 230)]

BASE = list(px)   # the sky, without anything moving on it


def frame(n, total):
    """Draw frame `n`: the dolphin bobs, and the rainbow behind him waves."""
    global px
    px = list(BASE)

    phase = n * 0.55
    # High enough to clear the device, which occupies the middle band of the
    # frame -- at mid-height he flies straight behind it and is never seen.
    dx, dy = 152, 20
    bob = round(2.2 * math.sin(phase))

    # The wake, drawn first so the dolphin sits on top of it. Each column's
    # offset lags the one in front, which is what makes the ribbon appear to
    # travel backwards along the trail rather than wobble in place.
    for i in range(96):
        # Start at the tail, or the top band cuts across his back.
        x = dx - 30 - i
        wave = round(2.6 * math.sin(phase - i / 6.0))
        for band, colour in enumerate(RAINBOW):
            y = dy + bob + wave + band * 2 - 5
            put(x, y, colour)
            put(x, y + 1, colour)

    for j in range(SH):
        for i in range(SW):
            kind = SPRITE[j][i]
            if kind == "ink":
                put(dx + i - SW // 2, dy + bob + j - SH // 2, (20, 18, 30))
            elif kind == "fill":
                put(dx + i - SW // 2, dy + bob + j - SH // 2, (245, 248, 255))

    # Scale up with nearest neighbour: no smoothing, the pixels stay pixels.
    out = [(0, 0, 0)] * (W * SCALE * H * SCALE)
    for y in range(H * SCALE):
        row = (y // SCALE) * W
        for x in range(W * SCALE):
            out[y * W * SCALE + x] = px[row + (x // SCALE)]
    return out


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


OUT = arg("--out", "docs/backdrop")
TOTAL = int(arg("--frames", 59))
os.makedirs(OUT, exist_ok=True)
for n in range(TOTAL):
    png(frame(n, TOTAL), W * SCALE, H * SCALE, os.path.join(OUT, f"bg_{n:03d}.png"))
print(f"wrote {TOTAL} frames to {OUT} ({W * SCALE}x{H * SCALE})")
