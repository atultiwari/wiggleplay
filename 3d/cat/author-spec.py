"""Author the WigglePlay cat ObjectSculptSpec from the measured reference (refs/cat-orange.png, 512 px, front view, sitting)."""
import json, math, sys
sys.path.insert(0, '/Users/atultiwari/Downloads/Projects/KidsProject/wiggleplay/3d/tools')
import numpy as np
from specgen import apply_common, attach, component, embed, hidden_material, material, recipe, root_component

# Frame: cat height (ear tips y 13 -> paw bottoms y 499) ~= 1.0; x = (px-213)/480 (head centre), y = (499-py)/480 (ground under the paws); +z faces the camera.
PX = 1 / 480
def X(px): return round((px - 213) * PX, 4)
def Y(py): return round((499 - py) * PX, 4)
CAM_D, TARGET = 1.465, (0.0, Y(256))   # match camera picture plane 0.25 in front of the origin; x target kept at the sagittal plane so mirrored pairs stay exact mirrors (the real camera target is 0.09 to the right: ~6 px drift on near parts)
def at_depth(px, py, z):
    """world x, y for a part at depth z so that it projects onto image point (px, py) under the match camera"""
    mag = CAM_D / (CAM_D - z)
    return [round(TARGET[0] + (X(px) - TARGET[0]) / mag, 4), round(TARGET[1] + (Y(py) - TARGET[1]) / mag, 4)]
def mag_at(z): return CAM_D / (CAM_D - z)

# Palette lifted ~6% versus the sampled stops (Neutral tone mapping, exposure 1.45).
ORANGE, DARK_OR, CREAM, PEACH, PINK, EAR_PINK, BROWN, TONGUE, PURE = '#ffa040', '#d8823f', '#fffbe6', '#f7cca6', '#ff8c7c', '#ff9a86', '#5a2814', '#ff7d8e', '#ffffff'
mats = [
  hidden_material(),
  material('cat-orange', 'Tabby orange fur', ORANGE, [CREAM, PEACH, DARK_OR], 0.85, variation=0.05, overrides=[
      {"id": "muzzle", "region": "lower face", "color": CREAM, "note": "cream muzzle and chin (vertexPaint ellipsoid)"},
      {"id": "chin-shade", "region": "under the chin", "color": PEACH, "note": "peach chin/neck band (vertexPaint axis-band)"},
      {"id": "belly", "region": "chest and belly", "color": CREAM, "note": "cream belly patch (vertexPaint ellipsoid)"},
      {"id": "stripes", "region": "forehead, head sides, shoulders, flanks, tail", "color": DARK_OR, "note": "darker tabby stripes built as stroke components"},
      {"id": "outline", "region": "silhouette", "color": BROWN, "note": "2D sticker outline; optional runtime inverted hull, not geometry"}]),
  material('stripe-orange', 'Tabby stripe', DARK_OR, [DARK_OR], 0.85),
  material('cream-fur', 'Cream fur', CREAM, [PEACH], 0.85),
  material('peach-fur', 'Peach fur (paws, tail tip shade)', PEACH, [CREAM], 0.85),
  material('cheek-pink', 'Cheek blush', PINK, [PINK], 0.6),
  material('ear-pink', 'Inner ear', EAR_PINK, [PINK], 0.7),
  material('eye-brown', 'Eyes, nose, mouth', BROWN, [BROWN], 0.3, extra={"clearcoat": {"base": 0.6}, "clearcoatRoughness": {"base": 0.15}}),
  material('tongue-pink', 'Tongue', TONGUE, [PINK], 0.4),
  material('catchlight', 'Catchlight white', PURE, [PURE], 0.35, extra={"emissive": PURE, "emissiveIntensity": {"base": 1.0}}),
]
R = lambda h, s='#000000', cls='fabric', **k: recipe(h, s, cls, **k)
comps = [root_component()]

# ---- head and body: dense lathes (circular cross-section, squashed in z) so the vertex-painted patches have even boundaries
# head and body outlines: half-widths measured row by row from the reference (symmetric about x = 213), revolved about the vertical axis
from PIL import Image
_ref = np.array(Image.open('../refs/cat-orange-clean-white.png').convert('RGB')).astype(int)
_obj = ~((_ref[:, :, 0] > 240) & (_ref[:, :, 1] > 240) & (_ref[:, :, 2] > 240))
def half_width(py, x_max=400):
    row = np.where(_obj[py, :x_max])[0]
    if not len(row): return 0.0
    return min(213 - row.min(), row.max() - 213) * PX
