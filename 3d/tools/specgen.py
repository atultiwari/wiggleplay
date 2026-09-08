"""Small helpers to author img2threejs ObjectSculptSpec components and materials concisely.

Extracted from the mascot authoring session; every field shape matches what
forge/stage2_spec/validate_sculpt_spec.py --strict-quality expects.
"""
from __future__ import annotations

import copy
from typing import Any


def rgba(hex_color: str, alpha: float = 1.0) -> str:
    h = hex_color.lstrip('#')
    return f"rgba({int(h[0:2], 16)}, {int(h[2:4], 16)}, {int(h[4:6], 16)}, {alpha})"


def recipe(hex_dominant: str, hex_secondary: str, material_class: str = 'plastic', notes: str = 'flat sticker colour',
           gradient: dict[str, Any] | None = None, confidence: float = 0.85) -> dict[str, Any]:
    out = {"dominantAlbedo": rgba(hex_dominant), "secondaryAlbedo": rgba(hex_secondary), "materialClass": material_class,
           "materialClassConfidence": confidence, "evidenceRefs": ["full-object"], "notes": notes}
    if gradient:
        out["colorGradient"] = gradient
    return out


def component(cid: str, name: str, level: str, role: str, primitive: str, topology: str, rationale: str, parent: str,
              position: list[float], scale: list[float], material: str, *, importance: float = 0.7, confidence: float = 0.8,
              attachment: dict[str, Any] | None = None, rotation: list[float] | None = None, sockets: list[dict[str, Any]] | None = None,
              collider: dict[str, Any] | None = None, descriptor: dict[str, Any] | None = None, local_features: list[dict[str, Any]] | None = None,
              color_recipe: dict[str, Any] | None = None, anim_role: str = 'static', pivot_mode: str = 'center', pivot_axis: list[float] | None = None,
              fidelity_tier: str = 'blockout', extra: dict[str, Any] | None = None, edge: dict[str, Any] | None = None) -> dict[str, Any]:
    c: dict[str, Any] = {
        "id": cid, "name": name, "level": level, "role": role, "importance": importance, "confidence": confidence,
        "primitive": primitive, "topologyClass": topology, "topologyRationale": rationale,
        "geometryDescriptor": {"topologyIntent": "stylized sticker prop part", "edgeTreatment": edge or {"type": "none", "bevelRadius": 0.0, "segments": 1},
                               "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"},
        "parent": parent, "attachment": attachment,
        "dimensions": {"width": scale[0], "height": scale[1], "depth": scale[2], "units": "relative", "confidence": confidence},
        "transform": {"position": list(position), "rotation": list(rotation or [0, 0, 0]), "scale": list(scale)},
        "actionProfile": {
            "animationRole": anim_role,
            "pivot": {"mode": pivot_mode, "localPosition": [0, 0, 0], "axis": pivot_axis or [0, 1, 0], "confidence": 0.8},
            "transformChannels": {"translate": True, "rotate": True, "scale": True, "bend": False, "twist": False, "detach": False, "visibility": True, "materialState": False},
            "sockets": sockets or [],
            "collider": collider or {"type": "box", "offset": [0, 0, 0], "scale": list(scale), "isTrigger": False, "notes": "primitive proxy"},
            "constraints": [],
            "destruction": {"breakable": False, "fractureGroup": cid, "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": material},
        },
        "material": material, "materialLayers": [material], "deformations": [], "joints": [], "seams": [],
        "localFeatures": local_features or [],
        "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""},
        "evidenceRefs": ["full-object"], "details": [], "fidelityTier": fidelity_tier,
    }
    if descriptor:
        c["geometryDescriptor"].update(descriptor)
    if color_recipe is not None:
        c["colorMaterialRecipe"] = color_recipe
    if extra:
        c.update(extra)
    return c


def attach(socket: str, start: list[float], end: list[float], base_r: float, end_r: float, contact: str = 'socket-joint', embed: float = 0.03) -> dict[str, Any]:
    return {"parentSocket": socket, "localStart": list(start), "localEnd": list(end), "contactType": contact,
            "baseRadius": base_r, "endRadius": end_r, "embedDepth": embed, "gapTolerance": 0.005, "evidenceRefs": ["full-object"]}


def embed(socket: str, depth: float = 0.02) -> dict[str, Any]:
    return {"parentSocket": socket, "contactType": "embed", "embedDepth": depth, "gapTolerance": 0.0, "evidenceRefs": ["full-object"]}


