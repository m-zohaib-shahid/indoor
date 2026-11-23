export interface WallSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface RoomRect {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  doors: Array<{
    side: 'top' | 'bottom' | 'left' | 'right';
    start: number; // relative offset along that edge in meters
    end: number;   // relative offset along that edge in meters
  }>;
}

export const USER_COLLISION_RADIUS = 0.34; // meters

export const FLOOR_ROOMS: RoomRect[] = [
  {
    id: 'room_101',
    name: 'Lab 101',
    x: 1,
    y: 1,
    w: 10,
    h: 8,
    doors: [
      { side: 'right', start: 3.5, end: 5.9 },  // East door into North Corridor (y: 4.5..6.9)
      { side: 'bottom', start: 6.8, end: 9.2 }, // South door into West Concourse (x: 7.8..10.2)
    ],
  },
  {
    id: 'room_102',
    name: 'Conference Room A',
    x: 21,
    y: 1,
    w: 10,
    h: 8,
    doors: [
      { side: 'left', start: 3.5, end: 5.9 },   // West door into North Corridor (y: 4.5..6.9)
      { side: 'bottom', start: 0.8, end: 3.2 }, // South door into East Concourse (x: 21.8..24.2)
    ],
  },
  {
    id: 'room_105',
    name: 'Server Hub',
    x: 13,
    y: 1,
    w: 6,
    h: 3.5,
    doors: [
      { side: 'bottom', start: 1.8, end: 4.2 }, // South door to North Corridor (x: 14.8..17.2)
    ],
  },
  {
    id: 'room_103',
    name: 'Cafeteria',
    x: 1,
    y: 16,
    w: 10,
    h: 8,
    doors: [
      { side: 'right', start: 2.8, end: 5.2 }, // East door to South Lobby (y: 18.8..21.2)
      { side: 'top', start: 6.8, end: 9.2 },   // North door to West Concourse (x: 7.8..10.2)
    ],
  },
  {
    id: 'room_104',
    name: 'Executive Suite',
    x: 21,
    y: 16,
    w: 10,
    h: 8,
    doors: [
      { side: 'left', start: 2.8, end: 5.2 }, // West door to South Lobby (y: 18.8..21.2)
      { side: 'top', start: 0.8, end: 3.2 },  // North door to East Concourse (x: 21.8..24.2)
    ],
  },
  {
    id: 'corr_center',
    name: 'Central Atrium',
    x: 13,
    y: 10,
    w: 6,
    h: 5,
    doors: [
      { side: 'top', start: 1.7, end: 4.3 },    // North archway (x: 14.7..17.3)
      { side: 'bottom', start: 1.7, end: 4.3 }, // South archway (x: 14.7..17.3)
      { side: 'left', start: 1.3, end: 3.7 },   // West archway (y: 11.3..13.7)
      { side: 'right', start: 1.3, end: 3.7 },  // East archway (y: 11.3..13.7)
    ],
  },
];

function splitEdgeWithDoors(
  length: number,
  doors: Array<{ start: number; end: number }>
): Array<[number, number]> {
  if (doors.length === 0) return [[0, length]];
  const sorted = [...doors].sort((a, b) => a.start - b.start);
  const segments: Array<[number, number]> = [];
  let cursor = 0;

  for (const door of sorted) {
    const dStart = Math.max(0, door.start);
    const dEnd = Math.min(length, door.end);
    if (dStart > cursor + 0.01) {
      segments.push([cursor, dStart]);
    }
    cursor = Math.max(cursor, dEnd);
  }
  if (cursor < length - 0.01) {
    segments.push([cursor, length]);
  }
  return segments;
}