def measured_profile(y0, y1, step=6, ear_rows=None):
    rows = list(range(y0, y1, step)) + [y1]
    rs = np.array([half_width(py) for py in rows])
    if ear_rows:   # rows where the ears widen the outline: replace them with an elliptical dome cap that peaks 8 px above the first head row
        base_r = float(np.interp(ear_rows[1], rows, rs)); apex = ear_rows[0] - 8
        for i, py in enumerate(rows):
            if py < ear_rows[1]:
                rs[i] = base_r * math.sqrt(max(1 - ((ear_rows[1] - py) / (ear_rows[1] - apex)) ** 2, 0.0))
    rs = np.convolve(np.pad(rs, 1, mode='edge'), [0.25, 0.5, 0.25], mode='valid')
    peak = int(np.argmax(rs)); rs[:peak] = np.maximum.accumulate(rs[:peak]); rs[peak:] = np.minimum.accumulate(rs[peak:])
    return rows, rs
HEAD_ROWS = (46, 262); BODY_ROWS = (262, 490)
head_rows, head_r = measured_profile(*HEAD_ROWS, ear_rows=(46, 124))
body_rows, body_r = measured_profile(*BODY_ROWS)
head_r[0] = 0.0001; head_r[1] = max(head_r[1], 0.09); body_r[-1] = 0.0001
HEAD = {"centre": [X(213), Y((HEAD_ROWS[0] + HEAD_ROWS[1]) / 2), 0.03], "rx": round(float(head_r.max()), 4), "ry": round((HEAD_ROWS[1] - HEAD_ROWS[0]) / 2 * PX, 4), "rz": 0.27, "rows": head_rows, "r": head_r}
BODY = {"centre": [X(213), Y((BODY_ROWS[0] + BODY_ROWS[1]) / 2), 0.0], "rx": round(float(body_r.max()), 4), "ry": round((BODY_ROWS[1] - BODY_ROWS[0]) / 2 * PX, 4), "rz": 0.27, "rows": body_rows, "r": body_r}
def lathe_profile(shape):
    cy = shape["centre"][1]
    pts = [[round(max(float(r), 0.0001), 4), round(Y(py) - cy, 4)] for py, r in zip(shape["rows"], shape["r"])]
    return pts[::-1]   # LatheGeometry wants ascending y
def radius_at(shape, wy):
    ys = [Y(py) - shape["centre"][1] for py in shape["rows"]][::-1]; rs = list(shape["r"])[::-1]
    return float(np.interp(wy - shape["centre"][1], ys, rs))
def blob(cid, name, shape, mat, parent, rationale, sockets, paint, tier='blockout', importance=1.0, local_features=None):
    c = component(cid, name, 'macro', 'body', 'lathe', 'continuous-sculpt', rationale, parent,
      shape["centre"], [1.0, 1.0, round(shape["rz"] / shape["rx"], 4)], mat, importance=importance, confidence=0.85,
      descriptor={"latheProfile": {"points": lathe_profile(shape), "segments": 64}},
      collider={"type": "sphere", "offset": [0, 0, 0], "scale": [round(2 * shape["rx"], 4), round(2 * shape["ry"], 4), round(2 * shape["rz"], 4)], "isTrigger": False, "notes": "ellipsoid proxy"},
      sockets=sockets, fidelity_tier=tier, color_recipe=R(ORANGE, CREAM), local_features=local_features or [],
      extra={"vertexPaint": {"baseColor": ORANGE, "regions": paint}})
    c['dimensions'] = {"width": round(2 * shape["rx"], 4), "height": round(2 * shape["ry"], 4), "depth": round(2 * shape["rz"], 4), "units": "relative", "confidence": 0.85}
    return c
def head_local(px, py, z=None):
    """head-local coordinates of a world point placed at depth z (default: on the head's front surface)"""
    wx, wy = at_depth(px, py, HEAD["centre"][2] + HEAD["rz"] * 0.8) if z is None else at_depth(px, py, z)
    return [round(wx - HEAD["centre"][0], 4), round(wy - HEAD["centre"][1], 4)]
