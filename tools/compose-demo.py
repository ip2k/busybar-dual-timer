"""
Composite the rendered frames into the finished demo: header strip, the render,
and a caption bar explaining what the device is doing.

    python3 tools/compose-demo.py --render <dir> --frames <dir> --out <dir>

Needs Pillow (`pip install pillow`); everything else in the demo pipeline is
Blender and ffmpeg. This step only builds documentation, so the dependency
never reaches the shipped package.

Captions come from frames.json, written by tools/capture-frames.mjs. A caption
persists until the next one replaces it, so a beat can be labelled once and stay
labelled while it plays out.
"""
import json, os, sys

from PIL import Image, ImageDraw, ImageFont


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


RENDER = arg("--render")
FRAMES = arg("--frames")
OUT = arg("--out")

HEADER_H, CAPTION_H = 34, 68
GROUND = (13, 12, 16)
RULE = (38, 35, 42)
MUTED = (128, 120, 132)
INK = (238, 234, 240)
ACCENT = (228, 98, 15)

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]
FONT_REGULAR = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def font(paths, size):
    for p in paths:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


f_caption = font(FONT_CANDIDATES, 21)
f_chip = font(FONT_CANDIDATES, 13)
f_header = font(FONT_REGULAR, 13)

with open(os.path.join(FRAMES, "frames.json")) as fh:
    manifest = json.load(fh)

# Expand `hold` so captions line up with the rendered frame numbering, which
# render-demo.py expands the same way. A caption carries forward until replaced.
captions = []
current = (None, None)
for entry in manifest:
    if entry.get("caption"):
        current = (entry.get("chip"), entry["caption"])
    captions.extend([current] * int(entry.get("hold", 1)))

os.makedirs(OUT, exist_ok=True)
renders = sorted(f for f in os.listdir(RENDER) if f.startswith("r_") and f.endswith(".png"))

for i, name in enumerate(renders):
    art = Image.open(os.path.join(RENDER, name)).convert("RGB")
    w, h = art.size
    canvas = Image.new("RGB", (w, HEADER_H + h + CAPTION_H), GROUND)
    canvas.paste(art, (0, HEADER_H))
    d = ImageDraw.Draw(canvas)

    d.text((16, HEADER_H // 2), "busy-dual-timer", font=f_header, fill=MUTED, anchor="lm")
    right = "real capture from the device  ·  72 × 16"
    d.text((w - 16, HEADER_H // 2), right, font=f_header, fill=(92, 86, 96), anchor="rm")
    d.line([(0, HEADER_H - 1), (w, HEADER_H - 1)], fill=RULE)

    y = HEADER_H + h
    d.line([(0, y), (w, y)], fill=RULE)
    chip, caption = captions[i] if i < len(captions) else (None, None)
    x = 18
    cy = y + CAPTION_H // 2
    if chip:
        tw = d.textlength(chip, font=f_chip)
        d.rounded_rectangle([x, cy - 13, x + tw + 22, cy + 13], radius=4,
                            outline=ACCENT, width=1, fill=(38, 22, 10))
        d.text((x + 11, cy), chip, font=f_chip, fill=ACCENT, anchor="lm")
        x += tw + 38
    if caption:
        d.text((x, cy), caption, font=f_caption, fill=INK, anchor="lm")

    canvas.save(os.path.join(OUT, f"c_{i:03d}.png"))

print(f"composed {len(renders)} frames -> {OUT}")
