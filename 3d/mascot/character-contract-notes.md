# Character contracts read (evidence)
Read in full: grimoire/character/reconstruction.md, grimoire/character/structure_decomposition.md,
grimoire/character/head_construction.md, grimoire/readiness/standard_character_pipeline.md.
Applied decisions for the mascot:
- Proportion system: chibi blob, HU = whole body (crown→base 385 px). Eye line 0.27 HU from crown, mouth 0.49, belly centre 0.75, arm roots 0.44, feet bottom 1.10 (feet extend below the body base).
- Layers: L0 core volume = body (single smooth ellipsoid, implicit/lathe), L1 deformable appendages = arms (capsules, own bone chain), L3 single-bone isolates = feet, hands (mitten+nubs), eyes (L2 inside a shallow socket void), L5 markings = cheeks, belly patch, mouth (vertex-region paint on the body mesh, hard/soft boundaries), no L6 VFX, L-Proxy colliders for body/arms/feet.
- Skeleton: root(pelvis at body centre) → spine → head(crown) ; root → shoulder-l → elbow-l → wrist-l (mirror r); root → hip-l → ankle-l (mirror r). Chirality: character's own left = +X, forward = +Z.
- Face: one continuous head/body volume; eyes as attached glossy spheres seated in shallow subtractive sockets; mouth and cheeks as surface regions, not floating primitives.
- Hair: none. Outfit: none.
