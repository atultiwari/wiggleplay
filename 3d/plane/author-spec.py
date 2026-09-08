"""Author the WigglePlay plane ObjectSculptSpec from the measured reference (refs/plane.png, 512 px, nose to the left)."""
import json, math, sys
sys.path.insert(0, '/Users/atultiwari/Downloads/Projects/KidsProject/wiggleplay/3d/tools')
import numpy as np
from scipy.spatial.transform import Rotation
from specgen import apply_common, attach, component, embed, hidden_material, material, recipe, root_component

# Frame: fuselage axis nose tip (13,312) -> tail cone (455,245) = 447 px = 1.0; x = (px-234)/447, y = (418-py)/447 (ground under the engine pod).
PX = 1 / 447
def X(px): return round((px - 234) * PX, 4)
def Y(py): return round((418 - py) * PX, 4)
NOSE, TAIL = (13, 290), (455, 245)   # lathe axis: through the mid-body centre (200,271) and the tail cone
AXIS_ANGLE = math.atan2(NOSE[1] - TAIL[1], TAIL[0] - NOSE[0])   # +8.6 deg, tail higher than the nose (image y is down)
FUSE_ROT_Z = -math.pi / 2 + AXIS_ANGLE                           # lathe axis local +y -> world (+x, slightly up)

# Palette lifted ~6% versus the sampled stops (Neutral tone mapping at exposure 1.4 measured on the bus).
WHITE, BELLY, PORT, RED, FINBLUE, DARK, CHEEK, PURE, GLOSS = '#fbfdff', '#2f9ada', '#4ab8ee', '#ff4a48', '#2a6fd0', '#1a1a1a', '#f6a6c0', '#ffffff', '#bfeeff'
mats = [
  hidden_material(),
  material('plane-white', 'Airframe white', WHITE, [BELLY, RED], 0.4, variation=0.05, overrides=[
      {"id": "belly", "region": "lower fuselage and nose cap", "color": BELLY, "note": "blue belly + nose cap (vertexPaint tapered-capsule)"},
      {"id": "belly-stripe", "region": "belly line", "color": RED, "note": "red stripe above the blue belly (vertexPaint tapered-capsule)"},
      {"id": "outline", "region": "silhouette", "color": DARK, "note": "2D sticker outline; optional runtime inverted hull, not geometry"}]),
  material('fin-white', 'Fin white', WHITE, [RED, FINBLUE], 0.4, overrides=[
      {"id": "fin-stripes", "region": "trailing edge", "color": RED, "note": "red + blue trailing-edge stripes (separate sweep components)"}]),
  material('stripe-red', 'Stripe red', RED, [RED], 0.45),
  material('fin-blue', 'Fin stripe blue', FINBLUE, [FINBLUE], 0.45),
  material('porthole-blue', 'Porthole / intake blue', PORT, [GLOSS], 0.15, extra={"clearcoat": {"base": 0.7}, "clearcoatRoughness": {"base": 0.1}}),
  material('engine-white', 'Engine pod white', WHITE, [GLOSS], 0.35),
  material('dark-matte', 'Eyes / lines', DARK, [DARK], 0.6),
  material('cheek-pink', 'Cheek blush', CHEEK, [CHEEK], 0.5),
  material('catchlight', 'Catchlight white', PURE, [PURE], 0.35, extra={"emissive": PURE, "emissiveIntensity": {"base": 1.0}}),
  material('nose-gloss', 'Nose gloss dot', GLOSS, [PURE], 0.2, extra={"emissive": GLOSS, "emissiveIntensity": {"base": 0.3}}),
]
R = lambda h, s='#000000', cls='plastic', **k: recipe(h, s, cls, **k)
comps = [root_component()]

# ---- fuselage: lathe profile measured from the top and belly outlines, projected onto the tilted axis
TOP = [(20,283),(32,268),(48,248),(64,230),(80,213),(100,190),(128,170),(144,165),(160,161),(176,159),(192,158),(208,159),(224,161),(240,163),(256,167),(272,172),(288,177),(304,182),(320,187),(336,192),(352,197),(368,202),(384,207),(400,212),(416,220),(432,228),(445,236)]
BOT = [(20,300),(32,330),(48,350),(64,362),(80,372),(96,381),(112,384),(128,386),(144,387),(160,387),(176,386),(192,385),(208,383),(224,380),(240,376),(256,373),(272,368),(288,362),(304,354),(320,345),(336,335),(352,323),(368,310),(384,296),(400,283),(416,270),(432,258),(445,250)]
t = np.array([math.cos(AXIS_ANGLE), -math.sin(AXIS_ANGLE)])   # image-space unit axis (y down)
n = np.array([math.sin(AXIS_ANGLE), math.cos(AXIS_ANGLE)])    # image-space "down" normal
def proj(p):
    v = np.array(p, float) - np.array(NOSE, float)
    return float(v @ t) * PX, float(v @ n) * PX
