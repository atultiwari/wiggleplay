"""Author the WigglePlay bus ObjectSculptSpec from the measured reference (refs/bus.png, 512 px)."""
import json, sys
sys.path.insert(0, '/Users/atultiwari/Downloads/Projects/KidsProject/wiggleplay/3d/tools')
from specgen import apply_common, attach, component, embed, hidden_material, material, recipe, root_component

# Frame: bus length (yellow body 466 px) = 1.0; x = (px-256)/466, y = (381-py)/466 (ground at the wheel bottoms, measured); z = depth, +z = visible side.
PX = 1 / 466
def X(px): return round((px - 256) * PX, 4)
def Y(py): return round((381 - py) * PX, 4)
D = 0.42  # assumed bus width

# Palette lifted ~10% in value versus the sampled stops so it survives ACES at exposure 1.25 (measured on the mascot and the first bus renders).
YEL, ROOF, ORG, GLASS, GLASS_HI, DARK, TYRE, HUB, CHEEK, WHITE = '#ffc61e', '#ffd75c', '#ff8c2e', '#9ddcff', '#d6f1ff', '#221b17', '#3b2b1f', '#ffd24a', '#f7a0bd', '#ffffff'
mats = [
  hidden_material(),
  material('bus-yellow', 'Bus body yellow', YEL, [ROOF, ORG], 0.45, variation=0.05, overrides=[
      {"id": "roof-band", "region": "upper body", "color": ROOF, "note": "lighter roof band (vertexPaint axis-band)"},
      {"id": "outline", "region": "silhouette", "color": DARK, "note": "2D sticker outline; optional runtime inverted hull, not geometry"}]),
  material('orange-trim', 'Orange trim', ORG, [ORG], 0.55),
  material('glass-blue', 'Window glass', GLASS, [GLASS_HI, '#5fb8f0'], 0.1, variation=0.03, overrides=[
      {"id": "highlight-streaks", "region": "diagonal upper-left of each pane", "color": GLASS_HI, "note": "two lighter diagonal streaks per pane (vertexPaint tapered-capsule)"}],
      extra={"clearcoat": {"base": 0.8}, "clearcoatRoughness": {"base": 0.08}}),
  material('dark-matte', 'Dark interior / lines', DARK, [DARK], 0.85),
  material('tyre-rubber', 'Tyre rubber', TYRE, ['#2a1d14'], 0.9, overrides=[{"id": "tread-rim", "region": "tyre shoulder", "color": '#2a1d14', "note": "darker rim ring (vertexPaint axis-band on the cylinder)"}]),
  material('hub-yellow', 'Hub cap', HUB, [YEL], 0.4, extra={"clearcoat": {"base": 0.3}, "clearcoatRoughness": {"base": 0.2}}),
  material('cheek-pink', 'Cheek blush', CHEEK, [CHEEK], 0.5),
  material('catchlight', 'Catchlight white', WHITE, [WHITE], 0.35, extra={"emissive": WHITE, "emissiveIntensity": {"base": 1.0}}),
  material('headlight-glow', 'Headlight', '#bfe8ff', [WHITE], 0.15, extra={"emissive": '#8fd4ff', "emissiveIntensity": {"base": 0.4}, "clearcoat": {"base": 0.8}, "clearcoatRoughness": {"base": 0.1}}),
]
R = lambda h, s='#000000', cls='plastic', **k: recipe(h, s, cls, **k)
comps = [root_component()]
# ---- body: the whole yellow side outline (roof curve, sloping hood) measured from the reference and extruded through the width
import numpy as np
from PIL import Image
_im = np.array(Image.open('../refs/bus-clean.png').convert('RGB')).astype(int)
_mask = ~((_im[:,:,0]>235)&(_im[:,:,1]>235)&(_im[:,:,2]>235))
_mask[363:] = False   # wheels live below the body bottom edge
top = []
for px in range(26, 488, 6):
    col = np.where(_mask[:, px])[0]
    if len(col): top.append((px, int(col.min())))
