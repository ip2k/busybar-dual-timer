"""
Render the demo animation by projecting real captured panel frames onto the
BUSY Bar's own 3D model.

    blender -b -noaudio -P tools/render-demo.py -- \
        --fbx <busy-bar.fbx> --frames <dir> --out <dir> [--test]

The frames come from tools/capture-frames.mjs, which photographs the physical
device's panel. Nothing here simulates the display: this maps genuine device
output onto the manufacturer's own model, so what the GIF shows is what the
hardware did.

`--test` renders a single frame, which is the fast way to check framing and
that the panel is not mirrored.
"""
import bpy, sys, os, math, json
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default


FBX = arg("--fbx")
FRAMES = arg("--frames")
OUT = arg("--out")
TEST = "--test" in argv
RES_X, RES_Y = int(arg("--width", 960)), int(arg("--height", 540))

# ------------------------------------------------------------------ scene ---

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
for block in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
    for b in list(block):
        block.remove(b)

bpy.ops.import_scene.fbx(filepath=FBX)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]

TEX_DIR = os.path.dirname(FBX)


def tex(node_tree, filename, colorspace="sRGB"):
    node = node_tree.nodes.new("ShaderNodeTexImage")
    node.image = bpy.data.images.load(os.path.join(TEX_DIR, filename))
    node.image.colorspace_settings.name = colorspace
    return node


# The body: one PBR material for every part, because the FBX ships a single
# 4K texture atlas and every mesh already carries UVs into it. The orange of
# the START pad, dial cap and mode lever all live in that basecolor map, so
# nothing has to be coloured by hand.
body_mat = bpy.data.materials.new("busy_body")
body_mat.use_nodes = True
nt = body_mat.node_tree
bsdf = nt.nodes["Principled BSDF"]
nt.links.new(tex(nt, "busy-bar_basecolor.png").outputs["Color"], bsdf.inputs["Base Color"])
nt.links.new(tex(nt, "busy-bar_roughness.png", "Non-Color").outputs["Color"], bsdf.inputs["Roughness"])
nt.links.new(tex(nt, "busy-bar_metallic.png", "Non-Color").outputs["Color"], bsdf.inputs["Metallic"])
normal_map = nt.nodes.new("ShaderNodeNormalMap")
nt.links.new(tex(nt, "busy-bar_normal.png", "Non-Color").outputs["Color"], normal_map.inputs["Color"])
nt.links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])

# The panel: pure emission, so it reads as lit pixels rather than a lit surface.
screen_mat = bpy.data.materials.new("busy_screen")
screen_mat.use_nodes = True
snt = screen_mat.node_tree
snt.nodes.clear()
emit = snt.nodes.new("ShaderNodeEmission")
emit.inputs["Strength"].default_value = 4.5
panel_tex = snt.nodes.new("ShaderNodeTexImage")
panel_tex.interpolation = "Closest"  # LED pixels are square; do not smooth them
panel_tex.extension = "CLIP"
out = snt.nodes.new("ShaderNodeOutputMaterial")
snt.links.new(panel_tex.outputs["Color"], emit.inputs["Color"])
snt.links.new(emit.outputs["Emission"], out.inputs["Surface"])

screen = bpy.data.objects["screen"]
for o in meshes:
    o.data.materials.clear()
    o.data.materials.append(screen_mat if o is screen else body_mat)

# The glass sits in front of the panel. Hiding it keeps the pixels crisp;
# a transmissive shader mostly buys haze at this scale.
for name in ("front_glass", "rear_glas_remesh"):
    if name in bpy.data.objects:
        bpy.data.objects[name].hide_render = True

# --------------------------------------------------------------------- UVs ---

# The panel is a single flat quad with a 4.5:1 aspect, which is exactly 72x16,
# so the capture maps onto it without distortion. Its imported UVs point into
# the body atlas, so they are replaced with a clean 0-1 projection.
#
# Orientation is derived from the geometry, then corrected against a test
# render: the device's long axis is world Y and its height is world Z, and from
# this camera +Y falls on the viewer's right, so U runs from -Y to +Y. Getting
# this backwards mirrors the digits, which is obvious the moment you look.
verts = [screen.matrix_world @ v.co for v in screen.data.vertices]
ys = [v.y for v in verts]
zs = [v.z for v in verts]
y0, y1 = min(ys), max(ys)
z0, z1 = min(zs), max(zs)

uv = screen.data.uv_layers.active.data
for loop in screen.data.loops:
    w = screen.matrix_world @ screen.data.vertices[loop.vertex_index].co
    u = (w.y - y0) / (y1 - y0)
    v = (w.z - z0) / (z1 - z0)
    uv[loop.index].uv = (u, v)

# ------------------------------------------------------------------- LED ---

# The status LED sits under the START pad and spills out around its lower
# edges, so it is built as two parts: the strips themselves are emissive, and a
# small point light underneath throws that colour onto the surrounding body.
# Lighting the strips alone reads as two bright slots rather than as a glow.
led_mat = bpy.data.materials.new("busy_led")
led_mat.use_nodes = True
lnt = led_mat.node_tree
lnt.nodes.clear()
led_emit = lnt.nodes.new("ShaderNodeEmission")
led_out = lnt.nodes.new("ShaderNodeOutputMaterial")
lnt.links.new(led_emit.outputs["Emission"], led_out.inputs["Surface"])

