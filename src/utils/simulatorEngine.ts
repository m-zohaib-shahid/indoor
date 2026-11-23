import { SimulatorBeacon, SimulatorNode, SimulatorEdge } from '../types/simulator';
import {
  FLOOR_WALL_SEGMENTS,
  USER_COLLISION_RADIUS,
  WallSegment,
  distPointToSegmentSq,
  doesSegmentCrossAnyWall,
  isPathSegmentClear,
} from './floorPhysics';

/**
 * Log-Distance Path Loss Model:
 * Generates realistic noisy RSSI based on distance from beacon:
 * RSSI = TxPower - 10 * n * log10(d) + GaussianNoise
 */
export function simulateRawRssi(
  distanceMeters: number,
  txPower: number = -59,
  pathLossN: number = 2.2,
  noiseSigma: number = 2.5
): number {
  const d = Math.max(0.1, distanceMeters);
  const meanRssi = txPower - 10 * pathLossN * Math.log10(d);
  // Box-Muller transform for Gaussian noise
  const u1 = Math.random() || 0.0001;
  const u2 = Math.random() || 0.0001;
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return meanRssi + z0 * noiseSigma;
}

/**
 * Inverts Log-Distance Path Loss Model to compute distance from smoothed RSSI:
 * d = 10 ^ ((TxPower - RSSI) / (10 * n))
 */
export function rssiToDistance(
  rssi: number,
  txPower: number = -59,
  pathLossN: number = 2.2
): number {
  const exponent = (txPower - rssi) / (10 * pathLossN);
  return Math.pow(10, exponent);
}

/**
 * 1D Kalman Filter update step
 */
export function updateKalman1D(
  state: { q: number; r: number; p: number; x: number },
  measurement: number
): { q: number; r: number; p: number; x: number; k: number } {
  // 1. Prediction
  const pPred = state.p + state.q;
  // 2. Kalman Gain
  const k = pPred / (pPred + state.r);
  // 3. Update state
  const xUpd = state.x + k * (measurement - state.x);
  // 4. Update error covariance
  const pUpd = (1.0 - k) * pPred;

  return {
    q: state.q,
    r: state.r,
    p: pUpd,
    x: xUpd,
    k,
  };
}

/**
 * Solves 2D Trilateration for 3 beacons using linear least-squares:
 * 2(x2 - x1)x + 2(y2 - y1)y = (r1^2 - r2^2) + (x2^2 - x1^2) + (y2^2 - y1^2)
 * 2(x3 - x1)x + 2(y3 - y1)y = (r1^2 - r3^2) + (x3^2 - x1^2) + (y3^2 - y1^2)
 */
export function solveTrilateration(
  beacons: SimulatorBeacon[]
): { x: number; y: number } | null {
  if (beacons.length < 3) return null;

  const b1 = beacons[0];
  const b2 = beacons[1];
  const b3 = beacons[2];

  const x1 = b1.x, y1 = b1.y, r1 = b1.estimatedDistance;
  const x2 = b2.x, y2 = b2.y, r2 = b2.estimatedDistance;
  const x3 = b3.x, y3 = b3.y, r3 = b3.estimatedDistance;

  const a11 = 2 * (x2 - x1);
  const a12 = 2 * (y2 - y1);
  const c1 = (r1 * r1 - r2 * r2) + (x2 * x2 - x1 * x1) + (y2 * y2 - y1 * y1);

  const a21 = 2 * (x3 - x1);
  const a22 = 2 * (y3 - y1);
  const c2 = (r1 * r1 - r3 * r3) + (x3 * x3 - x1 * x1) + (y3 * y3 - y1 * y1);

  const det = a11 * a22 - a12 * a21;
  if (Math.abs(det) < 1e-5) {
    // Collinear fallback: weighted centroid
    let totalW = 0, wx = 0, wy = 0;
    for (const b of beacons.slice(0, 3)) {
      const w = 1 / Math.max(0.1, b.estimatedDistance * b.estimatedDistance);
      wx += b.x * w;
      wy += b.y * w;
      totalW += w;
    }
    return totalW > 0 ? { x: wx / totalW, y: wy / totalW } : null;
  }

  const solvedX = (c1 * a22 - c2 * a12) / det;
  const solvedY = (a11 * c2 - a21 * c1) / det;

  return { x: solvedX, y: solvedY };
}

