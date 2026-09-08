# Image analysis — WigglePlay bus (refs/bus.png, 512×512, side view, front to the right)

## Layer 1 — Identification
Cartoon school bus sticker with a face on the cab window; `primaryDomain: object` (vehicle prop with a decal face). Confidence 0.95. Single side/three-quarter-free orthographic-ish side view; white sticker border + dark outline (2D conventions).

## Layer 2 — Form & silhouette
Yellow body: x 23–489 px, y 135–361 px (466 × 226). Long rounded box; the rear two-thirds is taller (roof y 135) than the hood at the front-right (hood top y ≈ 240, x 431–489). Two wheels below the body: rear centre (175, 350) r ≈ 55, front centre (405, 350) r ≈ 58, bottoms at y ≈ 400. Bilateral symmetry about the bus's long axis (hidden far side assumed identical). Depth not observable; assumed 0.4 of length.

## Layer 3 — Macro → meso → micro
- Macro: `body` (rear box with rounded top corners), `hood` (lower front box), `wheel-rear`, `wheel-front` (+ hidden-side pair), `bumper-front`.
- Meso: `window-rear` (three panes x 51–226, y 154–250), `door` (recessed dark opening x 236–300, y 150–340 with a yellow frame and a pane), `window-cab` (x 312–417, y 154–250, carries the face), `grill` (front face, orange with slats), `headlight` (x 479–488, y 285–300), `stripe` (orange band y 255–275 from the rear to the door), `rear-light` (x 8–25, y 320–350), hubs (yellow discs r ≈ 25 px).
- Micro: window pane dividers, diagonal glass highlights (two lighter streaks per pane), grill slats ×3, eyes ×2 with white catchlights, cheeks ×2, smile arc, tyre tread rim.

## Layer 4 — Spatial relationships
`<hood, attached-to, body>` butt joint at x ≈ 431, flush bottoms; `<wheels, attached-to, body>` axle sockets under the body at y ≈ 350; `<windows, flush-with, body-side>` recessed panes; `<door, embedded-in, body-side>`; `<grill/headlight, flush-with, hood-front>`; `<stripe, flush-with, body-side>`; `<bumper-front, attached-to, hood>` at the lower front edge; `<face, decal-on, window-cab>`.

## Layer 5 — Materials
Body: opaque dielectric, satin (roughness ≈ 0.45), flat yellow with a slightly lighter roof band. Glass: glossy blue (roughness ≈ 0.1) with painted diagonal highlights. Tyres: matte dark brown (roughness 0.9). Hubs: yellow satin. Trim: matte orange. Door interior: matte near-black. Face marks: flat.

## Layer 6 — Colour
Body `#ffb400` (roof lighter `#ffc93c`), orange trim `#ff7a1a`, glass `#8fd4ff` with `#c9ecff` streaks, tyre `#3b2b1f`, hub `#ffc93c`, door interior `#221b17`, eyes `#1f1a17` + white, cheeks `#f28aa8`, outline `#1f1a17`.

## Layer 7 — Identity features
1. Long yellow box with a lower hood and rounded roof; 2. three-pane rear window + cab window with a smiling face; 3. open dark door in the middle; 4. orange side stripe and orange bumper/grill; 5. two big dark wheels with yellow hubs; 6. small blue headlight on the hood; 7. sticker outline (2D).

## Layer 8 — Uncertainty
Far side, roof top, underside, interior seats: hidden → mirrored/plain. Bus width: undetermined (assumed). Wheel count on the hidden side: assumed 2. Route: stylized object, no projection.