export function buildWallSegments(rooms: RoomRect[] = FLOOR_ROOMS): WallSegment[] {
  const walls: WallSegment[] = [
    // Building outer perimeter walls (meters)
    { x1: 1.0, y1: 1.0, x2: 31.0, y2: 1.0 },
    { x1: 31.0, y1: 1.0, x2: 31.0, y2: 24.0 },
    { x1: 31.0, y1: 24.0, x2: 1.0, y2: 24.0 },
    { x1: 1.0, y1: 24.0, x2: 1.0, y2: 1.0 },
  ];

  for (const room of rooms) {
    const topDoors = room.doors.filter((d) => d.side === 'top');
    const bottomDoors = room.doors.filter((d) => d.side === 'bottom');
    const leftDoors = room.doors.filter((d) => d.side === 'left');
    const rightDoors = room.doors.filter((d) => d.side === 'right');

    for (const [s, e] of splitEdgeWithDoors(room.w, topDoors)) {
      walls.push({ x1: room.x + s, y1: room.y, x2: room.x + e, y2: room.y });
    }
    for (const [s, e] of splitEdgeWithDoors(room.w, bottomDoors)) {
      walls.push({ x1: room.x + s, y1: room.y + room.h, x2: room.x + e, y2: room.y + room.h });
    }
    for (const [s, e] of splitEdgeWithDoors(room.h, leftDoors)) {
      walls.push({ x1: room.x, y1: room.y + s, x2: room.x, y2: room.y + e });
    }
    for (const [s, e] of splitEdgeWithDoors(room.h, rightDoors)) {
      walls.push({ x1: room.x + room.w, y1: room.y + s, x2: room.x + room.w, y2: room.y + e });
    }
  }

  return walls;
}

export const FLOOR_WALL_SEGMENTS: WallSegment[] = buildWallSegments(FLOOR_ROOMS);

export function distPointToSegmentSq(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const wx = px - x1;
  const wy = py - y1;
  const lenSq = vx * vx + vy * vy;
  if (lenSq < 1e-8) {
    return wx * wx + wy * wy;
  }
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / lenSq));
  const cx = x1 + t * vx;
  const cy = y1 + t * vy;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy;
}

function ccw(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (cy - ay) * (bx - ax) - (by - ay) * (cx - ax);
}

function onSegmentBoundingBox(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  eps: number = 1e-6
): boolean {
  return (
    px >= Math.min(ax, bx) - eps &&
    px <= Math.max(ax, bx) + eps &&
    py >= Math.min(ay, by) - eps &&
    py <= Math.max(ay, by) + eps
  );
}

function segmentsIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number
): boolean {
  const eps = 1e-7;
  const d1 = ccw(cx, cy, dx, dy, ax, ay);
  const d2 = ccw(cx, cy, dx, dy, bx, by);
  const d3 = ccw(ax, ay, bx, by, cx, cy);
  const d4 = ccw(ax, ay, bx, by, dx, dy);

  if (
    ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
    ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))
  ) {
    return true;
  }

  // Handle collinear / endpoint-touching intersections safely
  if (Math.abs(d1) <= eps && onSegmentBoundingBox(ax, ay, cx, cy, dx, dy, eps)) return true;
  if (Math.abs(d2) <= eps && onSegmentBoundingBox(bx, by, cx, cy, dx, dy, eps)) return true;
  if (Math.abs(d3) <= eps && onSegmentBoundingBox(cx, cy, ax, ay, bx, by, eps)) return true;
  if (Math.abs(d4) <= eps && onSegmentBoundingBox(dx, dy, ax, ay, bx, by, eps)) return true;

  return false;
}

export function segmentToSegmentDistanceSq(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number
): number {
  if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) {
    return 0;
  }
  const d1 = distPointToSegmentSq(ax, ay, cx, cy, dx, dy);
  const d2 = distPointToSegmentSq(bx, by, cx, cy, dx, dy);
  const d3 = distPointToSegmentSq(cx, cy, ax, ay, bx, by);
  const d4 = distPointToSegmentSq(dx, dy, ax, ay, bx, by);
  return Math.min(d1, d2, d3, d4);
}