/**
 * A* (A-Star) Shortest Path Search on Building Graph
 */
export function runAStar(
  nodes: SimulatorNode[],
  edges: SimulatorEdge[],
  startId: string,
  targetId: string
): { pathNodeIds: string[]; totalDistance: number; pathCoordinates: { x: number; y: number }[] } | null {
  const nodeMap = new Map<string, SimulatorNode>();
  nodes.forEach(n => nodeMap.set(n.id, n));

  const start = nodeMap.get(startId);
  const target = nodeMap.get(targetId);
  if (!start || !target) return null;

  const adj = new Map<string, { to: string; weight: number }[]>();
  nodes.forEach(n => adj.set(n.id, []));

  edges.forEach(e => {
    adj.get(e.fromId)?.push({ to: e.toId, weight: e.weight });
    adj.get(e.toId)?.push({ to: e.fromId, weight: e.weight });
  });

  const dist = (a: SimulatorNode, b: SimulatorNode) => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const openSet = new Set<string>([startId]);
  const closedSet = new Set<string>();
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>();
  const fScore = new Map<string, number>();

  nodes.forEach(n => {
    gScore.set(n.id, Infinity);
    fScore.set(n.id, Infinity);
  });

  gScore.set(startId, 0);
  fScore.set(startId, dist(start, target));

  while (openSet.size > 0) {
    let currentId = '';
    let lowestF = Infinity;

    openSet.forEach(id => {
      const score = fScore.get(id) ?? Infinity;
      if (score < lowestF) {
        lowestF = score;
        currentId = id;
      }
    });

    if (currentId === targetId) {
      const pathNodeIds: string[] = [targetId];
      let curr = targetId;
      while (cameFrom.has(curr)) {
        curr = cameFrom.get(curr)!;
        pathNodeIds.unshift(curr);
      }
      return {
        pathNodeIds,
        totalDistance: gScore.get(targetId) || 0,
        pathCoordinates: pathNodeIds.map(id => {
          const n = nodeMap.get(id)!;
          return { x: n.x, y: n.y };
        }),
      };
    }

    openSet.delete(currentId);
    closedSet.add(currentId);

    const neighbors = adj.get(currentId) || [];

    for (const neighbor of neighbors) {
      if (closedSet.has(neighbor.to)) continue;

      const neighborNode = nodeMap.get(neighbor.to);
      if (!neighborNode) continue;

      const tentativeG = (gScore.get(currentId) ?? Infinity) + neighbor.weight;

      if (!openSet.has(neighbor.to)) {
        openSet.add(neighbor.to);
      } else if (tentativeG >= (gScore.get(neighbor.to) ?? Infinity)) {
        continue;
      }

      cameFrom.set(neighbor.to, currentId);
      gScore.set(neighbor.to, tentativeG);
      fScore.set(neighbor.to, tentativeG + dist(neighborNode, target));
    }
  }

  return null;
}

// ============================================================================
// WALL-AWARE CONTINUOUS NAVIGATION GRID + FUNNEL STRING-PULLING ENGINE
// ============================================================================

const NAV_GRID_MIN_X = 1.5;
const NAV_GRID_MIN_Y = 1.5;
const NAV_GRID_STEP = 0.5;
const NAV_GRID_COLS = 59; // x: 1.5 .. 30.5
const NAV_GRID_ROWS = 45; // y: 1.5 .. 23.5
const NAV_CELL_COUNT = NAV_GRID_COLS * NAV_GRID_ROWS;
const NAV_CLEARANCE = Math.max(USER_COLLISION_RADIUS, 0.45); // 0.45m keeps routes cleanly inside corridors/doors
const NAV_EDGE_CLEARANCE = 0.42;
const NAV_DIAGONAL_CLEARANCE = 1.05; // Diagonal shortcuts allowed only in open space away from door jambs