def material(mid: str, name: str, color: str, secondary: list[str], rough: float, *, variation: float = 0.0, overrides: list[dict[str, Any]] | None = None,
             notes: list[str] | None = None, extra: dict[str, Any] | None = None, evidence: str = 'flat airbrushed sticker fill; no grain, print or pores') -> dict[str, Any]:
    m: dict[str, Any] = {
        "id": mid, "name": name, "type": "physical", "shaderModel": "MeshPhysicalMaterial",
        "baseColor": color, "color": color,
        "albedo": {"dominant": color, "secondary": secondary, "samplingNotes": "sampled from the sticker; flat regions, no texture detail"},
        "colorVariation": {"palette": [color] + secondary, "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0},
        "roughness": {"base": rough, "variation": variation},
        "metalness": {"base": 0.0, "variation": 0.0},
        "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."},
        "wear": {"edgeWear": 0.0, "scratches": [], "chips": []},
        "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"},
        "localOverrides": overrides or [{"id": "flat", "region": "whole", "color": color, "note": "single flat colour region"}],
        "shaderNotes": notes or ["flat colour sticker material"],
        "notes": "sticker-derived flat material",
        "textureless": {"declared": True, "evidence": [evidence]},
    }
    if extra:
        m.update(extra)
    return m


def hidden_material() -> dict[str, Any]:
    return {"id": "hidden", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation",
            "baseColor": "#000000", "color": "#000000", "albedo": {"dominant": "#000000", "secondary": ["#000000"]},
            "colorVariation": {"palette": ["#000000", "#000000"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0},
            "roughness": {"base": 1.0, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0},
            "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": ""},
            "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"},
            "localOverrides": [], "shaderNotes": [], "notes": "invisible carrier", "opacity": {"base": 0.0}, "qualityTier": "utility",
            "textureless": {"declared": True, "evidence": ["invisible root carrier; never rendered"]}}


def root_component() -> dict[str, Any]:
    c = component('root', 'Root carrier', 'macro', 'root', 'box', 'material-only',
                  'Invisible root carrier with no visible geometry of its own.', None, [0, 0, 0], [0.001, 0.001, 0.001], 'hidden',
                  importance=0.1, confidence=1.0, sockets=[{"id": "ground", "localPosition": [0, 0, 0]}])
    c["parent"] = None
    return c


LIGHTING = [
    {"id": "key", "type": "directional", "direction": [-0.6, 0.9, 0.8], "intensity": 1.4, "color": "#ffffff", "castShadow": True, "evidence": "sticker highlights sit upper-left"},
    {"id": "fill", "type": "hemisphere", "skyColor": "#f4f0ff", "groundColor": "#6a4fb8", "intensity": 1.0, "evidence": "shadow side stays saturated, never black"},
    {"id": "rim", "type": "directional", "direction": [0.5, 0.4, -1.0], "intensity": 0.5, "color": "#e6d6ff", "evidence": "lighter edge along the top silhouette"},
    {"id": "exposure", "type": "renderer", "toneMapping": "ACESFilmic", "exposure": 1.25, "outputColorSpace": "srgb", "evidence": "saturated pastel palette must survive tone mapping; mid-tones matched at exposure 1.25 on the mascot"},
    {"id": "ground", "type": "contact-shadow", "contactShadow": "soft blurred disc under the object, opacity 0.35; ambient occlusion via material AO channel disabled (textureless)", "evidence": "sticker has no cast shadow; a soft contact shadow grounds the 3D prop"},
]


def apply_common(spec: dict[str, Any], *, components: list[dict[str, Any]], materials: list[dict[str, Any]], review_targets: list[dict[str, Any]],
                 passes: list[dict[str, Any]], silhouette: dict[str, Any], observations: list[str], repetition: list[dict[str, Any]],
                 assumptions: list[str], risks: list[str], target_triangles: int = 30000, coordinate_frame: dict[str, str] | None = None,
                 quality_depth: dict[str, int] | None = None, rig: dict[str, Any] | None = None) -> dict[str, Any]:
    spec = copy.deepcopy(spec)
    spec['componentTree'] = components
    spec['materials'] = materials
    spec['featureReviewTargets'] = review_targets
    spec['buildPasses'] = passes
    spec['sculptPipeline']['passOrder'] = [p['id'] for p in passes]
    spec['silhouette'] = silhouette
    spec['viewEvidence'] = [{"id": "full-object", "view": "primary", "imageRegion": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0, "units": "normalized"},
                             "observations": observations, "confidence": 0.85}]
    spec['lightingFromPhoto'] = copy.deepcopy(LIGHTING)
    spec['repetitionSystems'] = repetition
    spec['performanceBudget'] = {"qualityPriority": "reference-fidelity", "targetTriangles": target_triangles, "maxDrawCalls": 40, "textureSize": 0, "fpsTarget": 60,
                                 "optimizationPolicy": "Real-time prop inside a toddler web game."}
    spec['coordinateFrame'] = coordinate_frame or {"front": "+Z (camera-facing side of the reference)", "up": "+Y", "scaleReference": "longest visible dimension = 1.0"}
    spec['assumptions'] = assumptions
    spec['risks'] = risks
    spec['suitability'] = "conditional"
    spec['scores'] = {"object_isolation": 3, "silhouette_readability": 3, "depth_inference": 2, "primitive_decomposition": 3, "material_procedurality": 3, "occlusion_risk": 1, "interaction_fit": 3}
    spec['preSpecAssessment']['unknownsToResolveBeforeImplementation'] = []
    if quality_depth:
        spec['qualityContract']['minimumSpecDepth'] = quality_depth
    if rig is not None:
        spec['rig'] = rig
    return spec