export function doesSegmentCrossAnyWall(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  walls: WallSegment[] = FLOOR_WALL_SEGMENTS
): boolean {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);

  for (const w of walls) {
    if (
      Math.max(w.x1, w.x2) < minX - 1e-5 ||
      Math.min(w.x1, w.x2) > maxX + 1e-5 ||
      Math.max(w.y1, w.y2) < minY - 1e-5 ||
      Math.min(w.y1, w.y2) > maxY + 1e-5
    ) {
      continue;
    }
    if (segmentsIntersect(x1, y1, x2, y2, w.x1, w.y1, w.x2, w.y2)) {
      return true;
    }
  }
  return false;
}

export function isPathSegmentClear(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  walls: WallSegment[] = FLOOR_WALL_SEGMENTS,
  clearance: number = 0.34
): boolean {
  const clearSq = clearance * clearance;
  const minX = Math.min(x1, x2) - clearance;
  const maxX = Math.max(x1, x2) + clearance;
  const minY = Math.min(y1, y2) - clearance;
  const maxY = Math.max(y1, y2) + clearance;

  for (const w of walls) {
    if (
      Math.max(w.x1, w.x2) < minX ||
      Math.min(w.x1, w.x2) > maxX ||
      Math.max(w.y1, w.y2) < minY ||
      Math.min(w.y1, w.y2) > maxY
    ) {
      continue;
    }
    if (segmentToSegmentDistanceSq(x1, y1, x2, y2, w.x1, w.y1, w.x2, w.y2) < clearSq) {
      return false;
    }
  }
  return true;
}

function isMoveClear(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  walls: WallSegment[],
  radius: number
): boolean {
  const rSq = radius * radius;
  for (const w of walls) {
    if (segmentsIntersect(fromX, fromY, toX, toY, w.x1, w.y1, w.x2, w.y2)) {
      return false;
    }
    if (distPointToSegmentSq(toX, toY, w.x1, w.y1, w.x2, w.y2) < rSq) {
      return false;
    }
  }
  return true;
}

/**
 * Resolves movement from (fromX, fromY) by (dx, dy) against building walls with smooth wall-sliding.
 * Guarantees the user dot never tunnels through solid room walls and slides cleanly along corridors/doorways.
 */
export function resolveWallCollision(
  fromX: number,
  fromY: number,
  dx: number,
  dy: number,
  walls: WallSegment[] = FLOOR_WALL_SEGMENTS,
  radius: number = USER_COLLISION_RADIUS
): { x: number; y: number; hitWall: boolean } {
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-5) {
    return { x: fromX, y: fromY, hitWall: false };
  }

  // Sub-step into <= 0.14m increments so even large steps cannot tunnel across thin walls
  const steps = Math.max(1, Math.ceil(dist / 0.14));
  const stepDx = dx / steps;
  const stepDy = dy / steps;

  let curX = fromX;
  let curY = fromY;
  let hitWall = false;

  for (let i = 0; i < steps; i++) {
    const nextX = Math.max(1.36, Math.min(30.64, curX + stepDx));
    const nextY = Math.max(1.36, Math.min(23.64, curY + stepDy));

    if (isMoveClear(curX, curY, nextX, nextY, walls, radius)) {
      curX = nextX;
      curY = nextY;
    } else {
      hitWall = true;
      // Slide along X axis only
      if (Math.abs(stepDx) > 1e-4 && isMoveClear(curX, curY, nextX, curY, walls, radius)) {
        curX = nextX;
      } else if (Math.abs(stepDy) > 1e-4 && isMoveClear(curX, curY, curX, nextY, walls, radius)) {
        // Slide along Y axis only
        curY = nextY;
      } else {
        break;
      }
    }
  }

  return {
    x: Number(curX.toFixed(2)),
    y: Number(curY.toFixed(2)),
    hitWall,
  };
}

/**
 * Shortest-angle circular low-pass smoothing for compass heading (degrees 0..360).
 */
export function smoothHeadingDegrees(
  prevHeading: number | null,
  rawHeading: number,
  alpha: number = 0.45
): number {
  const normalized = ((rawHeading % 360) + 360) % 360;
  if (prevHeading === null) return normalized;
  let delta = normalized - prevHeading;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return (((prevHeading + alpha * delta) % 360) + 360) % 360;
}