top = [proj(p) for p in TOP]; bot = [proj(p) for p in BOT]
stations = np.linspace(0.0, 1.0, 61)
r_top = np.interp(stations, [s for s, _ in top], [-d for _, d in top], left=0.0, right=0.0)
r_bot = np.interp(stations, [s for s, _ in bot], [d for _, d in bot], left=0.0, right=0.0)
radius = (r_top + r_bot) / 2
# single-peaked, smooth profile: monotone up to the widest station, monotone down after it
peak = int(np.argmax(radius))
radius[:peak] = np.maximum.accumulate(radius[:peak])
radius[peak:] = np.minimum.accumulate(radius[peak:])
radius = np.convolve(np.pad(radius, 1, mode='edge'), [0.25, 0.5, 0.25], mode='valid')
radius[0] = 0.0001; radius[-1] = 0.0001
radius[1] = max(radius[1], 0.05); radius[-2] = max(radius[-2], 0.03)   # rounded nose cap / tail cone
profile = [[round(float(r), 4), round(float(s), 4)] for r, s in zip(radius, stations)]
RMAX = float(radius.max())
def R_at(s): return float(np.interp(s, stations, radius))
CAM_D, TARGET = 1.58, (0.049, 0.348)
def at_depth(px, py, z):
    """world x, y for a part at depth z so that it projects onto image point (px, py) under the match camera"""
    mag = CAM_D / (CAM_D - z)
    return [round(TARGET[0] + (X(px) - TARGET[0]) / mag, 4), round(TARGET[1] + (Y(py) - TARGET[1]) / mag, 4)]
fuse_pos = [X(NOSE[0]), Y(NOSE[1]), 0.0]
FUSE_R = Rotation.from_euler('XYZ', [0, 0, FUSE_ROT_Z])
def to_fuse(pos, rot=(0, 0, 0)):
    """world position / XYZ euler -> fuselage-local (the lathe node is rotated -81.4 deg about z)"""
    lp = FUSE_R.inv().apply(np.array(pos, float) - np.array(fuse_pos, float))
    lr = (FUSE_R.inv() * Rotation.from_euler('XYZ', list(rot))).as_euler('XYZ')
    return [round(float(a), 4) for a in lp], [round(float(a), 4) for a in lr]
def fl(px, py):
    """fuselage-local (x = down-ish radial, y = along the axis) for an image point"""
    s, d = proj((px, py)); return d, s
def fl_world(wx, wy):
    v = np.array([wx - fuse_pos[0], wy - fuse_pos[1]])
    axis = np.array([math.cos(AXIS_ANGLE), math.sin(AXIS_ANGLE)]); down = np.array([math.sin(AXIS_ANGLE), -math.cos(AXIS_ANGLE)])
    return float(v @ down), float(v @ axis)
NOSE_CAP = {"centre": [X(62), Y(314), 0.0], "radii": [0.11, 0.125, 0.11]}
def surface_point(px, py, proud=0.0):
    """world position + surface normal of the near-side skin (lathe or nose cap, whichever is outermost) under an image point"""
    wx, wy = X(px), Y(py)
    for _ in range(3):   # perspective: a mark at depth z lands where the camera sees it, so solve x, y for the depth
        d, s = fl_world(wx, wy); s = min(max(s, 0.0), 1.0); rr = R_at(s) + proud
        z_lathe = math.sqrt(max(rr * rr - d * d, 1e-6)) if abs(d) < rr else 0.0
        n_lathe = np.array([0.0, -d, z_lathe])
        cx, cy, _ = NOSE_CAP["centre"]; rx, ry, rz = NOSE_CAP["radii"]
        q = 1 - ((wx - cx) / rx) ** 2 - ((wy - cy) / ry) ** 2
        z_cap = (rz + proud) * math.sqrt(q) if q > 0 else 0.0
        n_cap = np.array([(wx - cx) / rx ** 2, (wy - cy) / ry ** 2, z_cap / rz ** 2])
        z, normal = (z_cap, n_cap) if z_cap > z_lathe else (z_lathe, n_lathe)
        wx, wy = at_depth(px, py, z)
        px_eff, py_eff = px, py
    normal = normal / (np.linalg.norm(normal) or 1.0)
    return [wx, wy, round(z, 4)], normal
# vertex paint: blue belly (chains of capsules offset below the axis whose radii follow the measured profile so the
# coverage angle from the belly bottom is ~105 deg at the nose tip, easing to ~55 deg along the body) + red band above it
STRIPE_PX = [(80, 318), (110, 325), (140, 328), (170, 328), (200, 323), (230, 315), (260, 304), (285, 294)]   # centre line of the red belly band
def stripe_station(px, py):
    """(axial station, angle from the belly bottom) of the skin point that appears at image (px, py)"""
    wx, wy = X(px), Y(py)
    d, sa = fl_world(wx, wy); Rr = R_at(min(max(sa, 0.0), 1.0))
    return sa, math.degrees(math.acos(max(-1.0, min(1.0, d / Rr))))
_stripe = [stripe_station(px, py) for px, py in STRIPE_PX]
_knots_s = [-0.05, 0.0] + [a for a, _ in _stripe] + [0.8, 0.92, 1.05]
_knots_t = [118.0, 115.0] + [b for _, b in _stripe] + [62.0, 76.0, 100.0]
def coverage_angle(s, extra):
    return math.radians(min(float(np.interp(s, _knots_s, _knots_t)) + extra, 175.0))