top.append((487, int(np.where(_mask[:, 487])[0].min())))
profile = [[X(px), Y(py)] for px, py in top] + [[X(488), Y(362)], [X(25), Y(362)]]
profile = [[round(a, 4), round(b, 4)] for a, b in profile]
body_x0, body_x1, body_y0, body_y1 = X(25), X(488), Y(362), min(p[1] for p in profile) * -1 + 0  # placeholder, fixed below
body_y1 = max(p[1] for p in profile)
body = component('body', 'Body', 'macro', 'body', 'extrude', 'continuous-sculpt',
  'The yellow body is one continuous rigid volume whose side outline (rounded roof, sloping hood, flat floor) was measured column-by-column from the reference and extruded through the bus width; the hood is part of this profile, not a separate box.', 'root',
  [0, 0, round(-D/2, 4)], [1.0, 1.0, 1.0], 'bus-yellow',
  importance=1.0, confidence=0.9, descriptor={"profile2D": {"points": profile, "depth": D}},
  collider={"type": "box", "offset": [round((body_x0+body_x1)/2, 4), round((body_y0+body_y1)/2, 4), round(D/2, 4)], "scale": [round(body_x1-body_x0, 4), round(body_y1-body_y0, 4), D], "isTrigger": False, "notes": "box proxy around the extruded body"},
  sockets=[{"id": "axle-rear", "localPosition": [X(113), Y(341), round(D/2, 4)]}, {"id": "axle-front", "localPosition": [X(340), Y(341), round(D/2, 4)]},
           {"id": "side", "localPosition": [0, Y(250), D]}, {"id": "front", "localPosition": [X(488), Y(300), round(D/2, 4)]}, {"id": "rear", "localPosition": [X(25), Y(335), round(D/2, 4)]}],
  color_recipe=R(YEL, ROOF, gradient={"type": "linear", "axis": "y", "stops": [{"t": 0.0, "color": "rgba(255, 198, 30, 1.0)"}, {"t": 1.0, "color": "rgba(255, 215, 92, 1.0)"}]}),
  local_features=[{"id": "roof-band", "kind": "decal", "note": "lighter roof band (vertexPaint)"}, {"id": "stripe", "kind": "linework", "note": "double orange side stripe built as components stripe-1/2"}],
  extra={"vertexPaint": {"baseColor": YEL, "regions": [{"id": "roof-band", "kind": "axis-band", "axis": "y", "min": round(Y(160), 4), "max": 1.0, "softness": 0.05, "color": ROOF}]}})
comps.append(body)
bc = body['transform']['position']
def bl(px, py, z=D/2):  # body-local from pixel: pivot sits at z=-D/2, so the visible side face is local z = D
    return [X(px), Y(py), round(z + D/2, 4)]
hc = [0, 0]
# ---- windows: measured pane outlines extruded 12 mm-equivalent proud of the side face (material-only glass)
def polypane(cid, name, px_points, streaks=None, tier='form-refinement', importance=0.8, mat='glass-blue', depth=0.012, z_off=0.0):
    pts = [[X(px), Y(py)] for px, py in px_points]
    cx = round(sum(p[0] for p in pts) / len(pts), 4); cy = round(sum(p[1] for p in pts) / len(pts), 4)
    local = [[round(p[0]-cx, 4), round(p[1]-cy, 4)] for p in pts]
    w = max(p[0] for p in local) - min(p[0] for p in local); h = max(p[1] for p in local) - min(p[1] for p in local)
    c = component(cid, name, 'meso', 'window', 'extrude', 'material-only', 'A flat glass pane whose outline was measured from the reference and extruded a hair proud of the side face.', 'body',
      [cx, cy, round(D + 0.002 + z_off, 4)], [1, 1, 1], mat, importance=importance, confidence=0.85, attachment=embed('side', 0.006), fidelity_tier=tier,
      descriptor={"profile2D": {"points": local, "depth": depth}},
      collider={"type": "box", "offset": [0, 0, depth/2], "scale": [round(w, 4), round(h, 4), depth], "isTrigger": False, "notes": "pane proxy"},
      local_features=[{"id": "streaks", "kind": "gloss", "note": "lighter diagonal streaks (vertexPaint)"}] if streaks else [])
    c['dimensions'] = {"width": round(w, 4), "height": round(h, 4), "depth": depth, "units": "relative", "confidence": 0.85}
    if streaks:
        c['vertexPaint'] = {"baseColor": GLASS, "regions": [
          {"id": f"streak-{i}", "kind": "tapered-capsule", "start": [round(X(a)-cx, 4), round(Y(b)-cy, 4), 0.006], "end": [round(X(cc)-cx, 4), round(Y(d)-cy, 4), 0.006], "startRadius": rad*PX, "endRadius": rad*PX, "softness": 0.003, "color": GLASS_HI}
          for i, (a, b, cc, d, rad) in enumerate(streaks, 1)]}
    return c