interface NavNeighbor {
  to: number;
  dir: number; // 0:W, 1:E, 2:N, 3:S
  cost: number;
}

interface NavGridData {
  walls: WallSegment[];
  cellX: Float64Array;
  cellY: Float64Array;
  walkable: Uint8Array;
  neighbors: NavNeighbor[][];
}

let cachedDefaultNavGrid: NavGridData | null = null;

function buildNavGrid(walls: WallSegment[]): NavGridData {
  const cellX = new Float64Array(NAV_CELL_COUNT);
  const cellY = new Float64Array(NAV_CELL_COUNT);
  const wallClearance = new Float64Array(NAV_CELL_COUNT);
  const walkable = new Uint8Array(NAV_CELL_COUNT);
  const neighbors: NavNeighbor[][] = Array.from({ length: NAV_CELL_COUNT }, () => []);

  for (let r = 0; r < NAV_GRID_ROWS; r++) {
    const y = NAV_GRID_MIN_Y + r * NAV_GRID_STEP;
    for (let c = 0; c < NAV_GRID_COLS; c++) {
      const x = NAV_GRID_MIN_X + c * NAV_GRID_STEP;
      const idx = r * NAV_GRID_COLS + c;
      cellX[idx] = x;
      cellY[idx] = y;
      const wDist = minDistanceToWalls(x, y, walls);
      wallClearance[idx] = wDist;
      if (wDist >= NAV_CLEARANCE) {
        walkable[idx] = 1;
      }
    }
  }

  // 4 cardinal architectural directions keep routes aligned to hallways and perpendicular through doorways
  const dirs = [
    [-1, 0, 0], // West
    [1, 0, 1],  // East
    [0, -1, 2], // North
    [0, 1, 3],  // South
  ];

  for (let r = 0; r < NAV_GRID_ROWS; r++) {
    for (let c = 0; c < NAV_GRID_COLS; c++) {
      const idx = r * NAV_GRID_COLS + c;
      if (!walkable[idx]) continue;
      const x1 = cellX[idx];
      const y1 = cellY[idx];

      for (const [dc, dr, dirId] of dirs) {
        const nc = c + dc;
        const nr = r + dr;
        if (nc < 0 || nc >= NAV_GRID_COLS || nr < 0 || nr >= NAV_GRID_ROWS) continue;
        const nIdx = nr * NAV_GRID_COLS + nc;
        if (!walkable[nIdx]) continue;

        const x2 = cellX[nIdx];
        const y2 = cellY[nIdx];
        if (isPathSegmentClear(x1, y1, x2, y2, walls, NAV_EDGE_CLEARANCE)) {
          const baseDist = Math.hypot(x2 - x1, y2 - y1);
          // Strong corridor/doorway centerline preference so routes walk cleanly down the middle
          const minAdjWall = Math.min(wallClearance[idx], wallClearance[nIdx]);
          const centerlinePenalty = minAdjWall < 1.25 ? (1.25 - minAdjWall) * 0.28 : 0;
          neighbors[idx].push({
            to: nIdx,
            dir: dirId,
            cost: baseDist * (1 + centerlinePenalty),
          });
        }
      }
    }
  }

  return { walls, cellX, cellY, walkable, neighbors };
}

function getNavGrid(walls: WallSegment[]): NavGridData {
  if (walls === FLOOR_WALL_SEGMENTS) {
    if (!cachedDefaultNavGrid) {
      cachedDefaultNavGrid = buildNavGrid(FLOOR_WALL_SEGMENTS);
    }
    return cachedDefaultNavGrid;
  }
  return buildNavGrid(walls);
}

