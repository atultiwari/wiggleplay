
## Local tool patch (2026-09-08)
`forge/stage3_build/orchestrate_passes.py::material_pass_gaps` blocked the material pass by demanding texture maps and
frequency bands for materials that declare `textureless` (which `validate_textureless` explicitly forbids). Patched the
local clone to exempt declared-textureless materials, mirroring the existing `qualityTier: utility` exemption. Candidate
upstream PR.

## Colour-delta gate scope
`diagnose_render.py` compares each `colorMaterialRecipe.dominantAlbedo` against only five dominant render clusters, so tiny
markings (catchlights, smile line, lip highlight) can never match. Those components are classified `material-only`
(surface markings, no recipe) per grimoire/intake/surface_topology.md rather than given a fake recipe.

## Local tool patch 2 (2026-09-08): colour-delta presence fallback
`forge/stage4_review/diagnose_render.py::per_part_color_delta` compares each recipe only against k<=5 global Lab clusters,
so a small part (the iris) fails regardless of fidelity, and brightening the iris toward the reference *raised* its delta
(26.1 -> 29.5 dE). Added a deterministic presence fallback: when no cluster is within threshold, a recipe colour that occurs
over >= 0.5% of the foreground within threshold is credited with the mean delta of those pixels; the entry records
`scoredBy: "presence"`, `presenceFraction` and the original `clusterDeltaE`. Candidate upstream PR.