rear_window = [(93,155),(120,155),(218,155),(225,169),(225,238),(222,241),(64,241),(51,225),(51,205),(56,183),(63,169)]
comps.append(polypane('window-rear', 'Rear window', rear_window, streaks=[(120,158,95,238,7),(150,158,125,238,4),(205,158,180,238,4)]))
for i, xdiv in enumerate((107, 168), 1):
    comps.append(component(f'window-divider-{i}', f'Window divider {i}', 'micro', 'trim', 'box', 'material-only', 'Thin dark divider bar between rear window panes.', 'body',
      bl(xdiv, 198, D/2 + 0.014), [round(3*PX, 4), round(86*PX, 4), 0.006], 'dark-matte', importance=0.4, confidence=0.8, attachment=embed('side', 0.004), fidelity_tier='form-refinement'))
cab_window = [(346,153),(374,153),(399,167),(403,181),(409,209),(411,223),(410,241),(327,241),(316,223),(313,195),(312,181),(313,167)]
comps.append(polypane('window-cab', 'Cab window (face)', cab_window, streaks=[(395,160,360,238,5)]))
# ---- door: dark recessed opening, yellow leaf edge, four small panes
comps.append(component('door-opening', 'Door opening', 'meso', 'door', 'box', 'material-only', 'Dark recessed opening of the open door, a flat dark panel on the side face.', 'body',
  bl(268, 249, D/2 + 0.003), [round((304-232)*PX, 4), round((344-154)*PX, 4), 0.008], 'dark-matte', importance=0.8, confidence=0.8, attachment=embed('side', 0.004), fidelity_tier='structural-pass', color_recipe=None))
comps.append(component('door', 'Door leaf', 'meso', 'door', 'box', 'assembled-solid', 'The open door leaf: a thin rigid yellow panel hinged at the rear edge of the opening.', 'body',
  bl(238, 249, D/2 + 0.012), [0.024, round((344-154)*PX, 4), 0.02], 'bus-yellow', importance=0.7, confidence=0.75, attachment=embed('side', 0.005),
  anim_role='door', pivot_mode='hinge', pivot_axis=[0, 1, 0], fidelity_tier='structural-pass', color_recipe=R(YEL, ROOF),
  sockets=[{"id": "leaf", "localPosition": [0, 0, 0]}]))
door_pos = comps[-1]['transform']['position']
# the four panes ride on the hinged leaf so the whole door swings about its rear post
for i, (x0, x1, y0, y1) in enumerate(((245,260,167,241),(283,296,167,241),(245,259,258,333),(283,296,258,331)), 1):
    pane_pos = bl((x0+x1)/2, (y0+y1)/2, D/2 + 0.01)
    comps.append(component(f'door-pane-{i}', f'Door pane {i}', 'micro', 'window', 'box', 'material-only', 'Small glass pane riding on the hinged door leaf.', 'door',
      [round(a - b, 4) for a, b in zip(pane_pos, door_pos)], [round((x1-x0)*PX, 4), round((y1-y0)*PX, 4), 0.008], 'glass-blue', importance=0.5, confidence=0.8, attachment=embed('leaf', 0.004), fidelity_tier='form-refinement'))