# vertex paint is evaluated in scaled component-local units: the lathe's local z is squashed by rz/rx, so regions use rx-based z
head_paint = [
  {"id": "muzzle", "kind": "ellipsoid", "center": [0.0, round(Y(234) - HEAD["centre"][1], 4), round(HEAD["rz"] * 0.55, 4)], "radii": [round(154 * PX, 4), round(64 * PX, 4), round(HEAD["rz"] * 0.9, 4)], "softness": 0.02, "color": CREAM},
  {"id": "chin-shade", "kind": "axis-band", "axis": "y", "min": -1.0, "max": round(Y(250) - HEAD["centre"][1], 4), "softness": 0.02, "color": PEACH},
]
body_paint = [
  {"id": "collar-shade", "kind": "axis-band", "axis": "y", "min": round(Y(302) - BODY["centre"][1], 4), "max": 1.0, "softness": 0.02, "color": PEACH},
  {"id": "belly", "kind": "ellipsoid", "center": [0.0, round(Y(362) - BODY["centre"][1], 4), round(BODY["rz"] * 0.6, 4)], "radii": [round(110 * PX, 4), round(66 * PX, 4), round(BODY["rz"] * 0.8, 4)], "softness": 0.02, "color": CREAM},
  {"id": "belly-low", "kind": "ellipsoid", "center": [0.0, round(Y(440) - BODY["centre"][1], 4), round(BODY["rz"] * 0.6, 4)], "radii": [round(34 * PX, 4), round(40 * PX, 4), round(BODY["rz"] * 0.8, 4)], "softness": 0.015, "color": PEACH},
]
body = blob('body', 'Body', BODY, 'cat-orange', 'root',
  'The sitting body is one plump blob: a dense lathe squashed front-to-back; the cream chest patch and peach lower belly are vertex-painted regions; stripes are separate strokes.',
  [{"id": "neck", "localPosition": [0, round(BODY["ry"] * 0.6, 4), 0.05]}, {"id": "shoulder-l", "localPosition": [round(-BODY["rx"] * 0.6, 4), round(-BODY["ry"] * 0.1, 4), round(BODY["rz"] * 0.6, 4)]},
   {"id": "shoulder-r", "localPosition": [round(BODY["rx"] * 0.6, 4), round(-BODY["ry"] * 0.1, 4), round(BODY["rz"] * 0.6, 4)]}, {"id": "tail-root", "localPosition": [round(BODY["rx"] * 0.9, 4), round(-BODY["ry"] * 0.6, 4), -0.05]},
   {"id": "hip-l", "localPosition": [round(-BODY["rx"] * 0.3, 4), round(-BODY["ry"] * 0.9, 4), round(BODY["rz"] * 0.5, 4)]}, {"id": "hip-r", "localPosition": [round(BODY["rx"] * 0.3, 4), round(-BODY["ry"] * 0.9, 4), round(BODY["rz"] * 0.5, 4)]},
   {"id": "skin", "localPosition": [0, 0, round(BODY["rz"], 4)]}], body_paint,
  local_features=[{"id": "belly", "kind": "decal", "note": "cream chest patch and peach lower belly (vertexPaint)"}])
comps.append(body)
head = blob('head', 'Head', HEAD, 'cat-orange', 'body',
  'The oversized head is a squashed dense lathe sitting on the body; the cream muzzle/chin and peach neck shade are vertex-painted regions; the face marks, ears and stripes are children so the whole head turns as one node.',
  [{"id": "crown", "localPosition": [0, round(HEAD["ry"], 4), 0]}, {"id": "face", "localPosition": [0, 0, round(HEAD["rz"], 4)]}], head_paint, importance=1.0,
  local_features=[{"id": "muzzle", "kind": "decal", "note": "cream muzzle and chin (vertexPaint)"}, {"id": "chin-shade", "kind": "decal", "note": "peach band under the chin (vertexPaint)"}])
head['transform']['position'] = [round(HEAD["centre"][0] - BODY["centre"][0], 4), round(HEAD["centre"][1] - BODY["centre"][1], 4), round(HEAD["centre"][2] - BODY["centre"][2], 4)]
head['attachment'] = embed('neck', 0.12)
head['actionProfile']['animationRole'] = 'head'
head['actionProfile']['pivot'] = {"mode": "center", "localPosition": [0, round(-HEAD["ry"] * 0.6, 4), 0], "axis": [0, 1, 0], "confidence": 0.8}
comps.append(head)

# ---- ears: cones from inside the head dome to the measured tips, pink inner ear on the front face
EAR_R = 60
def ear(side, base_px, tip_px):
    z = HEAD["centre"][2] + 0.03
    base = at_depth(*base_px, z) + [z]; tip = at_depth(*tip_px, z) + [z]
    lb = [round(base[0] - HEAD["centre"][0], 4), round(base[1] - HEAD["centre"][1], 4), round(z - HEAD["centre"][2], 4)]
    lt = [round(tip[0] - HEAD["centre"][0], 4), round(tip[1] - HEAD["centre"][1], 4), round(z - HEAD["centre"][2], 4)]
    length = math.dist(lb, lt)
    c = component(f'ear-{side}', f'Ear {side.upper()}', 'meso', 'ear', 'cone', 'assembled-solid', 'Triangular ear: a cone rooted inside the head dome pointing to the measured tip.', 'head',
      lb, [round(2 * EAR_R * PX, 4), round(length, 4), round(2 * EAR_R * PX, 4)], 'cat-orange', importance=0.8, confidence=0.85,
      attachment=attach('crown', lb, lt, round(EAR_R * PX, 4), 0.006, contact='socket-joint', embed=0.06), fidelity_tier='blockout',
      anim_role='ear', pivot_mode='hinge', pivot_axis=[0, 0, 1], collider={"type": "capsule", "offset": [0, 0, 0], "scale": [round(2 * EAR_R * PX, 4), round(length, 4), round(2 * EAR_R * PX, 4)], "isTrigger": False, "notes": "cone proxy"},
      color_recipe=R(ORANGE, EAR_PINK), sockets=[{"id": "inner", "localPosition": [0, round(length * 0.45, 4), round(EAR_R * PX * 0.55, 4)]}])
    return c
