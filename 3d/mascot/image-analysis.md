# Image analysis — WigglePlay mascot (refs/mascot.png, 512×512, front view)

## Layer 1 — Identification
- Observed: a single cartoon creature, sticker-style, front-facing, thick dark outline stroke, flat white background.
- Classification: stylized **creature character** (chibi blob monster). `primaryDomain: character`, sub-class non-humanoid blob (no neck, no distinct head/torso split, stub limbs). Confidence 0.95.
- Not an object; not a humanoid. Style axis: chibi, ~1 head-unit tall (the head IS the body).

## Layer 2 — Overall form & silhouette
- Bounding volume: one tall ellipsoid/egg (crown rounded, bottom slightly flattened where feet emerge). Body extents ≈ x 90–420 px, y 45–430 px → W ≈ 330 px, H ≈ 385 px, H/W ≈ 1.17.
- Full silhouette incl. arms ≈ x 25–490, incl. feet y to ≈ 475.
- Symmetry: bilateral about x = 255. Shape language: organic, geometric-simple.
- Depth: not observable (inference: rotationally similar ellipsoid, depth ≈ 0.9 × width, confidence 0.6).

## Layer 3 — Macro → meso → micro
- Macro: `body` (egg ellipsoid), `arm-l`, `arm-r` (stub capsules raised up-and-outward ~50° above horizontal, root on upper-lateral body ≈ y 215 px), `foot-l`, `foot-r` (stub half-capsules under the body, splayed ~15° outward, bottoms ≈ y 470 px, centres x ≈ 190 / 320).
- Meso: `hand-l`/`hand-r` (mitten: palm blob + 3 short finger nubs pointing up/outward, span ≈ 60 px), `eye-l`/`eye-r` (large near-circular eyes, centres ≈ (185,150) and (330,150), radius ≈ 36 px; dark outline ring, blue iris fills the eye), `cheek-l`/`cheek-r` (flat ovals ≈ 60×34 px at (140,205)/(365,205)), `mouth` (wide closed smile arc from x ≈ 185 to 335, apex y ≈ 235, corners lifted; small light-blue lower-lip highlight below the arc), `belly-patch` (lighter oval on the lower front, centre ≈ (255,335), rx ≈ 100, ry ≈ 75).
- Micro: star catchlights (per eye: one 4-point star ≈ 20 px at upper-lateral, one small 4-point star ≈ 9 px at lower-medial), eyelid arc/upper outline thickening, outline stroke ≈ 6 px around every silhouette and around eyes/mouth (2D toon convention), soft airbrush rim-light on the crown.

## Layer 4 — Spatial relationships
- `<arm-l, attached-to, body>` embed at upper-lateral body (x ≈ 95, y ≈ 215), contact embed; mirror for arm-r.
- `<foot-l, attached-to, body>` embed under the lower body (x ≈ 190, y ≈ 430); mirror for foot-r.
- `<eye-l/r, embedded-in, body-front>` recessed flush on the upper front, at 0.27 of body height from the crown.
- `<cheek-l/r, flush-with, body-front>` surface marking lateral-below the eyes.
- `<mouth, flush-with, body-front>` midline, at 0.49 of body height.
- `<belly-patch, flush-with, body-front>` surface marking, lower front.
- No neck, tail, ears, hair or accessories observed.

## Layer 5 — Materials (PBR)
- Body: opaque dielectric, satin (roughness ≈ 0.5, metalness 0), no relief; soft vertical albedo gradient (see Layer 6); lighter rim toward the crown edges (inference: painted rim light, not a material change).
- Eyes: glossy (roughness ≈ 0.1) with a dark ring; iris radial gradient; catchlights are pure white (render as emissive/unlit white stars).
- Cheeks, belly, mouth highlight: flat surface markings with hard/soft boundaries, same roughness as body. Outline: 2D stroke, no material.

## Layer 6 — Colour & finish
- Body gradient stops (top→bottom, sampled): 0.0 `#c9a8ff` (light lavender), 0.35 `#b58cf0` (lavender, mid value), 0.7 `#a07ae8`, 1.0 `#8f6fe0` (violet). Cheek-adjacent zone slightly pinker `#d9a3f0`.
- Belly patch: `#f0a8dc` pink centre → `#c7b0f6` at the edge (soft boundary).
- Cheeks: `#f25f8f` vivid pink-red, mid value, flat.
- Iris: centre `#5fb4ff` → rim `#2160d6`; eye ring `#1c2a4d`; catchlights `#ffffff`.
- Mouth stroke `#1a1330`; lower-lip highlight `#8fd0ff`. Outline stroke `#1a1330`.
- Finish: matte-satin airbrush; eyes gloss.

## Layer 7 — Identity-defining features
1. Neck-less egg silhouette, taller than wide, flattened base.
2. Two oversized round glossy eyes with blue iris and 4-point star catchlights, set high and wide (interocular ≈ 145 px ≈ 0.44 W).
3. Vivid pink oval cheeks lateral-below the eyes.
4. Wide closed smile with lifted corners plus lower-lip highlight.
5. Lighter pink belly patch on the lower front.
6. Stub arms raised in a "hooray" pose with 3-nub mitten hands.
7. Stub feet under the body.
8. Lavender→violet vertical gradient body; dark toon outline (2D convention — optional in 3D).

## Layer 8 — Uncertainty / single-image limits
- Hidden: back and top-rear of body, underside of feet, rear of arms/hands. Inference: featureless continuation of the gradient.
- Undetermined: body depth; arm cross-section (assumed round); whether feet are separate parts or body extrusions (treated as attached half-capsules).
- The outline stroke and rim light are 2D rendering conventions, not geometry — flagged so they are not built as ridges.
- Route decision: stylized (no pixel projection); reference is a flat sticker, de-lighting/projection would not add likeness.
