# Image analysis — WigglePlay cat (refs/cat-orange.png, 512×512, front view, sitting)

## Layer 1 — Identification
Cartoon orange tabby cat sticker, sitting and facing the camera; `primaryDomain: object` (toy character prop treated as a rigid-parts toy with node pivots rather than a skinned humanoid). Confidence 0.95. Single front view; white sticker border + dark outline (2D conventions, stripped in refs/cat-orange-clean.png).

## Layer 2 — Form & silhouette
Whole sticker x 26–487, y 12–499. Head: oversized dome x 42–383, y 13–260 (width 341, height ~215 without ears), cream muzzle/chin filling the lower half. Ears: triangles with tips at (82,18) and (344,18), bases ~x 66–165 / 265–361 at y ≈ 100. Body: plump blob x 35–390, y 262–485, widest at y ≈ 380. Front legs: vertical columns at x ≈ 74–118 and 313–352 from y 370 to the peach paws at y 459–482; cream hind paws at (133–181, 462–491) and (250–297, 462–491). Tail: from (378,452) curling up to a cream tip at (440–481, 350–400), radius ≈ 27 px. Bilateral symmetry except the tail.

## Layer 3 — Macro → meso → micro
- Macro: `body`, `head` (dense lathes squashed in z).
- Meso: `ear-l/r` (cones), `leg-l/r` (capsules), `tail-1/2/3` (chained sweeps).
- Micro: eyes (141,160) and (283,160) r ≈ 35 with two catchlights each; brows; nose (213,188); w-smile with open mouth (200–226, 210–235) and tongue; cheeks (110,215) (316,215); inner ears; 11 tabby stripes (forehead ×3 at x 176/213/252 y 54–113, head sides, shoulders, flanks, lower flanks); tail rings at (414,430) and (451,406); front and hind paws.

## Layer 4 — Spatial relationships
`<head, sits-on, body>` neck socket, head centre in front of the body plane; `<ears, rooted-in, head-dome>`; `<legs, in-front-of, body>` shoulder sockets; `<paws, under, legs>`; `<hind paws, under, belly>`; `<tail, from, body-lower-right>` slightly behind the body; `<face marks and stripes, decal-on, fur>`.

## Layer 5 — Materials
Fur: matte flat colour (roughness ≈ 0.85); eyes/nose: glossy dark brown; cheeks/inner ears/tongue flat pink; catchlights white.

## Layer 6 — Colour
Orange `#fd973d`, stripe `#b46532`, cream `#fff9db`, peach `#eabe9b`, cheek `#ff806f`, eye/nose/outline `#58271a`, tongue `#ff7688`.

## Layer 7 — Identity features
1. Huge round head with cream muzzle; 2. big glossy brown eyes with catchlights and an open w-smile; 3. pointy ears with pink insides; 4. three forehead stripes; 5. plump body with cream chest; 6. curled striped tail with cream tip; 7. sticker outline (2D).

## Layer 8 — Uncertainty
Depth of head/body assumed (0.6 / 0.56 of width). Hind legs folded into the body. Route: stylized object, no projection.