function minDistanceToWalls(x: number, y: number, walls: WallSegment[]): number {
  let minSq = Infinity;
  for (const w of walls) {
    const dSq = distPointToSegmentSq(x, y, w.x1, w.y1, w.x2, w.y2);
    if (dSq < minSq) minSq = dSq;
  }
  return Math.sqrt(minSq);
}

function isEndpointSegmentSafe(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  walls: WallSegment[],
  endpointWallDist: number,
  isFromStartToInterior: boolean
): boolean {
  if (doesSegmentCrossAnyWall(ax, ay, bx, by, walls)) {
    return false;
  }

  const len = Math.hypot(bx - ax, by - ay);
  if (len < 1e-4) return true;

  // Allow endpoint to sit near a wall behind/beside it while keeping the interior span wall-clear
  const minEndClearance = Math.max(0.06, Math.min(NAV_EDGE_CLEARANCE, endpointWallDist * 0.85));
  if (!isPathSegmentClear(ax, ay, bx, by, walls, minEndClearance)) {
    return false;
  }

  if (len > 0.6) {
    const tStart = isFromStartToInterior ? Math.min(0.25, 0.25 / len) : 0;
    const tEnd = isFromStartToInterior ? 1 : Math.max(0.75, 1 - 0.25 / len);
    const sx = ax + (bx - ax) * tStart;
    const sy = ay + (by - ay) * tStart;
    const ex = ax + (bx - ax) * tEnd;
    const ey = ay + (by - ay) * tEnd;
    if (!isPathSegmentClear(sx, sy, ex, ey, walls, NAV_EDGE_CLEARANCE)) {
      return false;
    }
  }

  return true;
}

class MinHeap {
  private items: Array<{ id: number; f: number }> = [];

  get size(): number {
    return this.items.length;
  }

  push(id: number, f: number): void {
    this.items.push({ id, f });
    this.bubbleUp(this.items.length - 1);
  }

  pop(): { id: number; f: number } | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  private bubbleUp(idx: number): void {
    const node = this.items[idx];
    while (idx > 0) {
      const parentIdx = (idx - 1) >> 1;
      const parent = this.items[parentIdx];
      if (node.f >= parent.f) break;
      this.items[idx] = parent;
      idx = parentIdx;
    }
    this.items[idx] = node;
  }

  private sinkDown(idx: number): void {
    const len = this.items.length;
    while (true) {
      const leftIdx = idx * 2 + 1;
      const rightIdx = leftIdx + 1;
      let smallestIdx = idx;

      if (leftIdx < len && this.items[leftIdx].f < this.items[smallestIdx].f) {
        smallestIdx = leftIdx;
      }
      if (rightIdx < len && this.items[rightIdx].f < this.items[smallestIdx].f) {
        smallestIdx = rightIdx;
      }
      if (smallestIdx === idx) break;
      const tmp = this.items[idx];
      this.items[idx] = this.items[smallestIdx];
      this.items[smallestIdx] = tmp;
      idx = smallestIdx;
    }
  }
}

