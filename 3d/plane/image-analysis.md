# Image analysis — WigglePlay plane (refs/plane.png, 512×512, side view, nose to the left, slightly from below)

## Layer 1 — Identification
Cartoon passenger jet sticker with a face on the nose; `primaryDomain: object` (vehicle prop with a decal face). Confidence 0.95. Single stylized side view with a mild "from below" cheat: the near wing sweeps down-right toward the viewer, the far wing is drawn peeking out beside the nose, a far tailplane peeks above the rear fuselage. White sticker border + dark outline (2D conventions, stripped in refs/plane-clean.png).

## Layer 2 — Form & silhouette
Whole sticker x 12–500, y 94–418. Fuselage: chubby tapered body from the nose tip (13, 312) to the tail cone (~455, 245); top edge y ≈ 158 at x 192, belly y ≈ 387 at x 150; height/length ≈ 0.51. The axis tilts ~8° (tail higher than nose). Fin: swept vertical stabiliser rising from the rear fuselage (x 352–460, y 94–200) with a red + blue trailing-edge stripe that continues down the rear fuselage to the wing. Near wing: fat lens from the fuselage side (235, 320) to the tip (445, 395), ~90 px thick in projection. Near tailplane: small lens (412–499, 220–260). Engine pod under the near wing (262–350, 371–418) with a blue intake disc (267–294). Bilateral symmetry about the fuselage's vertical plane.

## Layer 3 — Macro → meso → micro
- Macro: `fuselage` (lathe), `wing-near`/`wing-far` (flat swept ellipsoids), `fin` (extruded swept polygon).
- Meso: `tailplane-near`/`tailplane-far`, `engine-near`/`engine-far` (capsule pods) with `intake-*` discs, blue belly + nose cap, red belly stripe (vertex paint), fin stripes (vertex paint).
- Micro: four blue portholes (234,265) (275,257) (313,249) (350,241) ~27×32 px; eyes (161,265) r≈21 and (82,243) r≈17 with white catchlights; eyebrows (172,231) and (89,211); cheeks (63,268) and (162,298); smile arc (94–127, 269–288); nose gloss dot (30,293).

## Layer 4 — Spatial relationships
`<wings, attached-to, fuselage>` mid-body sockets both sides with sweep-back and anhedral; `<fin, attached-to, fuselage-top>` at x 352–440; `<tailplanes, attached-to, tail-cone>`; `<engines, hung-under, wings>` at 40 % span; `<portholes/face, decal-on, fuselage-near-side>`; `<stripes, painted-on, fuselage/fin>`.

## Layer 5 — Materials
Fuselage and wings: opaque satin white plastic (roughness ≈ 0.4) with flat painted regions. Portholes / intake / eyes: glossy (roughness ≈ 0.15). Face marks flat.

## Layer 6 — Colour
White `#eff9ff`, belly/nose blue `#278bcd`, porthole/intake blue `#3eabdf`, red stripe `#f64240`, fin blue `#1f5fbf`, underside light-blue `#a9e6f5`, eyes `#111111` + white, cheeks `#f6a6c0`, outline `#1a1a1a`.

## Layer 7 — Identity features
1. Chubby white fuselage with a blue nose cap and belly; 2. red stripe along the belly line; 3. smiling face with two big eyes on the nose; 4. four blue portholes; 5. swept fin with red/blue stripe; 6. fat swept near wing with a blue-intake engine pod; 7. small tailplane; 8. sticker outline (2D).

## Layer 8 — Uncertainty
Far wing and far tailplane are drawn in a cheated perspective (beside the nose / above the tail) that a true side view cannot reproduce: they are modelled as mirrors of the near parts and the sticker's extra blobs are accepted as an IoU loss. Fuselage roundness assumed circular. Route: stylized object, no projection.