def band_chain(bid, color, extra):
    knots = [-0.02, 0.04, 0.1, 0.16, 0.22, 0.3, 0.38, 0.46, 0.54, 0.62, 0.72, 0.8, 0.92, 1.02]
    regions = []
    for a, b in zip(knots[:-1], knots[1:]):
        def endpoint(sv):
            Rr = max(R_at(min(max(sv, 0.0), 1.0)), 0.02); off = 0.75 * Rr
            th = coverage_angle(sv, extra)
            return off, math.sqrt(max(Rr * Rr + off * off - 2 * Rr * off * math.cos(th), 1e-6))
        oa, ra = endpoint(a); ob, rb = endpoint(b)
        regions.append({"id": f"{bid}-{len(regions)+1}", "kind": "tapered-capsule", "start": [round(oa, 4), round(a, 4), 0], "end": [round(ob, 4), round(b, 4), 0],
                        "startRadius": round(ra, 4), "endRadius": round(rb, 4), "softness": 0.02, "color": color})
    return regions
belly_regions = band_chain('belly', BELLY, 0.0)
stripe_regions = band_chain('belly-stripe', RED, 18.0)   # report only; the red band is built as a sweep
belly = belly_regions[4]; stripe = stripe_regions[4]
def band_report():
    for s in (0.05, 0.15, 0.3, 0.5, 0.7, 0.9):
        Rr = R_at(s)
        out = []
        for chain in (stripe_regions, belly_regions):
            reg = next(r for r in chain if r['start'][1] <= s <= r['end'][1])
            tt = (s - reg['start'][1]) / (reg['end'][1] - reg['start'][1])
            off = reg['start'][0] + (reg['end'][0] - reg['start'][0]) * tt
            rad = reg['startRadius'] + (reg['endRadius'] - reg['startRadius']) * tt
            c = (Rr * Rr + off * off - rad * rad) / (2 * Rr * off) if Rr > 0 else 2
            out.append(round(math.degrees(math.acos(max(-1, min(1, c)))), 0) if abs(c) <= 1 else ('all' if c < -1 else 'none'))
        print(f'  s={s:.2f} R={Rr:.3f} red-to {out[0]} deg, blue-to {out[1]} deg')
fuselage = component('fuselage', 'Fuselage', 'macro', 'body', 'lathe', 'continuous-sculpt',
  'One chubby tapered volume: the top and belly outlines were measured, projected onto the tilted nose-to-tail axis and revolved as a single-peaked lathe profile; the blue belly, nose cap and red stripe are vertex-painted regions.', 'root',
  fuse_pos, [1.0, 1.0, 1.0], 'plane-white', importance=1.0, confidence=0.9, rotation=[0, 0, round(FUSE_ROT_Z, 4)],
  descriptor={"latheProfile": {"points": profile, "segments": 64}},
  collider={"type": "capsule", "offset": [0, 0.5, 0], "scale": [round(2 * RMAX, 4), 1.0, round(2 * RMAX, 4)], "isTrigger": False, "notes": "capsule along the lathe axis"},
  sockets=[{"id": "wing-near", "localPosition": [0, 0.5, 0.15]}, {"id": "wing-far", "localPosition": [0, 0.5, -0.15]}, {"id": "fin", "localPosition": [-0.2, 0.86, 0]},
           {"id": "tail-near", "localPosition": [0, 0.97, 0.03]}, {"id": "tail-far", "localPosition": [0, 0.97, -0.03]}, {"id": "skin", "localPosition": [0, 0.4, round(RMAX, 4)]}],
  color_recipe=R(WHITE, BELLY, gradient={"type": "linear", "axis": "x", "stops": [{"t": 0.0, "color": "rgba(242, 249, 255, 1.0)"}, {"t": 1.0, "color": "rgba(47, 154, 218, 1.0)"}]}),
  local_features=[{"id": "belly", "kind": "decal", "note": "blue belly (vertexPaint)"}, {"id": "belly-stripe", "kind": "linework", "note": "red stripe along the belly line, built as the belly-stripe sweep"}],
  extra={"vertexPaint": {"baseColor": WHITE, "regions": belly_regions}})