LED_MESHES = [bpy.data.objects[n] for n in ("led_light_1", "led_light_2") if n in bpy.data.objects]
for o in LED_MESHES:
    o.data.materials.clear()
    o.data.materials.append(led_mat)

glow_data = bpy.data.lights.new("led_glow", type="POINT")
glow_data.use_shadow = False
glow_data.shadow_soft_size = 0.012
glow = bpy.data.objects.new("led_glow", glow_data)
# Just beneath the pad's underside, centred on it.
glow.location = (0.004, 0.0, 0.0225)
bpy.context.collection.objects.link(glow)


def set_led(hex_color):
    """`hex_color` is #RRGGBB(AA) from the capture manifest, or None for off."""
    if not hex_color:
        led_emit.inputs["Color"].default_value = (0, 0, 0, 1)
        led_emit.inputs["Strength"].default_value = 0.0
        glow_data.energy = 0.0
        return
    h = hex_color.lstrip("#")
    # sRGB -> linear, so the rendered colour matches the hex the config asked for.
    rgb = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255.0
        rgb.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    led_emit.inputs["Color"].default_value = (*rgb, 1)
    led_emit.inputs["Strength"].default_value = 24.0
    glow_data.color = rgb
    glow_data.energy = 0.24


# ---------------------------------------------------------------- controls ---

START_PARTS = [bpy.data.objects[n] for n in ("button_start_body", "button_start_orange_part")
               if n in bpy.data.objects]
START_REST = [o.location.copy() for o in START_PARTS]
WHEEL_PARTS = [bpy.data.objects[n] for n in ("wheel_body", "wheel_cap", "wheel_orange_part")
               if n in bpy.data.objects]
WHEEL_REST = [o.rotation_euler.copy() for o in WHEEL_PARTS]
WHEEL_CENTRE = Vector((0.0, 0.057, 0.026))


def set_press(amount):
    """0 = at rest, 1 = fully depressed. The pad travels about a millimetre."""
    for o, rest in zip(START_PARTS, START_REST):
        o.location = rest + Vector((0, 0, -0.0012 * amount))


def set_wheel(degrees):
    """Turn the scroll wheel about its own vertical axis."""
    for o, rest in zip(WHEEL_PARTS, WHEEL_REST):
        o.rotation_mode = "XYZ"
        o.rotation_euler = (rest[0], rest[1], rest[2] + math.radians(degrees))


# The mode lever. This app only takes the panel when the lever is on CUSTOM --
# on any other position the device behaves completely normally -- so the demo
# should show the position it is actually describing.
LEVER_PARTS = [bpy.data.objects[n] for n in
               ("posselector_body", "posselector_cap", "posselector_orange_part")
               if n in bpy.data.objects]
LEVER_PIVOT = Vector((0.0, -0.0455, 0.0255))
# -30 degrees puts the lever's tip on the CUSTOM notch. Checked against a
# top-down render of the printed guide: the rest position is OFF (centre), -20
# lands between CUSTOM and OFF, and -40 overshoots toward BUSY.
LEVER_DEG = float(arg("--lever", -30))
if LEVER_DEG:
    import mathutils
    rot = mathutils.Matrix.Rotation(math.radians(LEVER_DEG), 4, "Z")
    for o in LEVER_PARTS:
        o.matrix_world = (
            mathutils.Matrix.Translation(LEVER_PIVOT)
            @ rot
            @ mathutils.Matrix.Translation(-LEVER_PIVOT)
            @ o.matrix_world
        )

# ------------------------------------------------------------ camera/light ---

cam_data = bpy.data.cameras.new("cam")
cam_data.lens = 55
cam = bpy.data.objects.new("cam", cam_data)
bpy.context.collection.objects.link(cam)
bpy.context.scene.camera = cam

# Framed to match docs/controls.jpg, which is a photograph of a real device:
# looking down from about 32 degrees so the whole top face reads -- mode lever,
# START pad, back button, scroll wheel -- while the front panel stays square
# enough to be legible. A near-level camera compresses the top to a sliver and
# loses exactly the controls the demo is trying to explain.
ELEV = math.radians(32)
YAW = math.radians(15)   # slight three-quarter turn, wheel end nearer
DIST = 0.365

target = Vector((0.0, 0.0, 0.004))
cam.location = target + Vector((
    DIST * math.cos(ELEV) * math.cos(YAW),
    -DIST * math.cos(ELEV) * math.sin(YAW),
    DIST * math.sin(ELEV),
))
direction = target - cam.location
cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()

world = bpy.data.worlds.new("w")
bpy.context.scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.012, 0.012, 0.014, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 1.0