function collectVisibleAnchors(
  point: { x: number; y: number },
  grid: NavGridData,
  isStart: boolean
): Array<{ idx: number; dist: number }> {
  const endpointWallDist = minDistanceToWalls(point.x, point.y, grid.walls);
  const strictVisible: Array<{ idx: number; dist: number }> = [];
  const relaxedVisible: Array<{ idx: number; dist: number }> = [];

  const minC = Math.max(0, Math.floor((point.x - 4.0 - NAV_GRID_MIN_X) / NAV_GRID_STEP));
  const maxC = Math.min(NAV_GRID_COLS - 1, Math.ceil((point.x + 4.0 - NAV_GRID_MIN_X) / NAV_GRID_STEP));
  const minR = Math.max(0, Math.floor((point.y - 4.0 - NAV_GRID_MIN_Y) / NAV_GRID_STEP));
  const maxR = Math.min(NAV_GRID_ROWS - 1, Math.ceil((point.y + 4.0 - NAV_GRID_MIN_Y) / NAV_GRID_STEP));

  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      const idx = r * NAV_GRID_COLS + c;
      if (!grid.walkable[idx]) continue;
      const gx = grid.cellX[idx];
      const gy = grid.cellY[idx];
      const dist = Math.hypot(gx - point.x, gy - point.y);

      const ax = isStart ? point.x : gx;
      const ay = isStart ? point.y : gy;
      const bx = isStart ? gx : point.x;
      const by = isStart ? gy : point.y;

      if (isPathSegmentClear(ax, ay, bx, by, grid.walls, NAV_EDGE_CLEARANCE)) {
        strictVisible.push({ idx, dist });
      } else if (isEndpointSegmentSafe(ax, ay, bx, by, grid.walls, endpointWallDist, isStart)) {
        relaxedVisible.push({ idx, dist });
      }
    }
  }

  if (strictVisible.length > 0) {
    strictVisible.sort((a, b) => a.dist - b.dist);
    return strictVisible.slice(0, 8);
  }
  if (relaxedVisible.length > 0) {
    relaxedVisible.sort((a, b) => a.dist - b.dist);
    return relaxedVisible.slice(0, 8);
  }

  const fallback: Array<{ idx: number; dist: number }> = [];
  for (let idx = 0; idx < NAV_CELL_COUNT; idx++) {
    if (!grid.walkable[idx]) continue;
    const gx = grid.cellX[idx];
    const gy = grid.cellY[idx];
    if (!doesSegmentCrossAnyWall(point.x, point.y, gx, gy, grid.walls)) {
      fallback.push({ idx, dist: Math.hypot(gx - point.x, gy - point.y) });
    }
  }
  fallback.sort((a, b) => a.dist - b.dist);
  return fallback.slice(0, 8);
}

function smoothWaypointsWithStringPulling(
  rawPoints: Array<{ x: number; y: number }>,
  walls: WallSegment[]
): Array<{ x: number; y: number }> {
  if (rawPoints.length <= 2) return rawPoints;

  const startWallDist = minDistanceToWalls(rawPoints[0].x, rawPoints[0].y, walls);
  const endPt = rawPoints[rawPoints.length - 1];
  const endWallDist = minDistanceToWalls(endPt.x, endPt.y, walls);

  const canConnectCleanly = (i: number, j: number): boolean => {
    const a = rawPoints[i];
    const b = rawPoints[j];
    const isStart = i === 0;
    const isEnd = j === rawPoints.length - 1;
    const isOrthogonal = Math.abs(a.x - b.x) < 1e-4 || Math.abs(a.y - b.y) < 1e-4;

    if (!isStart && !isEnd) {
      // Straight corridor runs merge with normal 0.42m clearance; angled diagonals require wide open 1.05m space
      return isPathSegmentClear(
        a.x,
        a.y,
        b.x,
        b.y,
        walls,
        isOrthogonal ? NAV_EDGE_CLEARANCE : NAV_DIAGONAL_CLEARANCE
      );
    }

    if (doesSegmentCrossAnyWall(a.x, a.y, b.x, b.y, walls)) {
      return false;
    }

    if (isStart && isEnd) {
      return isPathSegmentClear(a.x, a.y, b.x, b.y, walls, NAV_EDGE_CLEARANCE);
    }

    // Keep entry/exit angled connections inside wide rooms rather than slanting across doorway posts
    if (!isOrthogonal && Math.hypot(b.x - a.x, b.y - a.y) > 1.0) {
      const tx1 = a.x + (b.x - a.x) * (isStart ? 0.15 : 0);
      const ty1 = a.y + (b.y - a.y) * (isStart ? 0.15 : 0);
      const tx2 = a.x + (b.x - a.x) * (isEnd ? 0.85 : 1);
      const ty2 = a.y + (b.y - a.y) * (isEnd ? 0.85 : 1);
      if (!isPathSegmentClear(tx1, ty1, tx2, ty2, walls, NAV_DIAGONAL_CLEARANCE)) {
        return false;
      }
    }

    if (isStart) {
      return isEndpointSegmentSafe(a.x, a.y, b.x, b.y, walls, startWallDist, true);
    }

    return isEndpointSegmentSafe(a.x, a.y, b.x, b.y, walls, endWallDist, false);
  };

  const smoothed: Array<{ x: number; y: number }> = [rawPoints[0]];
  let anchor = 0;
  const lastIdx = rawPoints.length - 1;

  while (anchor < lastIdx) {
    let furthest = anchor + 1;
    for (let probe = lastIdx; probe > anchor + 1; probe--) {
      if (canConnectCleanly(anchor, probe)) {
        furthest = probe;
        break;
      }
    }
    const nextPt = rawPoints[furthest];
    const prevPt = smoothed[smoothed.length - 1];
    if (Math.hypot(nextPt.x - prevPt.x, nextPt.y - prevPt.y) > 0.02 || furthest === lastIdx) {
      smoothed.push(nextPt);
    }
    anchor = furthest;
  }

  return smoothed;
}