fuselage['dimensions'] = {"width": round(2 * RMAX, 4), "height": 1.0, "depth": round(2 * RMAX, 4), "units": "relative", "confidence": 0.9}
comps.append(fuselage)
cap_pos, cap_rot = to_fuse(NOSE_CAP["centre"])
cap_ry = NOSE_CAP["radii"][1]; cap_rx = (NOSE_CAP["radii"][0] + NOSE_CAP["radii"][2]) / 2
cap_profile = [[round(max(cap_rx * math.sqrt(max(1 - (y / cap_ry) ** 2, 0.0)), 0.0001), 4), round(y, 4)] for y in np.linspace(-cap_ry, cap_ry, 41)]
nose_cap = component('nose-cap', 'Nose cap', 'macro', 'body', 'lathe', 'continuous-sculpt',
  'The sticker nose droops below the fuselage axis: a blunt spheroid cap (dense lathe about the vertical axis) fused into the front of the lathe carries the rounded nose and its blue underside.', 'fuselage',
  cap_pos, [1, 1, 1], 'plane-white', importance=0.9, confidence=0.85, rotation=cap_rot, descriptor={"latheProfile": {"points": cap_profile, "segments": 64}},
  attachment=embed('skin', 0.1), fidelity_tier='blockout', color_recipe=R(WHITE, BELLY),
  local_features=[{"id": "cap-blue", "kind": "decal", "note": "blue nose underside (vertexPaint axis-band)"}],
  extra={"vertexPaint": {"baseColor": WHITE, "regions": [{"id": "cap-blue", "kind": "axis-band", "axis": "y", "min": -1.0, "max": round(Y(285) - NOSE_CAP["centre"][1], 4), "softness": 0.012, "color": BELLY}]}})
nose_cap['dimensions'] = {"width": round(2 * cap_rx, 4), "height": round(2 * cap_ry, 4), "depth": round(2 * cap_rx, 4), "units": "relative", "confidence": 0.85}
comps.append(nose_cap)

# ---- wings and tailplanes: flat ellipsoids whose long axis runs root -> tip as measured; the chord is tilted so the
# side view shows the sticker's fat lens (the sticker cheats a from-below view of the wing's underside)
def euler_from_basis(u, v):
    u = np.array(u, float); u /= np.linalg.norm(u)
    v = np.array(v, float); v = v - (v @ u) * u; v /= np.linalg.norm(v)
    w = np.cross(u, v)
    return [round(float(a), 4) for a in Rotation.from_matrix(np.column_stack([u, v, w])).as_euler('XYZ')]
def lifting_surface(cid, name, root, tip, half_chord, half_thick, side, level, tier, importance, socket, extra_note=''):
    root = np.array(at_depth(root[0], root[1], root[2]) + [root[2]], float); tip = np.array(at_depth(tip[0], tip[1], tip[2]) + [tip[2]], float)
    u = tip - root; length = float(np.linalg.norm(u)); u /= length
    p = np.array([-u[1], u[0], 0.0]); p /= np.linalg.norm(p)         # perpendicular of the projected long axis (in the picture plane)
    v = 0.85 * p + np.array([0.0, 0.0, 0.53 * (1 if root[2] >= 0 else -1)])  # chord: mostly across the picture plane, part along z
    centre = (root + tip) / 2
    lpos, lrot = to_fuse(centre, euler_from_basis(u, v))
    c = component(cid, name, level, 'fin', 'ellipsoid', 'assembled-solid',
      f'Flat lens-shaped wing surface ({name.lower()}): an ellipsoid whose long axis runs from the fuselage root to the measured tip{extra_note}.', 'fuselage',
      lpos, [round(length, 4), round(2 * half_chord, 4), round(2 * half_thick, 4)], 'plane-white',
      importance=importance, confidence=0.8 if side == 'near' else 0.6, rotation=lrot, attachment=embed(socket, 0.08),
      collider={"type": "box", "offset": [0, 0, 0], "scale": [round(length, 4), round(2 * half_chord, 4), round(2 * half_thick, 4)], "isTrigger": False, "notes": "ellipsoid proxy"},
      fidelity_tier=tier, color_recipe=R(WHITE, GLOSS))
    return c
wing_root, wing_tip = [232, 338, 0.22], [440, 398, 0.27]   # image px + depth; the near wing sits just outside the skin like the sticker
tail_root, tail_tip = [425, 250, 0.05], [497, 246, 0.12]
far_wing_root, far_wing_tip = [120, 300, -0.1], [25, 165, -0.1]
far_tail_root, far_tail_tip = [405, 212, -0.06], [340, 168, -0.06]
comps.append(lifting_surface('airfoil-near', 'Near airfoil', wing_root, wing_tip, 0.11, 0.03, 'near', 'macro', 'blockout', 0.95, 'wing-near', ' (swept back and drooping toward the viewer like the sticker)'))
comps.append(lifting_surface('airfoil-far', 'Far airfoil', far_wing_root, far_wing_tip, 0.11, 0.024, 'far', 'macro', 'blockout', 0.6, 'wing-far', ' (the sticker cheats the far wing forward and up beside the nose; the prop keeps that look because the games always show this side)'))
comps.append(lifting_surface('stabiliser-near', 'Near stabiliser', tail_root, tail_tip, 0.055, 0.014, 'near', 'meso', 'blockout', 0.7, 'tail-near'))
comps.append(lifting_surface('stabiliser-far', 'Far stabiliser', far_tail_root, far_tail_tip, 0.04, 0.012, 'far', 'meso', 'blockout', 0.45, 'tail-far', ' (cheated above the tail like the sticker)'))