# ---- double orange stripe
for i, (y0, y1) in enumerate(((256, 263), (269, 276)), 1):
    comps.append(component(f'stripe-{i}', f'Orange side stripe {i}', 'meso' if i == 1 else 'micro', 'trim', 'box', 'material-only', 'Painted orange line along the side, a flat strip on the surface.', 'body',
      bl((55+232)/2, (y0+y1)/2, D/2 + 0.004), [round((232-55)*PX, 4), round((y1-y0)*PX, 4), 0.01], 'orange-trim', importance=0.7, confidence=0.85, attachment=embed('side', 0.005), fidelity_tier='structural-pass'))
# ---- wheels (visible side + mirrored hidden side), tyres as cylinders along z, hubs as flat cylinders
for side, z in (('near', D/2 - 0.02), ('far', -(D/2 - 0.02))):
    for where, cx, parent, socket in (('rear', 113, 'body', 'axle-rear'), ('front', 340, 'body', 'axle-front')):
        pos = [X(cx), Y(341), round(z + D/2, 4)]
        cid = f'wheel-{where}-{side}'
        comps.append(component(cid, f'Wheel {where} {side}', 'macro' if side == 'near' else 'meso', 'wheel', 'cylinder', 'assembled-solid',
          'A rigid rubber disc: a short cylinder on the axle, rotating about z.', parent, pos, [round(82*PX, 4), 0.09, round(82*PX, 4)], 'tyre-rubber',
          importance=0.9 if side == 'near' else 0.5, confidence=0.85 if side == 'near' else 0.6,
          attachment=attach(socket, pos, [pos[0], pos[1], round(pos[2] + (0.045 if side == 'near' else -0.045), 4)], round(41*PX, 4), round(41*PX, 4), contact='axle', embed=0.04),
          anim_role='wheel', pivot_mode='center', pivot_axis=[0, 0, 1], collider={"type": "cylinder", "offset": [0, 0, 0], "scale": [round(82*PX, 4), 0.09, round(82*PX, 4)], "isTrigger": False, "notes": "wheel proxy"},
          color_recipe=R(TYRE, '#2a1d14', 'rubber'), local_features=[{"id": "tread-rim", "kind": "ridge", "note": "darker shoulder ring (vertexPaint axis-band)"}],
          sockets=[{"id": "hub", "localPosition": [0, 0, 0.046 if side == 'near' else -0.046]}],
          extra={"vertexPaint": {"baseColor": TYRE, "regions": [{"id": "tread-rim", "kind": "axis-band", "axis": "y", "min": -0.5, "max": -0.35, "softness": 0.02, "color": '#2a1d14'}, {"id": "tread-rim-far", "kind": "axis-band", "axis": "y", "min": 0.35, "max": 0.5, "softness": 0.02, "color": '#2a1d14'}]}}))
        comps.append(component(f'hub-{where}-{side}', f'Hub {where} {side}', 'micro', 'detail', 'cylinder', 'assembled-solid', 'Flat yellow hub cap disc on the wheel face.', cid,
          [0, 0, 0.046 if side == 'near' else -0.046], [round(36*PX, 4), 0.012, round(36*PX, 4)], 'hub-yellow', importance=0.6, confidence=0.8,
          attachment=attach('hub', [0, 0, 0.046 if side == 'near' else -0.046], [0, 0, 0.058 if side == 'near' else -0.058], round(18*PX, 4), round(18*PX, 4), contact='butt', embed=0.004), fidelity_tier='form-refinement', color_recipe=R(HUB, YEL)))
# ---- bumpers, grill, lights
comps.append(component('bumper-front', 'Front bumper', 'meso', 'trim', 'box', 'assembled-solid', 'Rigid orange bar across the lower front.', 'body',
  bl(497, 340, 0), [0.05, round(40*PX, 4), D], 'orange-trim', importance=0.7, confidence=0.85, attachment=embed('front', 0.01),
  edge={"type": "chamfer", "bevelRadius": 0.015, "segments": 2}, fidelity_tier='structural-pass', color_recipe=R(ORG, ORG)))
