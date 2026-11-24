export type LabelVisibilityMode = 'auto' | 'all' | 'minimal';

export interface LabelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SpatialMarkerItem {
  id: string;
  kind: 'live' | 'demo';
  name: string;
  subtitle: string;
  x: number;
  y: number;
  screenX: number;
  screenY: number;
  color: string;
  avatarUrl?: string;
  isTarget: boolean;
  isHovered: boolean;
  isLive: boolean;
}

export interface MarkerCluster {
  id: string;
  x: number;
  y: number;
  screenX: number;
  screenY: number;
  members: SpatialMarkerItem[];
}

export interface PlacedLabelResult {
  rect: LabelRect;
  needsConnector: boolean;
  anchorEdgeX: number;
  anchorEdgeY: number;
  labelEdgeX: number;
  labelEdgeY: number;
}

export function getShortPersonLabel(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Visitor';
  if (/^(dr|mr|mrs|ms|prof)\.?$/i.test(parts[0]) && parts.length >= 2) {
    return `${parts[0]} ${parts[1]}`;
  }
  return parts[0];
}

export function getPersonInitials(fullName: string): string {
  const cleaned = fullName
    .replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, '')
    .trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'U';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

/**
 * Smooth zoom-adaptive scaling factor for pins & avatars so zooming in
 * separates nearby pins cleanly without inflating bubbles.
 */
export function getAdaptivePinScale(cameraScale: number): number {
  const baseScale = 26;
  const clampedCam = Math.max(10, Math.min(72, cameraScale));
  if (clampedCam >= baseScale) {
    // Inverse-damped: slightly crisper/smaller screen footprint when zoomed far in
    return Math.max(0.78, Math.pow(baseScale / clampedCam, 0.22));
  }
  // Gently scale down when zoomed far out
  return Math.max(0.78, Math.pow(clampedCam / baseScale, 0.28));
}

export function rectsOverlap(a: LabelRect, b: LabelRect, pad = 5): boolean {
  return !(
    a.x + a.w + pad <= b.x ||
    b.x + b.w + pad <= a.x ||
    a.y + a.h + pad <= b.y ||
    b.y + b.h + pad <= a.y
  );
}

/**
 * Collision-aware placement with 8-direction search + radial ring fallback.
 * Returns exact connector hairline endpoints when a label flips or offsets away from its pin.
 */
export function placeCollisionAwareLabel(
  anchorX: number,
  anchorY: number,
  pinRadius: number,
  boxW: number,
  boxH: number,
  viewW: number,
  viewH: number,
  occupied: LabelRect[],
  preferredOrder: Array<'above' | 'below' | 'right' | 'left'> = ['above', 'below', 'right', 'left']
): PlacedLabelResult {
  const clampRect = (rx: number, ry: number): LabelRect => ({
    x: Math.max(8, Math.min(Math.max(8, viewW - boxW - 8), rx)),
    y: Math.max(8, Math.min(Math.max(8, viewH - boxH - 8), ry)),
    w: boxW,
    h: boxH,
  });

  const gap = 7;
  const makeCandidate = (
    dir: 'above' | 'below' | 'right' | 'left' | 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left',
    extraOffset = 0
  ): LabelRect => {
    const d = pinRadius + gap + extraOffset;
    switch (dir) {
      case 'above':
        return clampRect(anchorX - boxW / 2, anchorY - d - boxH);
      case 'below':
        return clampRect(anchorX - boxW / 2, anchorY + d);
      case 'right':
        return clampRect(anchorX + d, anchorY - boxH / 2);
      case 'left':
        return clampRect(anchorX - d - boxW, anchorY - boxH / 2);
      case 'top-right':
        return clampRect(anchorX + d * 0.72, anchorY - d * 0.72 - boxH);
      case 'top-left':
        return clampRect(anchorX - d * 0.72 - boxW, anchorY - d * 0.72 - boxH);
      case 'bottom-right':
        return clampRect(anchorX + d * 0.72, anchorY + d * 0.72);
      case 'bottom-left':
        return clampRect(anchorX - d * 0.72 - boxW, anchorY + d * 0.72);
    }
  };

  const primaryDirs: Array<
    'above' | 'below' | 'right' | 'left' | 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'
  > = [...preferredOrder, 'top-right', 'top-left', 'bottom-right', 'bottom-left'];

  let chosen: LabelRect | null = null;
  let chosenIndex = 0;

  for (let i = 0; i < primaryDirs.length; i++) {
    const cand = makeCandidate(primaryDirs[i], 0);
    if (!occupied.some((occ) => rectsOverlap(cand, occ))) {
      chosen = cand;
      chosenIndex = i;
      break;
    }
  }

  if (!chosen) {
    outer: for (let step = 1; step <= 4; step++) {
      const offset = step * (boxH + 4);
      for (const dir of preferredOrder) {
        const cand = makeCandidate(dir, offset);
        if (!occupied.some((occ) => rectsOverlap(cand, occ))) {
          chosen = cand;
          chosenIndex = 99;
          break outer;
        }
      }
    }
  }

  if (!chosen) {
    chosen = makeCandidate(preferredOrder[0], 0);
  }

  occupied.push(chosen);

  // Compute nearest point on label box to pin center for thin connector hairline
  const closestX = Math.max(chosen.x, Math.min(anchorX, chosen.x + chosen.w));
  const closestY = Math.max(chosen.y, Math.min(anchorY, chosen.y + chosen.h));
  const dx = closestX - anchorX;
  const dy = closestY - anchorY;
  const distToPinCenter = Math.hypot(dx, dy);
  const ux = distToPinCenter > 0.001 ? dx / distToPinCenter : 0;
  const uy = distToPinCenter > 0.001 ? dy / distToPinCenter : -1;

  // Draw subtle connector hairline when label flipped from primary direction or offset > 10px past pin
  const needsConnector = chosenIndex > 0 || distToPinCenter > pinRadius + 10;

  return {
    rect: chosen,
    needsConnector,
    anchorEdgeX: anchorX + ux * (pinRadius + 1.5),
    anchorEdgeY: anchorY + uy * (pinRadius + 1.5),
    labelEdgeX: closestX,
    labelEdgeY: closestY,
  };
}

