#!/usr/bin/env bash
# Usage: 3d/tools/record-pass.sh <model> <pass> <next-pass|final> <fidelity> "<summary>" "<matched>" "<mismatches>" [features.json] [vision-notes]
# Records a `continue` review for the pass just rendered by run-pass.sh, syncs the pipeline and marks the checklist.
set -e
W=/Users/atultiwari/Downloads/Projects/KidsProject/wiggleplay; S=/Users/atultiwari/Downloads/Projects/img2threejs
MODEL=${1:?model}; PASS=${2:?pass}; NEXT=${3:?next pass}; FID=${4:?fidelity}; SUMMARY=${5:?summary}; MATCHED=${6:?matched}; MISMATCH=${7:?mismatches}
M=$W/3d/$MODEL; FEAT=${8:-$M/features-$PASS.json}; NOTES=${9:-"Agent vision on cmp-$PASS.png."}
case "$FEAT" in /*) ;; *) FEAT="$W/$FEAT" ;; esac
ST=$M/.img2threejs/state.json
cd $S
python3 forge/stage4_review/append_review.py $M/object-sculpt-spec.json --pass-id $PASS --fidelity $FID --action continue \
  --summary "$SUMMARY" --matched "$MATCHED" --mismatches "$MISMATCH" \
  --render-screenshot $M/render-$PASS-match.png --map-stripped-render $M/render-$PASS-unlit.png --comparison-image $M/cmp-$PASS.png \
  --ai-vision-score $FID --layer-scores-json "{\"silhouetteProportion\": $FID, \"componentStructure\": $FID, \"formDetail\": $FID, \"materialSurface\": $FID, \"lightingCamera\": $FID}" \
  --feature-reviews-json $FEAT --camera-view match --ai-vision-notes "$NOTES" --in-place 2>&1 | tail -1
python3 forge/stage3_build/orchestrate_passes.py sync $M/object-sculpt-spec.json --in-place 2>&1 | tail -1
for st in build-current-pass:renders/match.png render-capture:renders/_sheet.jpg review-contract-read:../mascot/review-contract-notes.md tier1-diagnostics:tier1-$PASS.json multi-angle-review:multi-angle-$PASS.json; do
  python3 forge/state.py mark ${st%%:*} --state $ST --evidence $M/${st##*:} > /dev/null 2>&1 || true; done
if [ "$NEXT" = final ]; then python3 forge/stage3_build/orchestrate_passes.py status $M/object-sculpt-spec.json 2>&1 | tail -3 > $M/pass-gate-check-$PASS.txt
else python3 forge/stage3_build/orchestrate_passes.py check $M/object-sculpt-spec.json --pass-id $NEXT 2>&1 | tail -1 > $M/pass-gate-check-$PASS.txt; fi
for st in pass-gate-check:pass-gate-check-$PASS.txt ai-review-recorded:object-sculpt-spec.json pipeline-sync:object-sculpt-spec.json; do
  python3 forge/state.py mark ${st%%:*} --state $ST --evidence $M/${st##*:} > /dev/null 2>&1 || true; done
cd $M && python3 $S/forge/next.py --state $ST object-sculpt-spec.json 2>&1 | grep -E "LOCAL_STATE|pending" | head -2