comps.append(component('grill', 'Grill', 'meso', 'trim', 'box', 'assembled-solid', 'Orange grill plate on the hood front face with three horizontal slats.', 'body',
  bl(490, 295, 0), [0.01, round(45*PX, 4), round(D*0.45, 4)], 'orange-trim', importance=0.7, confidence=0.8, attachment=embed('front', 0.005),
  fidelity_tier='structural-pass', color_recipe=R(ORG, ORG), local_features=[{"id": "slats", "kind": "ridge", "note": "three horizontal slats built as micro boxes"}]))
for i in range(3):
    comps.append(component(f'grill-slat-{i+1}', f'Grill slat {i+1}', 'micro', 'detail', 'box', 'surface-relief', 'Raised horizontal slat on the grill plate.', 'grill',
      [0.006, round((i-1)*0.028, 4), 0], [0.006, 0.012, round(D*0.4, 4)], 'dark-matte', importance=0.4, confidence=0.75, attachment=embed('front', 0.003), fidelity_tier='form-refinement', color_recipe=R(DARK, DARK)))
comps.append(component('headlight', 'Headlight', 'meso', 'lamp', 'ellipsoid', 'assembled-solid', 'Small glossy blue lamp on the hood front corner.', 'body',
  bl(488, 292, D*0.36), [0.03, 0.045, 0.045], 'headlight-glow', importance=0.6, confidence=0.8, attachment=embed('front', 0.01), fidelity_tier='structural-pass', color_recipe=R('#bfe8ff', WHITE, 'glass')))
comps.append(component('rear-light', 'Rear light', 'micro', 'lamp', 'box', 'assembled-solid', 'Small orange box light at the lower rear corner.', 'body',
  bl(19, 335, D*0.3), [0.024, round(30*PX, 4), 0.05], 'orange-trim', importance=0.4, confidence=0.75, attachment=embed('rear', 0.01), fidelity_tier='form-refinement', color_recipe=R(ORG, ORG)))
# ---- face on the cab window (material-only markings)
cab = next(c for c in comps if c['id'] == 'window-cab'); cabc = cab['transform']['position']
def facepart(cid, name, px, py, scale, mat, tier='form-refinement'):
    return component(cid, name, 'micro', 'detail', 'ellipsoid', 'material-only', 'Flat face marking on the cab window.', 'window-cab',
      [round(X(px)-cabc[0], 4), round(Y(py)-cabc[1], 4), 0.016], scale, mat, importance=0.6, confidence=0.85, attachment=embed('side', 0.004), fidelity_tier=tier)
comps += [facepart('eye-a', 'Eye (front)', 383, 190, [0.045, 0.05, 0.012], 'dark-matte'), facepart('eye-b', 'Eye (rear)', 337, 190, [0.045, 0.05, 0.012], 'dark-matte'),
          facepart('catchlight-a', 'Catchlight (front)', 389, 183, [0.016, 0.016, 0.012], 'catchlight'), facepart('catchlight-b', 'Catchlight (rear)', 343, 183, [0.016, 0.016, 0.012], 'catchlight'),
          facepart('cheek-a', 'Cheek (front)', 400, 215, [0.03, 0.02, 0.012], 'cheek-pink'), facepart('cheek-b', 'Cheek (rear)', 323, 215, [0.03, 0.02, 0.012], 'cheek-pink')]