# ---- fin: measured swept polygon extruded through a thin thickness, with the red + blue trailing-edge stripes vertex-painted
FIN = [(352,196),(372,172),(392,148),(412,122),(430,101),(445,94),(458,98),(460,112),(456,160),(452,200),(447,236),(400,236)]
fin_pts = [[X(px), Y(py)] for px, py in FIN]
fcx = round(sum(p[0] for p in fin_pts) / len(fin_pts), 4); fcy = round(sum(p[1] for p in fin_pts) / len(fin_pts), 4)
fin_local = [[round(p[0] - fcx, 4), round(p[1] - fcy, 4)] for p in fin_pts]
FIN_T = 0.035
def finl(px, py, z): return [round(X(px) - fcx, 4), round(Y(py) - fcy, 4), z]
fin_pos, fin_rot = to_fuse([fcx, fcy, round(-FIN_T / 2, 4)])
fin = component('fin', 'Fin', 'macro', 'fin', 'extrude', 'assembled-solid',
  'Swept vertical stabiliser: the side outline was measured and extruded through a thin thickness, centred on the fuselage plane.', 'fuselage',
  fin_pos, [1, 1, 1], 'fin-white', importance=0.9, confidence=0.85, rotation=fin_rot, attachment=embed('fin', 0.05),
  descriptor={"profile2D": {"points": fin_local, "depth": FIN_T}}, fidelity_tier='blockout',
  collider={"type": "box", "offset": [0, 0, FIN_T / 2], "scale": [round(max(p[0] for p in fin_local) - min(p[0] for p in fin_local), 4), round(max(p[1] for p in fin_local) - min(p[1] for p in fin_local), 4), FIN_T], "isTrigger": False, "notes": "fin proxy"},
  color_recipe=R(WHITE, RED), local_features=[{"id": "fin-stripes", "kind": "linework", "note": "red + blue trailing-edge stripes built as the fin-stripe sweeps"}])
fin['dimensions'] = {"width": fin['actionProfile']['collider']['scale'][0], "height": fin['actionProfile']['collider']['scale'][1], "depth": FIN_T, "units": "relative", "confidence": 0.85}
comps.append(fin)

# ---- engine pods under the wings: rounded ellipsoid pods (like the sticker's capsule) with a flat blue intake disc at the front
POD_L, POD_R = round((350 - 265) * PX / 1.23, 4), 0.042
for side, zsign in (('near', 1),):
    z = round(0.3 * zsign, 4)
    mid, mrot = to_fuse(at_depth(307.5, 393, z) + [z], [0, 0, AXIS_ANGLE * 0.3])
    comps.append(component(f'engine-{side}', f'Engine pod ({side})', 'meso', 'engine', 'ellipsoid', 'assembled-solid',
      'Rigid white pod hung under the wing: a rounded ellipsoid along the flight axis.', 'fuselage', mid, [POD_L, 2 * POD_R, 2 * POD_R], 'engine-white',
      importance=0.7 if side == 'near' else 0.4, confidence=0.8 if side == 'near' else 0.6, rotation=mrot,
      attachment=embed(f'engine-{side}', 0.02), fidelity_tier='blockout' if side == 'near' else 'structural-pass',
      collider={"type": "capsule", "offset": [0, 0, 0], "scale": [POD_L, 2 * POD_R, 2 * POD_R], "isTrigger": False, "notes": "pod proxy"},
      sockets=[{"id": "intake", "localPosition": [round(-POD_L / 2, 4), 0, 0]}], color_recipe=R(WHITE, GLOSS)))
    comps.append(component(f'intake-{side}', f'Intake ({side})', 'micro', 'detail', 'ellipsoid', 'material-only', 'Blue intake disc on the front of the engine pod.', f'engine-{side}',
      [round(-POD_L / 2 + 0.004, 4), 0, 0], [0.016, 0.07, 0.07], 'porthole-blue', importance=0.5, confidence=0.75,
      attachment=embed('intake', 0.004), fidelity_tier='form-refinement', color_recipe=R(PORT, GLOSS, 'glass')))
fuselage['actionProfile']['sockets'] += [{"id": "engine-near", "localPosition": to_fuse(at_depth(265, 393, 0.3) + [0.3])[0]}]

# ---- portholes and face: flat ellipsoids seated on the near-side skin (material-only markings)
def skin_mark(cid, name, px, py, scale, mat, tier='form-refinement', importance=0.55, level='micro', proud=0.0):
    pos, normal = surface_point(px, py, proud)
    tilt = -math.atan2(normal[1], normal[2])
    lpos, lrot = to_fuse(pos, [tilt, 0, 0])
    return component(cid, name, level, 'detail', 'ellipsoid', 'material-only', f'{name}: flat marking seated on the fuselage skin.', 'fuselage',
      lpos, scale, mat, importance=importance, confidence=0.85, rotation=lrot, attachment=embed('skin', 0.006), fidelity_tier=tier)
for i, (px, py) in enumerate(((234, 265), (275, 257), (313, 249), (350, 241)), 1):
    comps.append(skin_mark(f'porthole-{i}', f'Porthole {i}', px, py, [0.06, 0.072, 0.014], 'porthole-blue', importance=0.6, proud=0.002))
