export function applyLaneOffset(points, offset, mergeLength = 40) {
  if (!Array.isArray(points) || points.length < 2 || !Number.isFinite(offset) || offset === 0) return points;
  const totalLength = points.slice(1).reduce((sum, point, index) => (
    sum + Math.hypot(point[0] - points[index][0], point[1] - points[index][1])
  ), 0);
  if (totalLength <= 0) return points;

  const transitionLength = Math.min(Math.max(0, Number(mergeLength) || 0), totalLength / 2);
  if (transitionLength <= 0) return points;
  const transitionSteps = 8;
  const boundaryValues = [];
  for (let step = 1; step <= transitionSteps; step += 1) {
    const progress = step / transitionSteps;
    boundaryValues.push(transitionLength * progress, totalLength - transitionLength * progress);
  }
  const boundaries = [...new Set(boundaryValues)]
    .filter((value) => value > 0 && value < totalLength)
    .sort((left, right) => left - right);
  const sampled = [{ point: points[0], distance: 0 }];
  let distance = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const segmentLength = Math.hypot(current[0] - previous[0], current[1] - previous[1]);
    if (segmentLength > 0) {
      for (const boundary of boundaries) {
        if (boundary <= distance || boundary >= distance + segmentLength) continue;
        const ratio = (boundary - distance) / segmentLength;
        sampled.push({
          point: [
            previous[0] + (current[0] - previous[0]) * ratio,
            previous[1] + (current[1] - previous[1]) * ratio,
          ],
          distance: boundary,
        });
      }
    }
    sampled.push({ point: current, distance: distance + segmentLength });
    distance += segmentLength;
  }

  return sampled.map((entry, index) => {
    const { point, distance: pathDistance } = entry;
    const fromStart = Math.min(1, pathDistance / transitionLength);
    const fromEnd = Math.min(1, (totalLength - pathDistance) / transitionLength);
    const progress = Math.max(0, Math.min(1, Math.min(fromStart, fromEnd)));
    const smooth = progress * progress * (3 - 2 * progress);
    const amount = offset * smooth;
    const before = sampled[Math.max(0, index - 1)].point;
    const after = sampled[Math.min(sampled.length - 1, index + 1)].point;
    const dx = after[0] - before[0];
    const dy = after[1] - before[1];
    const length = Math.hypot(dx, dy) || 1;
    return [point[0] - (dy / length) * amount, point[1] + (dx / length) * amount];
  });
}

export function assignOutputLanes(links, scale = 1, spacing = 6) {
  const groups = new Map();
  for (const item of links) {
    const key = `${String(item.originNode?.id ?? "")}:${String(item.originSlot ?? 0)}`;
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }
  const divisor = Math.max(0.05, Number(scale) || 1);
  for (const group of groups.values()) {
    group.forEach((item, index) => {
      item.laneOffset = group.length > 1 ? Math.min(index, 2) * spacing / divisor : 0;
    });
  }
  return links;
}

function segmentIntersection(a, b, c, d) {
  const abX = b[0] - a[0];
  const abY = b[1] - a[1];
  const cdX = d[0] - c[0];
  const cdY = d[1] - c[1];
  const denominator = abX * cdY - abY * cdX;
  if (Math.abs(denominator) < 1e-8) return null;
  const acX = c[0] - a[0];
  const acY = c[1] - a[1];
  const t = (acX * cdY - acY * cdX) / denominator;
  const u = (acX * abY - acY * abX) / denominator;
  if (t <= 0.015 || t >= 0.985 || u <= 0.015 || u >= 0.985) return null;
  return [a[0] + t * abX, a[1] + t * abY];
}

export function findPolylineIntersections(paths, maxSpots = 72, cellSize = 64) {
  const buckets = new Map();
  const candidatePairs = new Set();
  const segments = [];
  const size = Math.max(16, Number(cellSize) || 64);
  const maxCandidates = Math.max(2000, maxSpots * 160);

  paths.forEach((path, pathIndex) => {
    if (candidatePairs.size >= maxCandidates) return;
    for (let pointIndex = 1; pointIndex < path.points.length; pointIndex += 1) {
      const segmentIndex = segments.length;
      const segment = { pathIndex, pointIndex, a: path.points[pointIndex - 1], b: path.points[pointIndex] };
      segments.push(segment);
      const minX = Math.floor(Math.min(segment.a[0], segment.b[0]) / size);
      const maxX = Math.floor(Math.max(segment.a[0], segment.b[0]) / size);
      const minY = Math.floor(Math.min(segment.a[1], segment.b[1]) / size);
      const maxY = Math.floor(Math.max(segment.a[1], segment.b[1]) / size);
      for (let x = minX; x <= maxX; x += 1) {
        for (let y = minY; y <= maxY; y += 1) {
          const key = `${x},${y}`;
          const bucket = buckets.get(key) || [];
          for (const otherIndex of bucket) {
            if (candidatePairs.size >= maxCandidates) break;
            const other = segments[otherIndex];
            if (other.pathIndex === pathIndex) continue;
            const left = Math.min(other.pathIndex, pathIndex);
            const right = Math.max(other.pathIndex, pathIndex);
            candidatePairs.add(`${left}:${right}:${otherIndex}:${segmentIndex}`);
          }
          bucket.push(segmentIndex);
          buckets.set(key, bucket);
        }
        if (candidatePairs.size >= maxCandidates) break;
      }
      if (candidatePairs.size >= maxCandidates) break;
    }
  });

  const spots = [];
  const seen = new Set();
  let checked = 0;
  for (const key of candidatePairs) {
    if (checked++ >= maxCandidates || spots.length >= maxSpots) break;
    const [, , firstIndex, secondIndex] = key.split(":").map(Number);
    const first = segments[firstIndex];
    const second = segments[secondIndex];
    if (!first || !second) continue;
    const point = segmentIntersection(first.a, first.b, second.a, second.b);
    if (!point) continue;
    const quantized = `${Math.round(point[0] / 4)}:${Math.round(point[1] / 4)}`;
    if (seen.has(quantized)) continue;
    seen.add(quantized);
    spots.push(point);
  }
  return spots;
}