smile = component('smile', 'Smile', 'micro', 'detail', 'tapered-sweep', 'material-only', 'Thin painted smile arc on the cab window, built as a tapered sweep so it stays crisp.', 'window-cab',
  [0, 0, 0.017], [1, 1, 1], 'dark-matte', importance=0.6, confidence=0.85, attachment=embed('side', 0.004), fidelity_tier='form-refinement',
  descriptor={"taperedSweep": {"stations": [{"position": [round(X(338)-cabc[0], 4), round(Y(212)-cabc[1], 4), 0], "rx": 0.0, "rz": 0.0, "twist": 0.0},
                                            {"position": [round(X(355)-cabc[0], 4), round(Y(224)-cabc[1], 4), 0], "rx": 0.006, "rz": 0.005, "twist": 0.0},
                                            {"position": [round(X(378)-cabc[0], 4), round(Y(224)-cabc[1], 4), 0], "rx": 0.006, "rz": 0.005, "twist": 0.0},
                                            {"position": [round(X(396)-cabc[0], 4), round(Y(212)-cabc[1], 4), 0], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 6, "capEnds": True}})
comps.append(smile)
ids = [c['id'] for c in comps]
passes = [
  {"id": "blockout", "goal": "Body box, hood, four wheels: the long yellow silhouette with two big wheels.", "componentRefs": ["root", "body", "wheel-rear-near", "wheel-front-near", "wheel-rear-far", "wheel-front-far"], "acceptance": ["length/height ~1.86", "wheels at -0.31 and 0.18, r 0.086", "hood lower than the roof"]},
  {"id": "structural-pass", "goal": "Windows, door, stripe, bumper, grill, headlight attached to the side and front faces.", "componentRefs": ids, "acceptance": ["no floating parts", "panes flush with the side"]},
  {"id": "form-refinement", "goal": "Hubs, grill slats, rear light, face marks, hood stripe; rounded roof corners.", "componentRefs": ids, "acceptance": ["face reads on the cab window", "hubs centred on wheels"]},
  {"id": "material-pass", "goal": "Satin yellow with a lighter roof band, glossy blue glass with streaks, matte rubber, orange trim.", "componentRefs": ids, "acceptance": ["glass glossier than paint", "palette within sampled stops"]},
  {"id": "surface-pass", "goal": "Chamfered body edges catch the key light; tyre shoulder rings; slats read as relief.", "componentRefs": ids, "acceptance": ["bevel highlight along the roof edge"]},
  {"id": "lighting-pass", "goal": "Declared key/fill/rim + exposure 1.25 + contact shadow.", "componentRefs": ["root"], "acceptance": ["no blown highlights on the yellow"]},
  {"id": "interaction-pass", "goal": "Wheels spin about z via their pivots; door hinges; sockets and colliders exposed.", "componentRefs": ids, "acceptance": ["wheel rotation test"]},
  {"id": "optimization-pass", "goal": "Stay under 30k triangles.", "componentRefs": ids, "acceptance": ["targetTriangles respected"]},
]
targets = [
  {"id": "overall-silhouette", "name": "Long yellow box with lower hood and two big wheels", "tier": "critical", "passIds": ["blockout", "structural-pass"], "minimumScore": 0.78, "mustPass": True, "componentRefs": ["body", "wheel-rear-near", "wheel-front-near"], "evidenceRefs": ["full-object"]},
  {"id": "primary-structure", "name": "Windows, open door, stripe, bumper and grill in their measured places", "tier": "critical", "passIds": ["structural-pass", "form-refinement"], "minimumScore": 0.75, "mustPass": True, "componentRefs": ["window-rear", "window-cab", "door-opening", "stripe-1", "bumper-front", "grill"], "evidenceRefs": ["full-object"]},
  {"id": "face-and-details", "name": "Smiling face on the cab window, hubs, headlight", "tier": "critical", "passIds": ["form-refinement", "material-pass"], "minimumScore": 0.72, "mustPass": True, "componentRefs": ["eye-a", "eye-b", "smile", "hub-front-near", "headlight"], "evidenceRefs": ["full-object"]},
  {"id": "reference-material-system", "name": "Yellow/orange/blue palette, glossy glass vs satin paint vs matte rubber", "tier": "important", "passIds": ["material-pass", "surface-pass", "lighting-pass"], "minimumScore": 0.7, "mustPass": False, "componentRefs": ["body", "window-rear", "wheel-rear-near"], "evidenceRefs": ["full-object"]},
]
spec = json.load(open('object-sculpt-spec.json'))
spec = apply_common(spec, components=comps, materials=mats, review_targets=targets, passes=passes,
  silhouette={"boundingShape": "long rounded box with a lower front hood and two discs below", "aspectRatios": ["length/height 2.06 incl. wheels", "body height/length 0.485"], "symmetry": "bilateral about the long axis",
              "dominantCurves": ["rounded roof corners", "wheel circles"], "negativeSpaces": ["between the wheels under the body"], "landmarks": ["roof y 0.53", "hood top y 0.30", "axle y 0.086 (wheels r 0.086 at x -0.31 / 0.18)", "stripe y 0.23-0.27"]},
  observations=["single side view, front to the right", "three-pane rear window, open door, cab window with face", "orange stripe, bumper, grill; blue headlight", "two visible wheels with yellow hubs"],
  repetition=[{"id": "wheels", "kind": "repeated-parts", "count": 4, "distribution": "two axles, both sides", "buildsGeometry": True, "instances": ["wheel-rear-near", "wheel-front-near", "wheel-rear-far", "wheel-front-far"]},
              {"id": "door-panes", "kind": "repeated-parts", "count": 4, "distribution": "two columns by two rows in the open door", "buildsGeometry": True, "instances": ["door-pane-1", "door-pane-2", "door-pane-3", "door-pane-4"]},
              {"id": "grill-slats", "kind": "repeated-parts", "count": 3, "distribution": "stacked on the grill", "buildsGeometry": True, "instances": ["grill-slat-1", "grill-slat-2", "grill-slat-3"]}],
  assumptions=["Bus width 0.42 of its length (side view only).", "Far side mirrors the near side (two hidden wheels, no door); the sticker draws the far wheels peeking out behind with a pseudo-perspective offset that a true side view cannot show.", "Roof top and underside are plain yellow / dark.", "Sticker white border and outer outline are 2D conventions and were stripped from the gate reference (refs/bus-clean.png)."],
  risks=["Thin panes and stripe are proud of the side by ~5 mm equivalent; check no z-fighting at the standard tier.", "Rounded roof corners come from a chamfer; the sticker's front roof curve is larger than a 0.06 bevel."],
  coordinate_frame={"front": "+X (the bus drives toward +x; the reference shows its +z side)", "up": "+Y", "scaleReference": "yellow body length = 1.0; ground at the wheel bottoms (y = 0)"},
  quality_depth={"macroComponents": 3, "mesoComponents": 7, "microFeatureGroups": 6, "materialLayers": 5, "repetitionSystems": 2, "reviewViewpoints": 4})
# detail inventory: 8 details mapped to real component / feature ids
details = [
  ("window-streaks", "gloss", "lighter diagonal highlight streaks on every glass pane", "streaks", [0.1, 0.3, 0.45, 0.2]),
  ("orange-stripe", "linework", "double painted orange line along the side", "stripe-1", [0.05, 0.5, 0.55, 0.05]),
  ("grill-slats", "ridge", "three horizontal slats on the orange grill", "slats", [0.9, 0.55, 0.06, 0.1]),
  ("headlight-gloss", "gloss", "small glossy blue lamp on the hood corner", "headlight", [0.93, 0.55, 0.03, 0.04]),
  ("hub-caps", "fastener", "yellow hub cap discs centred on both wheels", "hub-front-near", [0.25, 0.65, 0.5, 0.15]),
  ("rear-light", "decal", "small orange light at the lower rear corner", "rear-light", [0.01, 0.62, 0.04, 0.06]),
  ("face-decal", "decal", "eyes with catchlights, cheeks and a smile on the cab window", "eye-a", [0.62, 0.3, 0.2, 0.15]),
  ("tyre-shoulder", "ridge", "darker ring at the tyre shoulders", "tread-rim", [0.25, 0.65, 0.5, 0.15]),
]
inv = {"scanMethod": "grid-3x3", "targetMinDetails": 6, "details": [
  {"id": did, "kind": kind, "description": desc, "region": {"x": r[0], "y": r[1], "width": r[2], "height": r[3], "units": "normalized"}, "scale": "meso" if kind in ("linework", "decal") else "micro",
   "affects": ["albedo"] if kind in ("decal", "linework") else ["geometry"] if kind in ("ridge", "fastener") else ["roughness"], "evidenceRef": "full-object", "confidence": 0.85, "mapsTo": {"ref": ref}}
  for did, kind, desc, ref, r in details]}
spec['preSpecAssessment']['detailInventory'] = inv
spec['preSpecAssessment']['objectClass'] = {**spec['preSpecAssessment'].get('objectClass', {}), "primaryType": "toy school bus", "primaryDomain": "object", "confidence": 0.95,
  "formLanguage": ["geometric-rounded", "long chamfered box", "lower front hood", "disc wheels"], "structureKind": ["assembled", "body + hood + axles + surface panels"], "motionPotential": ["wheels spin about the axle", "door hinges at its rear edge", "whole vehicle translates"], "materialFamilies": ["painted plastic (satin)", "glass (glossy)", "rubber (matte)", "emissive lamp"]}
# surface-pass: declare the (small) surface relief the sticker implies
surface = {
  'body': {"macroRoughness": 0.45, "microRoughness": 0.03, "bumpAmplitude": 0.0, "normalPattern": "none (flat satin paint)", "displacementPattern": "none", "occlusionPattern": "contact darkening under the stripe, panes and wheel arches", "edgeWearPattern": "none", "notes": "chamfer-free extrude; edges read via shading only"},
  'wheel-rear-near': {"macroRoughness": 0.9, "microRoughness": 0.1, "bumpAmplitude": 0.004, "normalPattern": "tread rim ring (vertexPaint) around the tyre shoulder", "displacementPattern": "none", "occlusionPattern": "hub recess", "edgeWearPattern": "none", "notes": "matte rubber"},
  'wheel-front-near': {"macroRoughness": 0.9, "microRoughness": 0.1, "bumpAmplitude": 0.004, "normalPattern": "tread rim ring (vertexPaint) around the tyre shoulder", "displacementPattern": "none", "occlusionPattern": "hub recess", "edgeWearPattern": "none", "notes": "matte rubber"},
  'grill': {"macroRoughness": 0.55, "microRoughness": 0.05, "bumpAmplitude": 0.006, "normalPattern": "three raised slats (micro boxes)", "displacementPattern": "none", "occlusionPattern": "between slats", "edgeWearPattern": "none", "notes": "relief is real geometry"},
  'window-rear': {"macroRoughness": 0.1, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "none (glass)", "displacementPattern": "none", "occlusionPattern": "pane inset", "edgeWearPattern": "none", "notes": "diagonal highlight streaks are vertex paint"},
}
for c in comps:
    if c['id'] in surface: c['surfaceDetail'] = surface[c['id']]
for L in spec['lightingFromPhoto']:
    if L['id'] == 'fill':
        L.update(skyColor='#ffffff', groundColor='#e6e0d6', evidence='neutral warm-grey ground so the vertical yellow side is neither dimmed nor tinted (the mascot fill uses lavender)')
    if L['id'] == 'exposure':
        L.update(toneMapping='Neutral', exposure=1.35, evidence='ACES filmic desaturated the school-bus yellow to (188,171,88); Neutral keeps the hue, and exposure 1.35 brings the side face to the sampled value')
    if L['id'] == 'key':
        L.update(direction=[-0.35, 0.6, 1.0], intensity=1.5, evidence='the sticker is lit flat from the viewer side; a frontal upper-left key lights the vertical side face fully')
json.dump(spec, open('object-sculpt-spec.json', 'w'), indent=2)
a = json.load(open('assessment.json')); a['preSpecAssessment']['detailInventory'] = inv; a['preSpecAssessment']['unknownsToResolveBeforeImplementation'] = []; json.dump(a, open('assessment.json', 'w'), indent=2)
d = json.load(open('di.json')); d['detailInventory'] = inv; json.dump(d, open('di.json', 'w'), indent=2)
print('bus spec authored:', len(comps), 'components,', len(mats), 'materials')
