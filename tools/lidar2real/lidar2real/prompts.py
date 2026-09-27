"""Prompt templates. Tune these first when output quality is off; everything else is plumbing.

The web app's copy of these prompts lives in server/photoreal.ts.
"""
from __future__ import annotations

DEFAULT_LOOK = "natural daylight, lightly overcast sky, realistic exposure and white balance"
DEFAULT_MOTION = "a slow, smooth, stabilized forward camera move at walking pace along the main direction of the scene"

_READ_LIDAR = """\
How to read the input:
- It is a LiDAR point-cloud visualization. Its colors are false-color encodings of height, intensity or depth; they are NOT the real colors of anything.
- Black or empty areas are places with no LiDAR returns: usually open sky, or unscanned surroundings. Fill them with what would realistically be there, and never render them as black walls, blocks or voids.
- Bright yellow or green highlights only mean high reflectivity (license plates, road signs, painted metal, glass). Never make an object yellow or green because it is highlighted.
- Dots, gaps, scan lines, concentric rings and stripes are sensor artifacts. Do not reproduce them.
- Work out what each shape is in the real world (thin vertical lines are usually poles, lamp posts or trees; box shapes are usually vehicles, containers or barriers; large vertical planes are building facades or walls) and render it as that real object."""

_READ_BLENDER = """\
How to read the input:
- It is a 3D render (for example from Blender) that may be untextured, flat-shaded or use placeholder materials.
- Treat it as a blockout: its geometry, layout and camera are ground truth, but its materials, lighting and CG look are not.
- Work out what each shape is in the real world and render it as that real object with real materials."""

_RENDER = """\
Turn this image into a single photorealistic photograph of the same real place, exactly as a real camera standing at this exact position would capture it.

{read}

Hard constraints:
- Keep the exact camera position, viewing angle, field of view, horizon and perspective.
- Keep every structure and object in the same place, with the same size, shape and count. Do not add, remove or move buildings, openings, poles or objects.
- Match the viewpoint type exactly. Street-level views become a handheld photo at eye level. Elevated oblique views become a drone photo from the same height and angle.
- A plan view seen from directly above (building footprints, the scanned ground as a band) must become a straight-down aerial photo, never a street-level or oblique shot. The sensor was on the street, so buildings may appear only as wall outlines: render them as solid buildings with roofs.

Photographic look:
- An unedited photograph from a full-frame camera: realistic materials (concrete, brick, glass, asphalt, metal, and vegetation where plausible), physically plausible light and shadows, true-to-life color, fine texture detail, natural depth of field.
- No text, labels, watermarks, borders, UI, outlines, bounding boxes, point-cloud look, glow or neon colors.

{scene}Lighting and conditions: {look}."""

# Consistency across views is done with a text description of the anchor photo, not the photo itself:
# given a reference photo, Nano Banana 2 copies its composition even when told not to.
_CONSISTENCY = """

This is one of several photos of the same place taken minutes apart. Match this look exactly; it describes appearance only, so the composition must still come from the input image: {look}"""

DESCRIBE_LOOK = """\
Describe the look of this place so another photographer could match it: architecture style, facade materials and colors, windows, doors, ground and sidewalk surfaces, street furniture, vehicles (types and colors), vegetation, weather, time of day, light direction and color grading. One dense paragraph, max 120 words. Do not describe the camera position, framing or layout."""

_CLIP = """\
[# Sources <FIRST_FRAME>@Image1]
Photorealistic real-world footage of this place, shot on a stabilized cinema camera: {motion}.
The scene stays physically consistent with the photo: buildings, poles and objects are rigid and keep their positions; only natural things move, such as light, clouds and leaves.
{scene}Audio: natural ambient sound of the location only, no music, no voiceover.
No text, captions or watermarks.
Use this image as the starting frame."""

_TRANSITION = """\
[# Sources <FIRST_FRAME>@Image1 <LAST_FRAME>@Image2]
One continuous, unbroken camera move through the same real place, travelling smoothly from the viewpoint of the first image to the viewpoint of the second image, like a gimbal or drone shot.
No cuts, dissolves or morphing: the geometry stays rigid and consistent while the camera moves through it. Photorealistic real-world footage.
{scene}Audio: natural ambient sound of the location only, no music, no voiceover.
No text, captions or watermarks."""


def _scene_line(scene: str) -> str:
    return f"Scene: {scene.strip().rstrip('.')}.\n" if scene.strip() else ""


def render_prompt(source: str, scene: str, look: str, anchor_look: str | None = None) -> str:
    """`anchor_look` is the description of the anchor photo that every other view should match."""
    read = _READ_BLENDER if source == "blender" else _READ_LIDAR
    prompt = _RENDER.format(read=read, scene=_scene_line(scene), look=look.strip().rstrip("."))
    return prompt + (_CONSISTENCY.format(look=anchor_look.strip()) if anchor_look else "")


def clip_prompt(motion: str, scene: str) -> str:
    return _CLIP.format(motion=motion.strip().rstrip("."), scene=_scene_line(scene))


def transition_prompt(scene: str) -> str:
    return _TRANSITION.format(scene=_scene_line(scene))