export interface MotionSampleInput {
  ax: number;
  ay: number;
  az: number;
  /** Linear acceleration excluding gravity when supported by the device */
  linAx?: number | null;
  linAy?: number | null;
  linAz?: number | null;
  /** Wrist/device rotation rate in deg/sec */
  rotAlpha?: number | null;
  rotBeta?: number | null;
  rotGamma?: number | null;
  timestampMs: number;
}

export interface StepDetectionResult {
  stepDetected: boolean;
  shakeRejected: boolean;
  stepLengthMeters: number;
}

/**
 * Anti-Shake Biphasic Gait Step Detector:
 * - Separates sitting wrist/hand-shakes from genuine walking strides using:
 *   1. Gyro rotational shake gate (>125 deg/s triggers shake lockout)
 *   2. Vertical-axis dominance check when hardware linear acceleration is available
 *   3. High-frequency jitter lockout (>3.2 Hz reversals or violent impacts >7.5 m/s^2)
 *   4. Biphasic heel-strike peak -> unweighting valley verification (Weinberg stride estimation)
 */
export class AntiShakeStepDetector {
  private gravityMag = 9.81;
  private smoothAcc = 0;
  private peakAcc = 0;
  private peakTimeMs = 0;
  private inPeakPhase = false;

  private lastStepTimeMs = 0;
  private lastPeakTimeMs = 0;
  private rapidPeakCount = 0;
  private shakeLockoutUntilMs = 0;

  private readonly minStepIntervalMs = 400; // Max ~2.5 steps/sec (human walking)
  private readonly maxGyroDegPerSec = 125;  // Sitting wrist-shakes exceed this easily
  private readonly peakThreshold = 1.35;    // m/s^2 above gravity
  private readonly valleyThreshold = -0.82; // m/s^2 below gravity
  private readonly minPeakToValley = 2.45;  // Total stride amplitude

  public reset(): void {
    this.gravityMag = 9.81;
    this.smoothAcc = 0;
    this.peakAcc = 0;
    this.peakTimeMs = 0;
    this.inPeakPhase = false;
    this.lastStepTimeMs = 0;
    this.lastPeakTimeMs = 0;
    this.rapidPeakCount = 0;
    this.shakeLockoutUntilMs = 0;
  }

