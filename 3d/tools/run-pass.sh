#!/usr/bin/env bash
# Build one img2threejs pass for a model, capture the review batch and run every deterministic gate.
# Usage: 3d/tools/run-pass.sh <model-id> <pass-id> [factory-relative-path]
# Needs the WigglePlay dev server on http://localhost:5173.
set -u
MODEL=${1:?model id}; PASS=${2:?pass id}
W=/Users/atultiwari/Downloads/Projects/KidsProject/wiggleplay
S=/Users/atultiwari/Downloads/Projects/img2threejs
M=$W/3d/$MODEL
FACTORY=${3:-$(ls $W/src/models/$MODEL/create*Model.ts | head -1)}
case "$FACTORY" in /*) ;; *) FACTORY="$W/$FACTORY" ;; esac
REF=$W/3d/refs/$MODEL.png; [ -f $W/3d/refs/$MODEL-clean.png ] && REF=$W/3d/refs/$MODEL-clean.png
cd $S
echo "== strict validation"; python3 forge/stage2_spec/validate_sculpt_spec.py $M/object-sculpt-spec.json --strict-quality 2>&1 | tee $M/strict-validation.txt | tail -1
echo "== generate $PASS"; python3 forge/stage3_build/generate_threejs_factory.py $M/object-sculpt-spec.json --out $FACTORY --pass-id $PASS --force 2>&1 | tail -1
# Stamp the factory and wait until the dev server actually serves the new build (Vite's watcher can lag
# behind a 100 kB rewrite; capturing a stale module produced misleading gate numbers once).
STAMP="gen-$(date +%s)-$RANDOM"
printf '\nexport const GENERATED_STAMP = "%s";\n' "$STAMP" >> $FACTORY
cd $W && npx tsc -b 2>&1 | head -5
REL=${FACTORY#$W/}
for i in $(seq 1 30); do
  if curl -s "http://localhost:5173/$REL" | grep -q "$STAMP"; then echo "dev server serving $STAMP"; break; fi
  sleep 1
done
sleep 1
echo "== capture"
GROUND=0 node e2e/lab-capture.mjs $MODEL $M/renders match,right,rear,left,orbit-plus,orbit-minus,rear-quarter 2>&1 | grep -c captured
node e2e/lab-capture.mjs $MODEL $M/renders hero,head,head-quarter 2>&1 | grep -c captured
GROUND=0 UNLIT=1 node e2e/lab-capture.mjs $MODEL $M/renders match 2>&1 | grep -c captured
node e2e/lab-export-meshes.mjs $MODEL $M/meshes.json | tail -1
node e2e/lab-export-parts.mjs $MODEL $M/parts.json | tail -1
python3 - "$M" <<'PY'
import sys
from PIL import Image
M = sys.argv[1]
views = ['match','hero','right','rear','left','orbit-plus','orbit-minus','rear-quarter','head','head-quarter']
sheet = Image.new('RGB', (256*5, 256*2), 'white')
for i, v in enumerate(views): sheet.paste(Image.open(f'{M}/renders/{v}.png').convert('RGB').resize((256,256)), ((i%5)*256, (i//5)*256))
sheet.save(f'{M}/renders/_sheet.jpg', quality=85)
PY
cp $M/renders/match.png $M/render-$PASS-match.png; cp $M/renders/match-unlit.png $M/render-$PASS-unlit.png
cd $S
echo "== gates"
python3 forge/stage4_review/diagnose_render.py --reference $REF --render $M/renders/match.png --map-stripped-render $M/renders/match-unlit.png --spec $M/object-sculpt-spec.json --pass-id $PASS --in-place --json > $M/tier1-$PASS.json 2>&1
python3 -c "
import json,sys; raw=open('$M/tier1-$PASS.json').read(); d=json.loads(raw[raw.find('{'):]); c=d['checks']
print('TIER1', {'passed': d['passed'], 'iou': c['silhouetteIoU'], 'aspect': c['aspectRatioDelta'], 'scale': c['scaleDelta'], 'sym': c['bilateralSymmetryError'], 'maxDeltaE': c['colorDelta']['maxDeltaE']}, d.get('failures'))"
python3 forge/stage4_review/diagnose_render_multi_angle.py --reference $M/renders/match.png --orbit $M/renders/orbit-plus.png --orbit $M/renders/orbit-minus.png --orbit $M/renders/right.png --orbit $M/renders/rear.png --json > $M/multi-angle-$PASS.json
python3 -c "import json; d=json.load(open('$M/multi-angle-$PASS.json')); print('MULTI degenerate:', d['degenerate'], [round(a['ratio'],2) for a in d['angles']])"
python3 forge/stage4_review/turntable_gate.py --capture 0=$M/renders/match.png --capture 90=$M/renders/right.png --capture 180=$M/renders/rear.png --capture 270=$M/renders/left.png --json > $M/turntable-$PASS.json
python3 -c "import json; d=json.load(open('$M/turntable-$PASS.json')); print('TURNTABLE', {k:d[k] for k in ('covered','degenerate','holed','passed')})"
python3 forge/stage4_review/self_intersection.py $M/meshes.json --json > $M/self-intersection-$PASS.json; echo "SELF-INTERSECTION exit=$?"
python3 -c "import json; d=json.load(open('$M/self-intersection-$PASS.json')); print({k:d[k] for k in ('selfIntersecting','insideVertexCount','undecidedVertexCount','sampledVertexCount')}); print([(m['name'], m['insideVertexCount']) for m in d['meshes'] if m.get('insideVertexCount')])"
python3 forge/stage4_review/attachment_anchor.py $M/object-sculpt-spec.json --json > $M/attachment-$PASS.json; echo "ATTACHMENT exit=$?"
python3 forge/stage4_review/check_part_coverage.py --spec $M/object-sculpt-spec.json --manifest $M/parts.json --json $M/part-coverage-$PASS.json 2>&1 | tail -1
python3 -c "import json; c=json.load(open('$M/part-coverage-$PASS.json')); print('COVERAGE', c['result']); [print('  ', f.get('severity'), f.get('subject'), (f.get('detail') or '')[:120]) for f in c['findings'] if f.get('severity') in ('error','fail','warning','warn')]"
python3 forge/stage4_review/make_comparison_sheet.py --reference $REF --render $M/renders/match.png --out $M/cmp-$PASS.png --json > /dev/null && echo "sheet: $M/cmp-$PASS.png"
python3 forge/stage3_build/orchestrate_passes.py check $M/object-sculpt-spec.json --pass-id $PASS 2>&1 | tail -1