comps.append(ear('r', (118, 108), (82, 18)))
comps.append(ear('l', (308, 108), (344, 18)))
for side, sign in (('r', -1), ('l', 1)):
    comps.append(component(f'ear-inner-{side}', f'Inner ear {side.upper()}', 'micro', 'detail', 'ellipsoid', 'material-only', 'Pink inner-ear patch on the front face of the ear cone.', f'ear-{side}',
      [0, 0.09, 0.075], [0.075, 0.12, 0.012], 'ear-pink', importance=0.5, confidence=0.8, rotation=[0, 0, round(sign * 0.35, 4)],
      attachment=embed('inner', 0.004), fidelity_tier='form-refinement', color_recipe=R(EAR_PINK, PINK)))

# ---- face marks seated on the head's front surface (perspective-aware); children of the head node
def lathe_surface(shape, px, py, proud=0.0):
    """local position + normal on the revolved outline (z squashed by rz/rx) under an image point, perspective-corrected"""
    wx, wy = X(px), Y(py); z = shape["centre"][2] + shape["rz"] * 0.8; zs = shape["rz"] / shape["rx"]
    for _ in range(3):
        rr = radius_at(shape, wy); dx = wx - shape["centre"][0]
        q = max(rr * rr - dx * dx, 0.0)
        z = shape["centre"][2] + (math.sqrt(q) * zs + proud)
        wx, wy = at_depth(px, py, z)
    ny = (radius_at(shape, wy - 0.01) - radius_at(shape, wy + 0.01)) / 0.02   # outline slope -> vertical normal component
    n = np.array([dx / max(rr, 1e-3), ny * 0.5, math.sqrt(q) / max(rr, 1e-3) / zs]); n /= (np.linalg.norm(n) or 1.0)
    return [round(wx - shape["centre"][0], 4), round(wy - shape["centre"][1], 4), round(z - shape["centre"][2], 4)], n
def head_surface(px, py, proud=0.0): return lathe_surface(HEAD, px, py, proud)
def body_surface(px, py, proud=0.0): return lathe_surface(BODY, px, py, proud)[0]
def face_mark(cid, name, px, py, scale, mat, parent='head', tier='form-refinement', importance=0.6, proud=0.0, surface=head_surface, socket='face', role='detail'):
    pos, n = surface(px, py, proud)
    tilt_x = -math.atan2(n[1], n[2]); tilt_y = math.atan2(n[0], n[2])
    zc = (HEAD if parent == 'head' else BODY)["centre"][2] + pos[2]
    scale = [round(scale[0] / mag_at(zc), 4), round(scale[1] / mag_at(zc), 4), scale[2]]
    return component(cid, name, 'micro', role, 'ellipsoid', 'material-only', f'{name}: flat marking seated on the fur surface.', parent,
      pos, scale, mat, importance=importance, confidence=0.85, rotation=[round(tilt_x, 4), round(tilt_y, 4), 0], attachment=embed(socket, 0.006), fidelity_tier=tier)
E = lambda w, h, d=0.02: [round(w * PX, 4), round(h * PX, 4), d]
comps += [
  face_mark('eye-r', 'Eye R', 142, 160, E(72, 68, 0.05), 'eye-brown', importance=0.9, proud=0.008),
  face_mark('eye-l', 'Eye L', 284, 160, E(72, 68, 0.05), 'eye-brown', importance=0.9, proud=0.008),
  face_mark('catchlight-a', 'Catchlight (L big)', 152, 153, E(17, 16, 0.012), 'catchlight', proud=0.034),
  face_mark('catchlight-b', 'Catchlight (L small)', 131, 178, E(8, 8, 0.012), 'catchlight', proud=0.034),
  face_mark('catchlight-c', 'Catchlight (R big)', 273, 153, E(17, 16, 0.012), 'catchlight', proud=0.034),
  face_mark('catchlight-d', 'Catchlight (R small)', 294, 178, E(8, 8, 0.012), 'catchlight', proud=0.034),
  face_mark('nose', 'Nose', 213, 188, E(26, 18, 0.03), 'eye-brown', importance=0.7, proud=0.012),
  face_mark('mouth-open', 'Open mouth', 213, 222, E(28, 22, 0.02), 'eye-brown', importance=0.6, proud=0.004),
  face_mark('tongue', 'Tongue', 213, 228, E(20, 12, 0.02), 'tongue-pink', proud=0.012),
  face_mark('cheek-a', 'Cheek L', 110, 215, E(46, 28, 0.016), 'cheek-pink', proud=0.004),
  face_mark('cheek-b', 'Cheek R', 316, 215, E(46, 28, 0.016), 'cheek-pink', proud=0.004),
]
def stroke(cid, name, pts, radius, mat, parent, tier='form-refinement', importance=0.55, end_scale=0.0, socket='face', level='micro', note='thin painted stroke'):
    stations = []
    zc = (HEAD if parent == 'head' else BODY)["centre"][2] + float(np.mean([p[2] for p in pts]))
    radius = round(radius / mag_at(zc), 4)
    for i, pos in enumerate(pts):
        rr = round(radius * end_scale, 4) if i in (0, len(pts) - 1) else radius
        stations.append({"position": [round(float(a), 4) for a in pos], "rx": rr, "rz": rr, "twist": 0.0})
    return component(cid, name, level, 'detail', 'tapered-sweep', 'material-only', f'{name}: {note}, built as a tapered sweep so it stays crisp.', parent,
      [0, 0, 0], [1, 1, 1], mat, importance=importance, confidence=0.85, attachment=embed(socket, 0.004), fidelity_tier=tier,
      descriptor={"taperedSweep": {"stations": stations, "radialSegments": 8, "capEnds": True}})