comps += [
  skin_mark('eye-a', 'Eye (rear, large)', 161, 265, [0.095, 0.1, 0.016], 'dark-matte', importance=0.8, proud=0.003),
  skin_mark('eye-b', 'Eye (front, small)', 82, 243, [0.076, 0.082, 0.016], 'dark-matte', importance=0.8, proud=0.003),
  skin_mark('catchlight-a', 'Catchlight (rear big)', 168, 258, [0.03, 0.03, 0.012], 'catchlight', proud=0.012),
  skin_mark('catchlight-a2', 'Catchlight (rear small)', 152, 276, [0.016, 0.016, 0.012], 'catchlight', proud=0.012),
  skin_mark('catchlight-b', 'Catchlight (front)', 88, 236, [0.026, 0.026, 0.012], 'catchlight', proud=0.012),
  skin_mark('cheek-a', 'Cheek (rear)', 162, 298, [0.07, 0.034, 0.012], 'cheek-pink', proud=0.002),
  skin_mark('cheek-b', 'Cheek (front)', 63, 268, [0.036, 0.024, 0.012], 'cheek-pink', proud=0.002),
  skin_mark('nose-gloss', 'Nose gloss dot', 30, 293, [0.026, 0.034, 0.012], 'nose-gloss', proud=0.002),
]
def stroke(cid, name, pts_px, radius, tier='form-refinement', mat='dark-matte', level='micro', proud=0.008, end_scale=0.0, positions=None, importance=0.6, note='thin painted stroke on the nose'):
    pts = positions if positions is not None else [surface_point(px, py, proud)[0] for px, py in pts_px]
    stations = []
    for i, pos in enumerate(pts):
        rr = round(radius * end_scale, 4) if i in (0, len(pts) - 1) else radius
        stations.append({"position": [round(float(a), 4) for a in pos], "rx": rr, "rz": rr, "twist": 0.0})
    inv_pos, inv_rot = to_fuse([0, 0, 0])   # stations stay in world units: the sweep carries the inverse fuselage transform
    return component(cid, name, level, 'detail', 'tapered-sweep', 'material-only', f'{name}: {note}, built as a tapered sweep so it stays crisp.', 'fuselage',
      inv_pos, [1, 1, 1], mat, rotation=inv_rot, importance=importance, confidence=0.85, attachment=embed('skin', 0.004), fidelity_tier=tier,
      descriptor={"taperedSweep": {"stations": stations, "radialSegments": 8, "capEnds": True}})
def skin_at_angle(s_axis, theta_deg, sink=0.0):
    """world point on the fuselage skin at axial station s and angle theta from the belly bottom (near side)"""
    Rr = R_at(s_axis) - sink; th = math.radians(theta_deg)
    local = np.array([Rr * math.cos(th), s_axis, Rr * math.sin(th)])
    return (FUSE_R.apply(local) + np.array(fuse_pos)).tolist()
belly_pts = [surface_point(px, py, -0.012)[0] for px, py in STRIPE_PX]
comps.append(stroke('belly-stripe', 'Belly stripe', None, 0.034, tier='structural-pass', mat='stripe-red', level='meso', end_scale=0.35, positions=belly_pts, importance=0.75, note='red band along the blue belly line'))
FIN_Z = FIN_T / 2 - 0.004
fin_red = [[X(px), Y(py), FIN_Z] for px, py in ((447, 103), (442, 150), (437, 200), (433, 236))] + [surface_point(px, py, -0.012)[0] for px, py in ((405, 262), (365, 282), (318, 296))]
fin_blue = [[X(px), Y(py), FIN_Z] for px, py in ((457, 100), (453, 150), (449, 200), (446, 240))] + [surface_point(px, py, -0.012)[0] for px, py in ((420, 275), (385, 296), (352, 306))]
comps.append(stroke('fin-stripe-red', 'Fin stripe (red)', None, 0.013, tier='structural-pass', mat='stripe-red', level='meso', end_scale=0.4, positions=fin_red, importance=0.7, note='red stripe along the fin trailing edge running down the rear fuselage to the wing'))
comps.append(stroke('fin-stripe-blue', 'Fin stripe (blue)', None, 0.011, tier='structural-pass', mat='fin-blue', level='meso', end_scale=0.4, positions=fin_blue, importance=0.6, note='blue stripe behind the red one'))
comps.append(stroke('smile', 'Smile', [(93, 269), (100, 281), (110, 288), (120, 283), (128, 270)], 0.008))
comps.append(stroke('brow-a', 'Eyebrow (rear)', [(164, 236), (172, 229), (181, 230)], 0.006))
comps.append(stroke('brow-b', 'Eyebrow (front)', [(82, 213), (89, 208), (97, 210)], 0.005))