  public processSample(sample: MotionSampleInput): StepDetectionResult {
    const now = sample.timestampMs;
    const rawMag = Math.hypot(sample.ax, sample.ay, sample.az);
    if (rawMag < 0.5) {
      return { stepDetected: false, shakeRejected: false, stepLengthMeters: 0 };
    }

    // 1. Gyroscope wrist-shake gate (sitting and waving/shaking phone generates high angular velocity)
    const rotMag = Math.hypot(
      sample.rotAlpha ?? 0,
      sample.rotBeta ?? 0,
      sample.rotGamma ?? 0
    );
    if (rotMag > this.maxGyroDegPerSec) {
      this.shakeLockoutUntilMs = Math.max(this.shakeLockoutUntilMs, now + 750);
      this.inPeakPhase = false;
      this.peakAcc = 0;
      return { stepDetected: false, shakeRejected: true, stepLengthMeters: 0 };
    }

    // 2. Dynamic acceleration signal (prefer gravity-aligned vertical component when hardware provides it)
    let dynAcc: number;
    if (
      sample.linAx !== undefined &&
      sample.linAx !== null &&
      sample.linAy !== undefined &&
      sample.linAy !== null &&
      sample.linAz !== undefined &&
      sample.linAz !== null
    ) {
      const gx = sample.ax - sample.linAx;
      const gy = sample.ay - sample.linAy;
      const gz = sample.az - sample.linAz;
      const gLen = Math.hypot(gx, gy, gz);
      const linMag = Math.hypot(sample.linAx, sample.linAy, sample.linAz);

      if (gLen > 4.0) {
        // Projection along gravity vector (negative = upward bounce)
        const verticalBounce = -(
          (sample.linAx * gx + sample.linAy * gy + sample.linAz * gz) /
          gLen
        );
        // Reject pure horizontal lateral shakes (e.g. waving phone left/right while seated)
        if (linMag > 2.2 && Math.abs(verticalBounce) < linMag * 0.42) {
          this.inPeakPhase = false;
          return { stepDetected: false, shakeRejected: true, stepLengthMeters: 0 };
        }
        dynAcc = verticalBounce;
      } else {
        this.gravityMag = 0.92 * this.gravityMag + 0.08 * rawMag;
        dynAcc = rawMag - this.gravityMag;
      }
    } else {
      // Adaptive gravity tracker
      const alpha = Math.abs(rawMag - this.gravityMag) < 1.2 ? 0.12 : 0.04;
      this.gravityMag = (1 - alpha) * this.gravityMag + alpha * rawMag;
      dynAcc = rawMag - this.gravityMag;
    }

    // Fast low-latency EMA smoothing (keeps step response <20ms while cutting electrical noise)
    this.smoothAcc = 0.68 * dynAcc + 0.32 * this.smoothAcc;

    // Violent impact / furious hand-shake lockout
    if (Math.abs(this.smoothAcc) > 7.8) {
      this.shakeLockoutUntilMs = Math.max(this.shakeLockoutUntilMs, now + 900);
      this.inPeakPhase = false;
      this.peakAcc = 0;
      return { stepDetected: false, shakeRejected: true, stepLengthMeters: 0 };
    }

    if (now < this.shakeLockoutUntilMs) {
      this.inPeakPhase = false;
      return { stepDetected: false, shakeRejected: true, stepLengthMeters: 0 };
    }

    // 3. Biphasic Heel-Strike Peak -> Unweighting Valley Gait State Machine
    if (this.smoothAcc > this.peakThreshold) {
      if (!this.inPeakPhase) {
        // Detect rapid hand-shake frequency (>3.2 Hz)
        if (now - this.lastPeakTimeMs < 300) {
          this.rapidPeakCount += 1;
          if (this.rapidPeakCount >= 2) {
            this.shakeLockoutUntilMs = now + 900;
            this.rapidPeakCount = 0;
            this.inPeakPhase = false;
            return { stepDetected: false, shakeRejected: true, stepLengthMeters: 0 };
          }
        } else {
          this.rapidPeakCount = 0;
        }
        this.lastPeakTimeMs = now;
        this.inPeakPhase = true;
        this.peakAcc = this.smoothAcc;
        this.peakTimeMs = now;
      } else if (this.smoothAcc > this.peakAcc) {
        this.peakAcc = this.smoothAcc;
        this.peakTimeMs = now;
      }
    } else if (this.inPeakPhase) {
      const elapsedSincePeak = now - this.peakTimeMs;

      // Peak expired without a valid stride valley
      if (elapsedSincePeak > 520) {
        this.inPeakPhase = false;
        this.peakAcc = 0;
        return { stepDetected: false, shakeRejected: false, stepLengthMeters: 0 };
      }

      // Valid downward swing valley reached
      if (this.smoothAcc < this.valleyThreshold && elapsedSincePeak >= 95) {
        const amplitude = this.peakAcc - this.smoothAcc;
        this.inPeakPhase = false;
        const savedPeak = this.peakAcc;
        this.peakAcc = 0;

        if (
          amplitude >= this.minPeakToValley &&
          now - this.lastStepTimeMs >= this.minStepIntervalMs
        ) {
          this.lastStepTimeMs = now;
          // Weinberg stride length model bounded to realistic [0.55m, 0.85m]
          const weinberg = 0.44 * Math.pow(Math.max(1.0, savedPeak - this.smoothAcc), 0.25);
          const stepLen = Number(Math.max(0.55, Math.min(0.85, weinberg)).toFixed(2));
          return {
            stepDetected: true,
            shakeRejected: false,
            stepLengthMeters: stepLen,
          };
        }
      }
    }

    return { stepDetected: false, shakeRejected: false, stepLengthMeters: 0 };
  }
}