HS = lambda pts, proud=0.008: [head_surface(px, py, proud)[0] for px, py in pts]
BS = lambda pts, proud=0.008: [body_surface(px, py, proud) for px, py in pts]
comps.append(stroke('smile', 'Smile', HS([(190, 203), (200, 212), (213, 205), (226, 212), (236, 203)]), 0.007, 'eye-brown', 'head', importance=0.7, note='w-shaped smile under the nose'))
comps.append(stroke('brow-r', 'Eyebrow R', HS([(126, 112), (139, 104), (152, 108)]), 0.006, 'eye-brown', 'head'))
comps.append(stroke('brow-l', 'Eyebrow L', HS([(274, 108), (287, 104), (300, 112)]), 0.006, 'eye-brown', 'head'))
# tabby stripes: forehead, head sides, shoulders and flanks, drawn as strokes hugging the fur
STRIPES = {
  'stripe-forehead-c': ('head', HS([(213, 52), (213, 80), (213, 112)]), 0.03), 'stripe-forehead-a': ('head', HS([(176, 54), (176, 74), (176, 94)]), 0.024), 'stripe-forehead-b': ('head', HS([(252, 54), (252, 74), (252, 94)]), 0.024),
  'stripe-head-a': ('head', HS([(52, 150), (62, 172), (72, 196)]), 0.028), 'stripe-head-b': ('head', HS([(374, 150), (364, 172), (354, 196)]), 0.028),
  'stripe-shoulder-a': ('body', BS([(48, 296), (68, 312), (96, 326)]), 0.028), 'stripe-shoulder-b': ('body', BS([(378, 296), (358, 312), (330, 326)]), 0.028),
  'stripe-flank-a': ('body', BS([(100, 396), (122, 406), (145, 416)]), 0.028), 'stripe-flank-b': ('body', BS([(332, 396), (310, 406), (287, 416)]), 0.028),
  'stripe-low-a': ('body', BS([(108, 434), (126, 446), (144, 460)]), 0.024), 'stripe-low-b': ('body', BS([(318, 434), (300, 446), (282, 460)]), 0.024),
}
for cid, (parent, pts, rad) in STRIPES.items():
    comps.append(stroke(cid, cid.replace('-', ' ').title(), pts, rad, 'stripe-orange', parent, tier='form-refinement', importance=0.5, end_scale=0.5, socket='face' if parent == 'head' else 'skin', note='darker tabby stripe on the fur'))

# ---- front legs: rounded ellipsoid columns in front of the body with peach paws; cream hind paws peek between them
for side, px in (('r', 95), ('l', 331)):
    z = BODY["rz"] * 0.8; m = mag_at(z)
    cx, cy = at_depth(px, 425, z)
    leg_scale = [round(2 * 44 * PX / m, 4), round(120 * PX / m, 4), round(2 * 44 * PX / m, 4)]
    lpos = [round(cx - BODY["centre"][0], 4), round(cy - BODY["centre"][1], 4), round(z, 4)]
    comps.append(component(f'foreleg-{side}', f'Front foreleg {side.upper()}', 'meso', 'detail', 'ellipsoid', 'assembled-solid', 'Front foreleg: a rounded column in front of the body blob from the shoulder down to the paw.', 'body',
      lpos, leg_scale, 'cat-orange', importance=0.8, confidence=0.8, attachment=embed(f'shoulder-{side}', 0.08), fidelity_tier='blockout',
      pivot_mode='hinge', pivot_axis=[1, 0, 0], collider={"type": "capsule", "offset": [0, 0, 0], "scale": leg_scale, "isTrigger": False, "notes": "foreleg proxy"},
      color_recipe=R(ORANGE, PEACH), sockets=[{"id": "paw", "localPosition": [0, round(-leg_scale[1] / 2, 4), 0.01]}]))
    comps.append(component(f'paw-{side}', f'Front paw {side.upper()}', 'micro', 'detail', 'ellipsoid', 'assembled-solid', 'Peach front paw at the foot of the foreleg.', f'foreleg-{side}',
      [0, round(-leg_scale[1] / 2 + 0.01, 4), 0.015], [round(52 * PX / m, 4), round(30 * PX / m, 4), 0.1], 'peach-fur', importance=0.6, confidence=0.8, attachment=embed('paw', 0.02), fidelity_tier='structural-pass', color_recipe=R(PEACH, CREAM)))