ids = [c['id'] for c in comps]
passes = [
  {"id": "blockout", "goal": "Fuselage lathe, wings, stabilisers, fin and the near engine pod: the whole sticker silhouette.", "componentRefs": ["root", "fuselage", "nose-cap", "airfoil-near", "airfoil-far", "stabiliser-near", "stabiliser-far", "fin", "engine-near"], "acceptance": ["fuselage height/length ~0.5", "near wing lens from (-0.03,0.22) to (0.48,0.06)", "fin top at y 0.72"]},
  {"id": "structural-pass", "goal": "Engine pod with intake, belly stripe and fin stripes attached as crisp sweeps.", "componentRefs": ids, "acceptance": ["no floating parts", "stripes hug the skin"]},
  {"id": "form-refinement", "goal": "Portholes, eyes with catchlights, cheeks, smile, eyebrows, nose gloss seated on the skin.", "componentRefs": ids, "acceptance": ["face reads on the nose", "four portholes in a row"]},
  {"id": "material-pass", "goal": "Satin white airframe with blue belly/nose cap, red belly stripe, fin stripes, glossy blue portholes and intakes.", "componentRefs": ids, "acceptance": ["belly blue reaches the stripe line", "palette within sampled stops"]},
  {"id": "surface-pass", "goal": "Flat satin plastic, glossy glass discs; no bump maps (sticker).", "componentRefs": ids, "acceptance": ["no texture noise"]},
  {"id": "lighting-pass", "goal": "Neutral fill, frontal upper-left key, Neutral tone mapping, exposure 1.4.", "componentRefs": ["root"], "acceptance": ["white stays white, not grey"]},
  {"id": "interaction-pass", "goal": "Wings flex about their roots (bank), whole plane pitches/banks; sockets and colliders exposed.", "componentRefs": ids, "acceptance": ["wing pivot test"]},
  {"id": "optimization-pass", "goal": "Stay under 30k triangles.", "componentRefs": ids, "acceptance": ["targetTriangles respected"]},
]
targets = [
  {"id": "overall-silhouette", "name": "Chubby fuselage with swept fin and fat near wing", "tier": "critical", "passIds": ["blockout", "structural-pass"], "minimumScore": 0.75, "mustPass": True, "componentRefs": ["fuselage", "nose-cap", "airfoil-near", "fin"], "evidenceRefs": ["full-object"]},
  {"id": "primary-structure", "name": "Tailplane, engine pod with intake, fin stripes in their measured places", "tier": "critical", "passIds": ["structural-pass", "form-refinement"], "minimumScore": 0.72, "mustPass": True, "componentRefs": ["stabiliser-near", "engine-near", "intake-near", "fin-stripe-red", "belly-stripe"], "evidenceRefs": ["full-object"]},
  {"id": "face-and-details", "name": "Smiling face with two eyes on the nose, four portholes", "tier": "critical", "passIds": ["form-refinement", "material-pass"], "minimumScore": 0.72, "mustPass": True, "componentRefs": ["eye-a", "eye-b", "smile", "porthole-1"], "evidenceRefs": ["full-object"]},
  {"id": "reference-material-system", "name": "White/blue/red palette, satin plastic vs glossy discs", "tier": "important", "passIds": ["material-pass", "surface-pass", "lighting-pass"], "minimumScore": 0.7, "mustPass": False, "componentRefs": ["fuselage", "porthole-1", "fin"], "evidenceRefs": ["full-object"]},
]
spec = json.load(open('object-sculpt-spec.json'))
spec = apply_common(spec, components=comps, materials=mats, review_targets=targets, passes=passes,
  silhouette={"boundingShape": "chubby tapered cigar with a swept fin above the tail and a fat lens wing sweeping down-right", "aspectRatios": ["width/height 1.5 incl. fin and wing", "fuselage height/length 0.51"], "symmetry": "bilateral about the fuselage's vertical plane",
              "dominantCurves": ["rounded nose", "swept fin leading edge", "wing lens"], "negativeSpaces": ["between the wing underside and the engine pod", "under the tail"], "landmarks": ["nose tip x -0.49 y 0.24", "fin top y 0.72", "wing tip x 0.48 y 0.06", "tailplane tip x 0.59"]},
  observations=["single side view, nose to the left, cheated from slightly below", "face with two eyes on the nose, four portholes", "blue belly and nose cap, red belly stripe, red/blue fin stripes", "fat near wing with an engine pod and blue intake"],
  repetition=[{"id": "portholes", "kind": "repeated-parts", "count": 4, "distribution": "evenly spaced along the near side, following the tilted axis", "buildsGeometry": True, "instances": ["porthole-1", "porthole-2", "porthole-3", "porthole-4"]},
              {"id": "lifting-surfaces", "kind": "repeated-parts", "count": 2, "distribution": "one wing each side of the fuselage, the far one cheated forward like the sticker", "buildsGeometry": True, "instances": ["airfoil-near", "airfoil-far"]},
              {"id": "fin-stripes", "kind": "repeated-parts", "count": 2, "distribution": "red then blue stripe along the fin trailing edge and down the rear fuselage", "buildsGeometry": True, "instances": ["fin-stripe-red", "fin-stripe-blue"]}],
  assumptions=["Fuselage cross-section is circular; its axis tilts 8.6 deg (tail up).", "The far wing and far stabiliser are placed where the sticker cheats them (beside the nose, above the tail) instead of as true mirrors, so the prop reads exactly like the sticker from its display side; the games only ever show this side (the model is mirrored in z when it flies the other way).", "Wing chord is tilted toward the viewer so the side view shows the sticker's fat lens.", "Sticker white border and outer outline are 2D conventions and were stripped from the gate reference (refs/plane-clean.png)."],
  risks=["Vertex-painted belly and stripe depend on lathe vertex density (48 segments, 41 stations).", "The tilted wings look unusual from the front; acceptable for a side-scrolling toddler game."],
  coordinate_frame={"front": "-X (the nose points toward -x; the reference shows the +z side)", "up": "+Y", "scaleReference": "fuselage nose-to-tail length = 1.0; ground under the engine pod (y = 0)"},
  quality_depth={"macroComponents": 5, "mesoComponents": 4, "microFeatureGroups": 3, "materialLayers": 5, "repetitionSystems": 3, "reviewViewpoints": 4})