/**
 * Computes a mathematically wall-free architectural path through real doorways and corridors
 * using direction-aware NavGrid A* (4-way corridor alignment) + open-space string-pulling.
 */
export function findWallFreePath(
  startPoint: { x: number; y: number },
  targetPoint: { x: number; y: number },
  walls: WallSegment[] = FLOOR_WALL_SEGMENTS
): { pathCoordinates: { x: number; y: number }[]; totalDistance: number } | null {
  const directDist = Math.hypot(targetPoint.x - startPoint.x, targetPoint.y - startPoint.y);
  if (directDist < 0.05) {
    return {
      pathCoordinates: [startPoint, targetPoint],
      totalDistance: directDist,
    };
  }

  // 1. Direct clear line-of-sight shortcut when cleanly unobstructed inside the same open space
  if (
    isPathSegmentClear(startPoint.x, startPoint.y, targetPoint.x, targetPoint.y, walls, 0.75) ||
    (!doesSegmentCrossAnyWall(startPoint.x, startPoint.y, targetPoint.x, targetPoint.y, walls) &&
      directDist <= 1.2)
  ) {
    return {
      pathCoordinates: [startPoint, targetPoint],
      totalDistance: directDist,
    };
  }

  const grid = getNavGrid(walls);
  const startAnchors = collectVisibleAnchors(startPoint, grid, true);
  const goalAnchors = collectVisibleAnchors(targetPoint, grid, false);

  if (startAnchors.length === 0 || goalAnchors.length === 0) {
    return null;
  }

  const goalExitCost = new Map<number, number>();
  for (const g of goalAnchors) {
    goalExitCost.set(g.idx, g.dist);
  }

  // State encoding: cellIdx * 5 + incomingDir (dir 4 = initial virtual start, 0..3 = W/E/N/S)
  const DIRS_PER_CELL = 5;
  const TOTAL_STATES = NAV_CELL_COUNT * DIRS_PER_CELL + 1;
  const VIRTUAL_GOAL = NAV_CELL_COUNT * DIRS_PER_CELL;
  const TURN_PENALTY = 0.25; // Penalize unnecessary 90-degree corridor stair-stepping

  const gScore = new Float64Array(TOTAL_STATES);
  gScore.fill(Infinity);
  const cameFrom = new Int32Array(TOTAL_STATES);
  cameFrom.fill(-1);
  const closed = new Uint8Array(TOTAL_STATES);
  const heap = new MinHeap();

  for (const s of startAnchors) {
    const stateId = s.idx * DIRS_PER_CELL + 4;
    if (s.dist < gScore[stateId]) {
      gScore[stateId] = s.dist;
      const h = Math.hypot(targetPoint.x - grid.cellX[s.idx], targetPoint.y - grid.cellY[s.idx]);
      heap.push(stateId, s.dist + h);
    }
  }

  let foundGoal = false;
  while (heap.size > 0) {
    const current = heap.pop()!;
    const stateId = current.id;
    if (closed[stateId]) continue;
    closed[stateId] = 1;

    if (stateId === VIRTUAL_GOAL) {
      foundGoal = true;
      break;
    }

    const u = Math.floor(stateId / DIRS_PER_CELL);
    const curDir = stateId % DIRS_PER_CELL;

    const exitDist = goalExitCost.get(u);
    if (exitDist !== undefined) {
      const tentativeGoalG = gScore[stateId] + exitDist;
      if (tentativeGoalG < gScore[VIRTUAL_GOAL]) {
        gScore[VIRTUAL_GOAL] = tentativeGoalG;
        cameFrom[VIRTUAL_GOAL] = stateId;
        heap.push(VIRTUAL_GOAL, tentativeGoalG);
      }
    }

    const uNeighbors = grid.neighbors[u];
    for (let i = 0; i < uNeighbors.length; i++) {
      const edge = uNeighbors[i];
      const nextState = edge.to * DIRS_PER_CELL + edge.dir;
      if (closed[nextState]) continue;

      const turnCost = curDir !== 4 && curDir !== edge.dir ? TURN_PENALTY : 0;
      const tentativeG = gScore[stateId] + edge.cost + turnCost;
      if (tentativeG < gScore[nextState]) {
        gScore[nextState] = tentativeG;
        cameFrom[nextState] = stateId;
        const h = Math.hypot(
          targetPoint.x - grid.cellX[edge.to],
          targetPoint.y - grid.cellY[edge.to]
        );
        heap.push(nextState, tentativeG + h);
      }
    }
  }

  if (!foundGoal || cameFrom[VIRTUAL_GOAL] === -1) {
    return null;
  }

  // Reconstruct raw grid waypoints
  const gridCells: Array<{ x: number; y: number }> = [];
  let curr = cameFrom[VIRTUAL_GOAL];
  while (curr !== -1) {
    const cellIdx = Math.floor(curr / DIRS_PER_CELL);
    gridCells.push({ x: grid.cellX[cellIdx], y: grid.cellY[cellIdx] });
    curr = cameFrom[curr];
  }
  gridCells.reverse();

  const rawPoints = [startPoint, ...gridCells, targetPoint];
  const smoothed = smoothWaypointsWithStringPulling(rawPoints, walls);

  let totalDistance = 0;
  for (let i = 0; i < smoothed.length - 1; i++) {
    totalDistance += Math.hypot(
      smoothed[i + 1].x - smoothed[i].x,
      smoothed[i + 1].y - smoothed[i].y
    );
  }

  return {
    pathCoordinates: smoothed,
    totalDistance,
  };
}