def area(name, loc, rot, size, energy):
    d = bpy.data.lights.new(name, type="AREA")
    d.size = size
    d.energy = energy
    # Shadows off: the key was casting a hard edge across the scroll wheel,
    # which on a white product reads as a smudge rather than as form. The
    # shapes are legible from shading alone.
    d.use_shadow = False
    o = bpy.data.objects.new(name, d)
    o.location = loc
    o.rotation_euler = rot
    bpy.context.collection.objects.link(o)
    return o


# Key from front-right, fill from the left, and a rim behind to separate the
# black body from the black background.
# Two stops down from the first cut, which blew out the white body against the
# black ground. Energies are quartered rather than moving the view transform,
# so the emissive panel keeps its brightness.
area("key", (0.34, -0.20, 0.24), (math.radians(52), 0, math.radians(50)), 0.45, 3.75)
area("fill", (0.22, 0.26, 0.05), (math.radians(84), 0, math.radians(-140)), 0.55, 1.25)
area("rim", (-0.16, 0.10, 0.18), (math.radians(122), 0, math.radians(-160)), 0.40, 2.75)

# -------------------------------------------------------------- backdrop ---

# An 8-bit sky behind the device, generated by tools/make-backdrop.py. Emissive
# rather than lit, so it renders at its own colours and the product lighting
# does not have to serve two jobs.
BACKDROP = arg("--backdrop", os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                          "..", "docs", "demo-backdrop.png"))
if os.path.exists(BACKDROP):
    bpy.ops.mesh.primitive_plane_add(size=1.0)
    plane = bpy.context.active_object
    plane.name = "backdrop"

    view = (target - cam.location).normalized()
    BACK_DIST = 0.55
    plane.location = target + view * BACK_DIST
    plane.rotation_euler = (-view).to_track_quat("Z", "Y").to_euler()
    # Sized to just fill the frame at its own distance, rather than guessed:
    # half-width = distance * tan(hfov/2), with the sensor 36mm wide. Guessing
    # left most of the sky outside the frame and magnified what remained.
    d = DIST + BACK_DIST
    half_w = d * (36.0 / 2.0) / cam_data.lens
    half_h = half_w * RES_Y / RES_X
    plane.scale = (half_w * 2.06, half_h * 2.06, 1.0)

    bmat = bpy.data.materials.new("backdrop")
    bmat.use_nodes = True
    bnt = bmat.node_tree
    bnt.nodes.clear()
    bemit = bnt.nodes.new("ShaderNodeEmission")
    bemit.inputs["Strength"].default_value = 1.6
    btex = bnt.nodes.new("ShaderNodeTexImage")
    btex.image = bpy.data.images.load(os.path.abspath(BACKDROP))
    btex.interpolation = "Closest"   # keep the pixel art blocky
    bout = bnt.nodes.new("ShaderNodeOutputMaterial")
    bnt.links.new(btex.outputs["Color"], bemit.inputs["Color"])
    bnt.links.new(bemit.outputs["Emission"], bout.inputs["Surface"])
    plane.data.materials.append(bmat)

# ----------------------------------------------------------------- render ---

scene = bpy.context.scene
# Blender 5.x collapsed "EEVEE Next" back to the BLENDER_EEVEE identifier.
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = RES_X
scene.render.resolution_y = RES_Y
scene.render.film_transparent = False
scene.view_settings.view_transform = "AgX"
scene.view_settings.look = "AgX - Punchy"
try:
    scene.eevee.use_raytracing = True
except Exception:
    pass

os.makedirs(OUT, exist_ok=True)

# frames.json carries the state a panel capture cannot: LED colour, how far the
# START pad is down, how far the wheel has turned, and how many output frames
# the beat should occupy.
manifest_path = os.path.join(FRAMES, "frames.json")
if os.path.exists(manifest_path):
    with open(manifest_path) as fh:
        manifest = json.load(fh)
else:
    manifest = [{"file": f, "led": None, "press": 0, "wheel": 0, "hold": 1}
                for f in sorted(f for f in os.listdir(FRAMES) if f.endswith(".png"))]

if TEST:
    manifest = manifest[int(arg("--test-frame", 0)):int(arg("--test-frame", 0)) + 1]

panel_image = None
out_index = 0
for i, entry in enumerate(manifest):
    path = os.path.join(FRAMES, entry["file"])
    if panel_image is None:
        panel_image = bpy.data.images.load(path)
        panel_image.colorspace_settings.name = "sRGB"
        panel_tex.image = panel_image
    else:
        panel_image.filepath = path
        panel_image.reload()

    set_led(entry.get("led"))
    set_press(entry.get("press", 0))
    set_wheel(entry.get("wheel", 0))

    # Render once, then copy for the hold rather than re-rendering identical
    # frames -- the scene has not changed, so the pixels would be identical.
    first = os.path.join(OUT, f"r_{out_index:03d}.png")
    scene.render.filepath = first
    bpy.ops.render.render(write_still=True)
    out_index += 1
    for _ in range(max(0, int(entry.get("hold", 1)) - 1)):
        import shutil
        shutil.copyfile(first, os.path.join(OUT, f"r_{out_index:03d}.png"))
        out_index += 1
    print(f"rendered {i + 1}/{len(manifest)} -> {out_index} frames", flush=True)

print("DONE")