/**
 * Proximity micro-clustering:
 * Groups 3 or more non-target users when they crowd within < 2.5m AND close screen distance.
 * Actively targeted users stay un-clustered so the user always sees their exact navigation pin.
 */
export function clusterCrowdedMarkers(
  markers: SpatialMarkerItem[],
  cameraScale: number
): {
  clusters: MarkerCluster[];
  singles: SpatialMarkerItem[];
} {
  const clusterable = markers.filter((m) => !m.isTarget);
  const forcedSingles = markers.filter((m) => m.isTarget);

  const visited = new Set<string>();
  const clusters: MarkerCluster[] = [];
  const singles: SpatialMarkerItem[] = [...forcedSingles];

  // Zoom-aware threshold: both within 2.5m world radius AND within 56px screen radius
  const worldThreshold = 2.5;
  const screenThreshold = Math.min(56, Math.max(30, worldThreshold * cameraScale));

  for (const seed of clusterable) {
    if (visited.has(seed.id)) continue;

    // BFS connected component of nearby markers
    const group: SpatialMarkerItem[] = [];
    const queue: SpatialMarkerItem[] = [seed];
    visited.add(seed.id);

    while (queue.length > 0) {
      const curr = queue.shift()!;
      group.push(curr);

      for (const cand of clusterable) {
        if (visited.has(cand.id)) continue;
        const worldDist = Math.hypot(cand.x - curr.x, cand.y - curr.y);
        const screenDist = Math.hypot(cand.screenX - curr.screenX, cand.screenY - curr.screenY);
        if (worldDist <= worldThreshold && screenDist <= screenThreshold) {
          visited.add(cand.id);
          queue.push(cand);
        }
      }
    }

    if (group.length >= 3) {
      const avgX = group.reduce((acc, m) => acc + m.x, 0) / group.length;
      const avgY = group.reduce((acc, m) => acc + m.y, 0) / group.length;
      const avgSX = group.reduce((acc, m) => acc + m.screenX, 0) / group.length;
      const avgSY = group.reduce((acc, m) => acc + m.screenY, 0) / group.length;

      clusters.push({
        id: `cluster_${group.map((m) => m.id).sort().join('_')}`,
        x: avgX,
        y: avgY,
        screenX: avgSX,
        screenY: avgSY,
        members: group.sort((a, b) => Number(b.isLive) - Number(a.isLive)),
      });
    } else {
      singles.push(...group);
    }
  }

  return { clusters, singles };
}