/**
 * Dynamic wall-aware A* pathfinding between arbitrary continuous coordinates (start and target)
 */
export function runAStarBetweenCoordinates(
  nodes: SimulatorNode[],
  _edges: SimulatorEdge[],
  startPoint: { x: number; y: number },
  targetPoint: { x: number; y: number }
): { pathCoordinates: { x: number; y: number }[]; totalDistance: number; pathNodeIds: string[] } | null {
  const result = findWallFreePath(startPoint, targetPoint, FLOOR_WALL_SEGMENTS);
  if (!result) {
    return null;
  }

  // Map smoothed waypoints to nearby landmark nodes for telemetry/label display
  const pathNodeIds: string[] = [];
  for (const pt of result.pathCoordinates) {
    let nearestId = '';
    let bestD = 3.5;
    for (const n of nodes) {
      const d = Math.hypot(n.x - pt.x, n.y - pt.y);
      if (d < bestD) {
        bestD = d;
        nearestId = n.id;
      }
    }
    if (nearestId && pathNodeIds[pathNodeIds.length - 1] !== nearestId) {
      pathNodeIds.push(nearestId);
    }
  }

  return {
    pathCoordinates: result.pathCoordinates,
    totalDistance: result.totalDistance,
    pathNodeIds,
  };
}