for cid, px in (('hind-paw-r', 155), ('hind-paw-l', 271)):
    z = BODY["rz"] * 0.5; wx, wy = at_depth(px, 476, z); m = mag_at(z)
    comps.append(component(cid, cid.replace('-', ' ').title(), 'micro', 'detail', 'ellipsoid', 'assembled-solid', 'Cream hind paw peeking out under the belly.', 'body',
      [round(wx - BODY["centre"][0], 4), round(wy - BODY["centre"][1], 4), round(z, 4)], [round(56 * PX / m, 4), round(32 * PX / m, 4), 0.12], 'cream-fur', importance=0.5, confidence=0.75,
      attachment=embed('hip-r' if cid.endswith('r') else 'hip-l', 0.03), fidelity_tier='structural-pass', color_recipe=R(CREAM, PEACH)))

# ---- tail: one tapered sweep whose node sits at its root (so it wags about the root), a cream tip and two dark rings
TAIL_PX = [(378, 452), (404, 447), (428, 436), (450, 420), (466, 400), (476, 378), (470, 358), (455, 349)]
tail_world = [at_depth(px, py, -0.05) + [-0.05] for px, py in TAIL_PX]
TAIL_R = round(30 * PX, 4)
tail_base = tail_world[0]
tail_node = [round(tail_base[k] - BODY["centre"][k], 4) for k in range(3)]
tail_rel = [[round(p[k] - tail_base[k], 4) for k in range(3)] for p in tail_world]
tail_radii = [TAIL_R * (1.0 - 0.58 * j / (len(tail_rel) - 1)) for j in range(len(tail_rel))]
tail_stations = [{"position": p, "rx": round(r, 4), "rz": round(r, 4), "twist": 0.0} for p, r in zip(tail_rel, tail_radii)]
comps.append(component('tail', 'Tail', 'meso', 'tail', 'tapered-sweep', 'assembled-solid', 'Curling tail: a tapered sweep along the measured curve (radius 27 px at the root tapering to 42 % at the tip) whose node sits at its root so it wags about the rump.', 'body',
  tail_node, [1, 1, 1], 'cat-orange', importance=0.85, confidence=0.8,
  attachment=attach('tail-root', tail_node, [round(tail_node[k] + tail_rel[-1][k], 4) for k in range(3)], TAIL_R, round(tail_radii[-1], 4), contact='socket-joint', embed=0.03),
  fidelity_tier='blockout', anim_role='tail', pivot_mode='hinge', pivot_axis=[0, 0, 1], descriptor={"taperedSweep": {"stations": tail_stations, "radialSegments": 12, "capEnds": True}},
  collider={"type": "capsule", "offset": [0, 0, 0], "scale": [2 * TAIL_R, round(math.dist(tail_rel[0], tail_rel[-1]), 4), 2 * TAIL_R], "isTrigger": False, "notes": "tail proxy"},
  color_recipe=R(ORANGE, DARK_OR), sockets=[{"id": "tip", "localPosition": tail_rel[-1]}, {"id": "ring-a", "localPosition": tail_rel[2]}, {"id": "ring-b", "localPosition": tail_rel[4]}],
  local_features=[{"id": "rings", "kind": "linework", "note": "two darker rings built as ring-a/ring-b"}]))
comps.append(component('cream-tip', 'Cream tip', 'micro', 'detail', 'ellipsoid', 'assembled-solid', 'Cream tip of the tail.', 'tail',
  tail_rel[-1], [round(2 * tail_radii[-1] + 0.01, 4), round(2 * tail_radii[-1] + 0.03, 4), round(2 * tail_radii[-1] + 0.01, 4)], 'cream-fur', importance=0.5, confidence=0.75,
  attachment=embed('tip', 0.02), fidelity_tier='structural-pass', color_recipe=R(CREAM, PEACH)))
for cid, j, sock in (('ring-a', 2, 'ring-a'), ('ring-b', 4, 'ring-b')):
    r = tail_radii[j] + 0.004
    comps.append(component(cid, f'Ring {cid[-1].upper()}', 'micro', 'detail', 'ellipsoid', 'material-only', 'Darker ring stripe around the tail.', 'tail',
      tail_rel[j], [round(2 * r, 4), round(2 * r, 4), round(2 * r, 4)], 'stripe-orange', importance=0.4, confidence=0.75,
      attachment=embed(sock, 0.02), fidelity_tier='form-refinement', color_recipe=R(DARK_OR, ORANGE)))

