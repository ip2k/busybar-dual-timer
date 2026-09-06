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
import bpy, sys, os, math
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
    o = bpy.data.objects.new(name, d)
    o.location = loc
    o.rotation_euler = rot
    bpy.context.collection.objects.link(o)
    return o


# Key from front-right, fill from the left, and a rim behind to separate the
# black body from the black background.
area("key", (0.34, -0.20, 0.24), (math.radians(52), 0, math.radians(50)), 0.45, 15)
area("fill", (0.22, 0.26, 0.05), (math.radians(84), 0, math.radians(-140)), 0.55, 5)
area("rim", (-0.16, 0.10, 0.18), (math.radians(122), 0, math.radians(-160)), 0.40, 11)

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
frames = sorted(f for f in os.listdir(FRAMES) if f.endswith(".png"))
if TEST:
    frames = frames[:1]

panel_image = None
for i, name in enumerate(frames):
    path = os.path.join(FRAMES, name)
    if panel_image is None:
        panel_image = bpy.data.images.load(path)
        panel_image.colorspace_settings.name = "sRGB"
        panel_tex.image = panel_image
    else:
        panel_image.filepath = path
        panel_image.reload()
    scene.render.filepath = os.path.join(OUT, f"r_{i:03d}.png")
    bpy.ops.render.render(write_still=True)
    print(f"rendered {i + 1}/{len(frames)}", flush=True)

print("DONE")
