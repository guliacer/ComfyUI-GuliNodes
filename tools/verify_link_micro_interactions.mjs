import assert from "node:assert/strict";
import { applyLaneOffset, assignOutputLanes, findPolylineIntersections } from "../web/gg-link-geometry.js";
import { nodeMicroOffsetY } from "../web/gg-micro-interaction.js";

const lanes = [0, 1, 2].map((id) => ({ originNode: { id: "source" }, originSlot: 0, id }));
assignOutputLanes(lanes, 2, 6);
assert.deepEqual(lanes.map((item) => item.laneOffset), [0, 3, 6]);

const lanePoints = applyLaneOffset([[0, 0], [100, 0]], 6, 40);
assert.deepEqual(lanePoints[0], [0, 0], "lane path must stay attached to the output port");
const splitPoint = lanePoints.find((point) => Math.abs(point[0] - 40) < 1e-8);
assert.ok(splitPoint, "lane path should insert an exact 40px split point");
assert.ok(Math.abs(splitPoint[1] - 6) < 1e-8, "lane offset should reach its spacing at the split point");
const mergePoint = lanePoints.find((point) => Math.abs(point[0] - 60) < 1e-8);
assert.ok(mergePoint, "lane path should insert the start of the target merge section");
assert.ok(Math.abs(mergePoint[1] - 6) < 1e-8, "lane offset should stay separated until the target merge section");
const taperPoint = lanePoints.find((point) => Math.abs(point[0] - 80) < 1e-8);
assert.ok(taperPoint && Math.abs(taperPoint[1] - 3) < 1e-8, "lane offset should taper smoothly toward the target");
assert.deepEqual(lanePoints.at(-1), [100, 0]);

const shortLanePoints = applyLaneOffset([[0, 0], [20, 0]], 6, 40);
assert.deepEqual(shortLanePoints[0], [0, 0]);
assert.deepEqual(shortLanePoints.at(-1), [20, 0]);
assert.ok(shortLanePoints.some((point) => Math.abs(point[0] - 10) < 1e-8 && Math.abs(point[1] - 6) < 1e-8),
  "short links should peak at the midpoint while staying attached at both ends");

const crossings = findPolylineIntersections([
  { points: [[0, 50], [100, 50]] },
  { points: [[50, 0], [50, 100]] },
]);
assert.equal(crossings.length, 1);
assert.ok(Math.abs(crossings[0][0] - 50) < 1e-8 && Math.abs(crossings[0][1] - 50) < 1e-8);

const node = { id: 1 };
assert.equal(nodeMicroOffsetY(node, { ds: { scale: 2 }, node_over: node }), -0.5);
assert.equal(nodeMicroOffsetY(node, { ds: { scale: 2 }, node_over: node, pointer_is_down: true }), 0.5);
assert.equal(nodeMicroOffsetY({ id: 2 }, { ds: { scale: 2 }, node_over: node }), 0);

console.log("LINK_MICRO_INTERACTIONS_OK");