ids = [c['id'] for c in comps]
passes = [
  {"id": "blockout", "goal": "Body blob, oversized head, two ears, two front legs and the three-segment tail: the sitting-cat silhouette.", "componentRefs": ["root", "body", "head", "ear-l", "ear-r", "foreleg-l", "foreleg-r", "tail"], "acceptance": ["head width ~0.71", "tail curls up to the right", "ear tips at y 1.0"]},
  {"id": "structural-pass", "goal": "Paws attached under the legs and belly.", "componentRefs": ids, "acceptance": ["no floating parts"]},
  {"id": "form-refinement", "goal": "Eyes with catchlights, brows, nose, mouth, tongue, cheeks, inner ears, tabby stripes and tail rings seated on the fur.", "componentRefs": ids, "acceptance": ["face reads", "stripes on forehead, sides and tail"]},
  {"id": "material-pass", "goal": "Matte orange fur with cream muzzle/belly and peach shade, glossy brown eyes, pink cheeks.", "componentRefs": ids, "acceptance": ["cream patches reach the sticker's edges", "palette within sampled stops"]},
  {"id": "surface-pass", "goal": "Flat fur (no texture, sticker), glossy eyes.", "componentRefs": ids, "acceptance": ["no texture noise"]},
  {"id": "lighting-pass", "goal": "Neutral fill, frontal key, Neutral tone mapping, exposure 1.45.", "componentRefs": ["root"], "acceptance": ["orange not desaturated"]},
  {"id": "interaction-pass", "goal": "Head turns/nods as one node with its children; tail wags as a chain; ears and legs hinge.", "componentRefs": ids, "acceptance": ["head and tail pivot test"]},
  {"id": "optimization-pass", "goal": "Stay under 30k triangles.", "componentRefs": ids, "acceptance": ["targetTriangles respected"]},
]
targets = [
  {"id": "overall-silhouette", "name": "Plump sitting cat with an oversized head, pointy ears and a curling tail", "tier": "critical", "passIds": ["blockout", "structural-pass"], "minimumScore": 0.75, "mustPass": True, "componentRefs": ["body", "head", "ear-l", "tail"], "evidenceRefs": ["full-object"]},
  {"id": "primary-structure", "name": "Legs, paws and tail segments in their measured places", "tier": "critical", "passIds": ["structural-pass", "form-refinement"], "minimumScore": 0.72, "mustPass": True, "componentRefs": ["foreleg-l", "paw-l", "hind-paw-l", "tail"], "evidenceRefs": ["full-object"]},
  {"id": "face-and-details", "name": "Big brown eyes with catchlights, nose, open smile, cheeks, stripes", "tier": "critical", "passIds": ["form-refinement", "material-pass"], "minimumScore": 0.72, "mustPass": True, "componentRefs": ["eye-l", "eye-r", "nose", "smile", "stripe-forehead-c"], "evidenceRefs": ["full-object"]},
  {"id": "reference-material-system", "name": "Orange/cream/peach fur palette, glossy eyes, pink cheeks", "tier": "important", "passIds": ["material-pass", "surface-pass", "lighting-pass"], "minimumScore": 0.7, "mustPass": False, "componentRefs": ["body", "head", "eye-l"], "evidenceRefs": ["full-object"]},
]
spec = json.load(open('object-sculpt-spec.json'))
spec = apply_common(spec, components=comps, materials=mats, review_targets=targets, passes=passes,
  silhouette={"boundingShape": "two stacked squashed spheres (huge head on a plump body) with two triangular ears, two front legs and a tail curling up on the right", "aspectRatios": ["width/height 0.95 incl. tail", "head width/height 1.5"], "symmetry": "bilateral except the tail",
              "dominantCurves": ["head dome", "body sides", "tail curl"], "negativeSpaces": ["between the front legs", "inside the tail curl"], "landmarks": ["ear tips y 1.0", "eyes y 0.71", "chin y 0.5", "paws y 0.06", "tail tip x 0.55 y 0.3"]},
  observations=["single front view, sitting", "oversized head with cream muzzle, big brown eyes, open smile with tongue, pink cheeks", "orange tabby with darker stripes on forehead, head sides, shoulders, flanks and tail", "cream chest patch, peach lower belly and paws"],
  repetition=[{"id": "ears", "kind": "mirrored-pair", "count": 2, "distribution": "either side of the crown", "buildsGeometry": True, "instances": ["ear-l", "ear-r"]},
              {"id": "eyes", "kind": "mirrored-pair", "count": 2, "distribution": "either side of the muzzle", "buildsGeometry": True, "instances": ["eye-l", "eye-r"]},
              {"id": "legs", "kind": "mirrored-pair", "count": 2, "distribution": "front of the body", "buildsGeometry": True, "instances": ["foreleg-l", "foreleg-r"]},
              {"id": "stripes", "kind": "repeated-parts", "count": 11, "distribution": "forehead, head sides, shoulders, flanks, lower flanks", "buildsGeometry": True, "instances": list(STRIPES.keys())},
              {"id": "tail-rings", "kind": "repeated-parts", "count": 2, "distribution": "two darker rings along the tail", "buildsGeometry": True, "instances": ["ring-a", "ring-b"]}],
  assumptions=["Front view only: head depth 0.6 of its width, body depth 0.56 of its width.", "Hind legs are folded into the body blob; only the cream hind paws show.", "Tail sits slightly behind the body plane.", "Sticker white border and outer outline are 2D conventions and were stripped from the gate reference (refs/cat-orange-clean.png)."],
  risks=["Cream muzzle boundary is a vertex-paint edge on a 64x41 lathe; softness 0.02 may still show steps.", "Tail sweeps meet end to end; small seams possible at the joints."],
  coordinate_frame={"front": "+Z (the cat faces the camera; the reference is a front view)", "up": "+Y", "scaleReference": "ear tips to paw bottoms = 1.0; ground under the paws (y = 0)"},
  quality_depth={"macroComponents": 2, "mesoComponents": 5, "microFeatureGroups": 3, "materialLayers": 6, "repetitionSystems": 5, "reviewViewpoints": 4})