details = [
  ("belly-stripe", "linework", "red stripe along the blue belly line from the nose to the wing", "belly-stripe", [0.15, 0.58, 0.35, 0.1]),
  ("fin-stripes", "linework", "red and blue stripes along the fin's trailing edge", "fin-stripes", [0.78, 0.18, 0.14, 0.4]),
  ("portholes", "decal", "four glossy blue portholes in a row", "porthole-1", [0.43, 0.45, 0.28, 0.1]),
  ("face-decal", "decal", "two eyes with catchlights, eyebrows, cheeks and a smile on the nose", "eye-a", [0.1, 0.4, 0.28, 0.2]),
  ("intake-disc", "gloss", "blue intake disc on the engine pod", "intake-near", [0.52, 0.72, 0.06, 0.08]),
  ("nose-gloss", "gloss", "small light dot on the blue nose", "nose-gloss", [0.04, 0.56, 0.03, 0.03]),
  ("belly-cap", "decal", "blue nose cap and belly", "belly", [0.02, 0.54, 0.48, 0.22]),
]
inv = {"scanMethod": "grid-3x3", "targetMinDetails": 6, "details": [
  {"id": did, "kind": kind, "description": desc, "region": {"x": r[0], "y": r[1], "width": r[2], "height": r[3], "units": "normalized"}, "scale": "meso" if kind in ("linework", "decal") else "micro",
   "affects": ["albedo"] if kind in ("decal", "linework") else ["roughness"], "evidenceRef": "full-object", "confidence": 0.85, "mapsTo": {"ref": ref}}
  for did, kind, desc, ref, r in details]}
spec['preSpecAssessment']['detailInventory'] = inv
spec['preSpecAssessment']['objectClass'] = {**spec['preSpecAssessment'].get('objectClass', {}), "primaryType": "toy passenger jet", "primaryDomain": "object", "confidence": 0.95,
  "formLanguage": ["organic-rounded", "chubby cigar fuselage", "swept fin", "lens wings"], "structureKind": ["assembled", "fuselage + wings + fin + pods"], "motionPotential": ["whole plane pitches and banks", "wings flex at the root", "engine pods spin (intake)"], "materialFamilies": ["painted plastic (satin)", "glossy glass discs", "emissive catchlights"]}
surface = {
  'fuselage': {"macroRoughness": 0.4, "microRoughness": 0.03, "bumpAmplitude": 0.0, "normalPattern": "none (flat satin paint)", "displacementPattern": "none", "occlusionPattern": "contact darkening under the wing roots and portholes", "edgeWearPattern": "none", "notes": "smooth lathe"},
  'fin': {"macroRoughness": 0.4, "microRoughness": 0.03, "bumpAmplitude": 0.0, "normalPattern": "none", "displacementPattern": "none", "occlusionPattern": "fin root", "edgeWearPattern": "none", "notes": "thin extrude"},
  'porthole-1': {"macroRoughness": 0.15, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "none (glass)", "displacementPattern": "none", "occlusionPattern": "disc rim", "edgeWearPattern": "none", "notes": "glossy disc"},
}
for c in comps:
    if c['id'] in surface: c['surfaceDetail'] = surface[c['id']]
for L in spec['lightingFromPhoto']:
    if L['id'] == 'fill':
        L.update(skyColor='#ffffff', groundColor='#eef2fa', evidence='near-white cool ground so the white airframe and blue belly are not dimmed from below (the sticker is flat-lit)')
    if L['id'] == 'exposure':
        L.update(toneMapping='Neutral', exposure=1.55, evidence='Neutral keeps the saturated blue and red; exposure 1.55 brings the white side to the sampled value')
    if L['id'] == 'key':
        L.update(direction=[-0.35, 0.6, 1.0], intensity=1.5, evidence='the sticker is lit flat from the viewer side; a frontal upper-left key lights the near side fully')
json.dump(spec, open('object-sculpt-spec.json', 'w'), indent=2)
a = json.load(open('assessment.json')); a['preSpecAssessment']['detailInventory'] = inv; a['preSpecAssessment']['unknownsToResolveBeforeImplementation'] = []; json.dump(a, open('assessment.json', 'w'), indent=2)
d = json.load(open('di.json')); d['detailInventory'] = inv; json.dump(d, open('di.json', 'w'), indent=2)
print('plane spec authored:', len(comps), 'components,', len(mats), 'materials; RMAX', round(RMAX, 3), 'fuse rot', round(FUSE_ROT_Z, 3))
print('profile', profile[:6], '...', profile[-4:])
band_report()