details = [
  ("forehead-stripes", "linework", "three darker stripes on the forehead", "stripe-forehead-c", [0.32, 0.1, 0.2, 0.13]),
  ("side-stripes", "linework", "darker stripes on the head sides, shoulders and flanks", "stripe-flank-a", [0.08, 0.28, 0.85, 0.65]),
  ("tail-rings", "linework", "two darker rings on the tail", "ring-a", [0.78, 0.75, 0.15, 0.13]),
  ("face-decal", "decal", "big brown eyes with catchlights, brows, nose, open smile with tongue, cheeks", "eye-l", [0.2, 0.2, 0.44, 0.28]),
  ("muzzle-patch", "decal", "cream muzzle and chin with a peach shade below", "muzzle", [0.12, 0.32, 0.6, 0.23]),
  ("belly-patch", "decal", "cream chest patch and peach lower belly", "belly", [0.22, 0.59, 0.42, 0.34]),
  ("inner-ears", "decal", "pink inner ears", "ear-inner-l", [0.15, 0.03, 0.55, 0.1]),
]
inv = {"scanMethod": "grid-3x3", "targetMinDetails": 6, "details": [
  {"id": did, "kind": kind, "description": desc, "region": {"x": r[0], "y": r[1], "width": r[2], "height": r[3], "units": "normalized"}, "scale": "meso",
   "affects": ["albedo"], "evidenceRef": "full-object", "confidence": 0.85, "mapsTo": {"ref": ref}} for did, kind, desc, ref, r in details]}
spec['preSpecAssessment']['detailInventory'] = inv
spec['preSpecAssessment']['objectClass'] = {**spec['preSpecAssessment'].get('objectClass', {}), "primaryType": "toy tabby cat (sitting)", "primaryDomain": "object", "confidence": 0.95,
  "formLanguage": ["organic-rounded", "stacked spheres", "pointy ears", "curled tail"], "structureKind": ["assembled", "body + head + ears + legs + tail chain"], "motionPotential": ["head turns and nods", "tail wags about its root", "ears flick", "front legs lift"], "materialFamilies": ["fabric-like matte fur (flat colour)", "glossy eyes", "emissive catchlights"]}
surface = {
  'body': {"macroRoughness": 0.85, "microRoughness": 0.05, "bumpAmplitude": 0.0, "normalPattern": "none (flat sticker fur)", "displacementPattern": "none", "occlusionPattern": "under the head and between the legs", "edgeWearPattern": "none", "notes": "smooth lathe, matte"},
  'head': {"macroRoughness": 0.85, "microRoughness": 0.05, "bumpAmplitude": 0.0, "normalPattern": "none", "displacementPattern": "none", "occlusionPattern": "under the chin", "edgeWearPattern": "none", "notes": "smooth lathe, matte"},
  'eye-l': {"macroRoughness": 0.3, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "none (glossy)", "displacementPattern": "none", "occlusionPattern": "eye rim", "edgeWearPattern": "none", "notes": "glossy disc with catchlights"},
}
for c in comps:
    if c['id'] in surface: c['surfaceDetail'] = surface[c['id']]
for L in spec['lightingFromPhoto']:
    if L['id'] == 'fill':
        L.update(skyColor='#ffffff', groundColor='#f3ece4', evidence='neutral warm-white ground so the orange fur is not dimmed from below (the sticker is flat-lit)')
    if L['id'] == 'exposure':
        L.update(toneMapping='Neutral', exposure=1.55, evidence='Neutral keeps the saturated orange; exposure 1.55 brings the fur to the sampled value')
    if L['id'] == 'key':
        L.update(direction=[-0.35, 0.6, 1.0], intensity=1.5, evidence='the sticker is lit flat from the front; a frontal upper-left key lights the face fully')
json.dump(spec, open('object-sculpt-spec.json', 'w'), indent=2)
a = json.load(open('assessment.json')); a['preSpecAssessment']['detailInventory'] = inv; a['preSpecAssessment']['unknownsToResolveBeforeImplementation'] = []; json.dump(a, open('assessment.json', 'w'), indent=2)
d = json.load(open('di.json')); d['detailInventory'] = inv; json.dump(d, open('di.json', 'w'), indent=2)
print('cat spec authored:', len(comps), 'components,', len(mats), 'materials')
