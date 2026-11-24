import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Compass,
  Users,
  LogOut,
  Navigation,
  X,
  CheckCircle2,
  Clock,
  Smartphone,
  Search,
  MapPin,
  Plus,
  Minus,
  LocateFixed,
  Maximize2,
  ChevronUp,
  Play,
  Square,
  Activity,
  Bluetooth,
  Radio,
  Laptop,
  ChevronDown,
  Edit3,
  RefreshCw,
  Layers,
} from 'lucide-react';
import {
  BuildingPeer,
  LivePresenceUser,
  SimulatorBeacon,
  SimulatorNode,
  SimulatorEdge,
  UserPose,
} from '../types/simulator';
import {
  findWallFreePath,
  rssiToDistance,
  runAStarBetweenCoordinates,
  simulateRawRssi,
  solveTrilateration,
  updateKalman1D,
} from '../utils/simulatorEngine';
import {
  AntiShakeStepDetector,
  FLOOR_ROOMS,
  FLOOR_WALL_SEGMENTS,
  resolveWallCollision,
  smoothHeadingDegrees,
} from '../utils/floorPhysics';
import {
  detectDeviceType,
  getOrCreateTabSessionId,
  getSavedPresenceProfile,
  LiveFloorPresenceClient,
  pickAvatarColor,
  PresenceConnectionStatus,
  savePresenceProfile,
  SavedPresenceProfile,
} from '../services/presenceService';

interface CleanNavigationDashboardProps {
  currentUser: { name: string; role: string; email: string; avatarUrl?: string };
  onSignOut: () => void;
}

type DirectoryTab = 'people' | 'rooms';
type BleSupportState = 'checking' | 'available' | 'connected' | 'unsupported' | 'denied';

interface TelemetryBeaconSnapshot extends SimulatorBeacon {
  rawDistance: number;
}

interface MapCamera {
  scale: number; // pixels per meter
  panX: number;  // screen px offset of world origin (0,0)
  panY: number;
}

const WORLD_BOUNDS = {
  minX: 1.0,
  maxX: 31.0,
  minY: 1.0,
  maxY: 24.0,
  width: 30.0,
  height: 23.0,
  centerX: 16.0,
  centerY: 12.5,
};

const ROOM_CODES: Record<string, string> = {
  room_101: '101',
  room_102: '102',
  room_103: '103',
  room_104: '104',
  room_105: '105',
  corr_center: 'ATRIUM',
};

const BEACON_ANCHORS: Array<{ id: string; name: string; x: number; y: number }> = [
  { id: 'B1', name: 'NW Concourse', x: 11.2, y: 7.0 },
  { id: 'B2', name: 'NE Concourse', x: 20.8, y: 7.0 },
  { id: 'B3', name: 'SW Concourse', x: 11.2, y: 17.0 },
  { id: 'B4', name: 'SE Concourse', x: 20.8, y: 17.0 },
];

const SIMULATION_TARGETS: Array<{ kind: 'peer' | 'room'; id: string }> = [
  { kind: 'peer', id: 'peer_hassaan' },
  { kind: 'room', id: 'room_101' },
  { kind: 'peer', id: 'peer_marcus' },
  { kind: 'room', id: 'room_103' },
  { kind: 'room', id: 'room_105' },
];

const BLE_OPTIONAL_SERVICES = [
  'generic_access',
  'device_information',
  'battery_service',
  'heart_rate',
  '0000feaa-0000-1000-8000-00805f9b34fb',
  '0000fe9a-0000-1000-8000-00805f9b34fb',
];

type BleScanMode = 'beacons' | 'prefix' | 'all';

interface WebBluetoothGattCharacteristic {
  readValue: () => Promise<DataView>;
}

interface WebBluetoothGattService {
  getCharacteristic: (uuid: string | number) => Promise<WebBluetoothGattCharacteristic>;
}

interface WebBluetoothGattServer {
  connected: boolean;
  connect: () => Promise<WebBluetoothGattServer>;
  disconnect: () => void;
  getPrimaryService: (uuid: string | number) => Promise<WebBluetoothGattService>;
}

interface WebBluetoothDeviceLike {
  id: string;
  name?: string;
  gatt?: WebBluetoothGattServer;
  watchAdvertisements?: () => Promise<void>;
  addEventListener?: (type: string, listener: (ev: Event) => void) => void;
  removeEventListener?: (type: string, listener: (ev: Event) => void) => void;
}

interface WebBluetoothNavigatorLike {
  requestDevice: (opts: {
    acceptAllDevices?: boolean;
    filters?: Array<{ namePrefix?: string; services?: Array<string | number> }>;
    optionalServices?: Array<string | number>;
  }) => Promise<WebBluetoothDeviceLike>;
  getDevices?: () => Promise<WebBluetoothDeviceLike[]>;
}

interface PairedBleInfo {
  id: string;
  displayName: string;
  rawName: string;
  manufacturer: string | null;
  model: string | null;
  batteryPct: number | null;
  rssi: number | null;
  connected: boolean;
  lastUpdated: string;
}

function isCrypticBleName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (/^unknown(\s+or\s+unsupported)?\s+device/i.test(trimmed)) return true;
  if (/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(trimmed)) return true;
  if (/^[0-9a-f]{8,}$/i.test(trimmed)) return true;
  return false;
}

function formatCleanBleName(
  rawName?: string | null,
  meta?: { gapName?: string | null; manufacturer?: string | null; model?: string | null; id?: string }
): string {
  const cleanStr = (val?: string | null) =>
    (val ?? '')
      .replace(/[^\x20-\x7E]/g, ' ')
      .replace(/^LE[_-\s]+/i, '')
      .replace(/\s+/g, ' ')
      .trim();

  const gap = cleanStr(meta?.gapName);
  if (gap && !isCrypticBleName(gap)) return gap;

  const raw = cleanStr(rawName);
  if (raw && !isCrypticBleName(raw)) return raw;

  const mfg = cleanStr(meta?.manufacturer);
  const mdl = cleanStr(meta?.model);
  if (mfg && mdl) return `${mfg} ${mdl}`;
  if (mfg) return `${mfg} Beacon`;
  if (mdl) return mdl;

  const suffix = (meta?.id ?? '').replace(/[^a-zA-Z0-9]/g, '').slice(-4).toUpperCase();
  return suffix ? `BLE Beacon #${suffix}` : 'BLE Beacon';
}

function computeRemainingDistanceAlongPolyline(
  pose: { x: number; y: number },
  coords: Array<{ x: number; y: number }>
): number {
  if (coords.length < 2) return 0;

  let bestSegIdx = 0;
  let bestProjDistSq = Infinity;
  let bestT = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const ax = coords[i].x;
    const ay = coords[i].y;
    const bx = coords[i + 1].x;
    const by = coords[i + 1].y;
    const vx = bx - ax;
    const vy = by - ay;
    const lenSq = vx * vx + vy * vy;
    const t = lenSq > 1e-8 ? Math.max(0, Math.min(1, ((pose.x - ax) * vx + (pose.y - ay) * vy) / lenSq)) : 0;
    const px = ax + t * vx;
    const py = ay + t * vy;
    const dSq = (pose.x - px) * (pose.x - px) + (pose.y - py) * (pose.y - py);
    if (dSq < bestProjDistSq) {
      bestProjDistSq = dSq;
      bestSegIdx = i;
      bestT = t;
    }
  }

  const segStart = coords[bestSegIdx];
  const segEnd = coords[bestSegIdx + 1];
  const projX = segStart.x + bestT * (segEnd.x - segStart.x);
  const projY = segStart.y + bestT * (segEnd.y - segStart.y);

  let remaining = Math.hypot(segEnd.x - projX, segEnd.y - projY);
  for (let i = bestSegIdx + 1; i < coords.length - 1; i++) {
    remaining += Math.hypot(coords[i + 1].x - coords[i].x, coords[i + 1].y - coords[i].y);
  }
  return remaining;
}

function createInitialBeacons(poseX: number, poseY: number): TelemetryBeaconSnapshot[] {
  return BEACON_ANCHORS.map((anchor) => {
    const dist = Math.max(0.5, Math.hypot(anchor.x - poseX, anchor.y - poseY));
    const txPower = -59;
    const pathLossN = 2.2;
    const expectedRssi = Number((txPower - 10 * pathLossN * Math.log10(dist)).toFixed(1));
    return {
      id: anchor.id,
      name: anchor.name,
      x: anchor.x,
      y: anchor.y,
      floor: 1,
      txPower,
      pathLossN,
      currentRawRssi: expectedRssi,
      filteredRssi: expectedRssi,
      estimatedDistance: Number(dist.toFixed(2)),
      rawDistance: Number(dist.toFixed(2)),
      kalmanState: {
        q: 0.08,
        r: 2.4,
        p: 1.0,
        x: expectedRssi,
      },
    };
  });
}

interface LabelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function getShortPersonLabel(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Visitor';
  if (/^(dr|mr|mrs|ms|prof)\.?$/i.test(parts[0]) && parts.length >= 2) {
    return `${parts[0]} ${parts[1]}`;
  }
  return parts[0];
}

function rectsOverlap(a: LabelRect, b: LabelRect, pad = 4): boolean {
  return !(
    a.x + a.w + pad <= b.x ||
    b.x + b.w + pad <= a.x ||
    a.y + a.h + pad <= b.y ||
    b.y + b.h + pad <= a.y
  );
}

function placeNonOverlappingLabel(
  anchorX: number,
  anchorY: number,
  pinRadius: number,
  boxW: number,
  boxH: number,
  viewW: number,
  viewH: number,
  occupied: LabelRect[],
  preferredOrder: Array<'above' | 'below' | 'right' | 'left'> = ['above', 'below', 'right', 'left']
): LabelRect {
  const clampRect = (rx: number, ry: number): LabelRect => ({
    x: Math.max(8, Math.min(viewW - boxW - 8, rx)),
    y: Math.max(8, Math.min(viewH - boxH - 8, ry)),
    w: boxW,
    h: boxH,
  });

  const candidates: LabelRect[] = preferredOrder.map((dir) => {
    if (dir === 'above') {
      return clampRect(anchorX - boxW / 2, anchorY - pinRadius - boxH - 7);
    }
    if (dir === 'below') {
      return clampRect(anchorX - boxW / 2, anchorY + pinRadius + 7);
    }
    if (dir === 'right') {
      return clampRect(anchorX + pinRadius + 8, anchorY - boxH / 2);
    }
    return clampRect(anchorX - pinRadius - boxW - 8, anchorY - boxH / 2);
  });

  for (const cand of candidates) {
    if (!occupied.some((occ) => rectsOverlap(cand, occ))) {
      occupied.push(cand);
      return cand;
    }
  }

  const fallback = { ...candidates[0] };
  for (let step = 1; step <= 4; step++) {
    const shiftedUp = clampRect(fallback.x, fallback.y - step * (boxH + 4));
    if (!occupied.some((occ) => rectsOverlap(shiftedUp, occ))) {
      occupied.push(shiftedUp);
      return shiftedUp;
    }
    const shiftedDown = clampRect(fallback.x, anchorY + pinRadius + 7 + step * (boxH + 4));
    if (!occupied.some((occ) => rectsOverlap(shiftedDown, occ))) {
      occupied.push(shiftedDown);
      return shiftedDown;
    }
  }

  occupied.push(fallback);
  return fallback;
}

interface UserAvatarProps {
  src?: string;
  name: string;
  className?: string;
  style?: React.CSSProperties;
}

const UserAvatar: React.FC<UserAvatarProps> = ({ src, name, className = '', style }) => {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const validSrc = src && failedSrc !== src ? src : undefined;
  const initial = (name.trim()[0] || 'U').toUpperCase();

  if (validSrc) {
    return (
      <img
        src={validSrc}
        alt={name}
        referrerPolicy="no-referrer"
        onError={() => setFailedSrc(validSrc)}
        className={`${className} object-cover`}
        style={style}
      />
    );
  }

  return (
    <div className={`${className} flex items-center justify-center font-bold`} style={style}>
      {initial}
    </div>
  );
};

export const CleanNavigationDashboard: React.FC<CleanNavigationDashboardProps> = ({
  currentUser,
  onSignOut,
}) => {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const stepDetectorRef = useRef<AntiShakeStepDetector>(new AntiShakeStepDetector());
  const headingRef = useRef<number>(90);
  const rawHeadingRef = useRef<number | null>(null);
  const headingOffsetRef = useRef<number>(0);
  const lastHeadingSyncRef = useRef<number>(0);
  const wallHitUntilRef = useRef<number>(0);
  const sensorCleanupRef = useRef<(() => void) | null>(null);
  const shakeHintTimerRef = useRef<number | null>(null);

  // Viewport size, 2D/2.5D architectural tilt & interactive pan/zoom camera
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number }>({
    width: 960,
    height: 700,
  });
  const [camera, setCamera] = useState<MapCamera>({
    scale: 26,
    panX: 80,
    panY: 40,
  });
  const [is25DMode, setIs25DMode] = useState(false);
  const cameraRef = useRef<MapCamera>(camera);
  const cameraAnimRef = useRef<number | null>(null);
  const focusHighlightRef = useRef<{
    x: number;
    y: number;
    color: string;
    until: number;
  } | null>(null);
  const isManualCameraRef = useRef(false);

  useEffect(() => {
    cameraRef.current = camera;
  }, [camera]);

  // Pointer & Touch gesture tracking for smooth pan/pinch-zoom without breaking tap selection
  const pointerStateRef = useRef<{
    isDragging: boolean;
    movedPx: number;
    startX: number;
    startY: number;
    origPanX: number;
    origPanY: number;
    pinchDist: number | null;
    pinchMidX: number;
    pinchMidY: number;
    origScale: number;
  }>({
    isDragging: false,
    movedPx: 0,
    startX: 0,
    startY: 0,
    origPanX: 0,
    origPanY: 0,
    pinchDist: null,
    pinchMidX: 0,
    pinchMidY: 0,
    origScale: 26,
  });

  // Active Building Peers (Multi-User Network)
  const [peers, setPeers] = useState<BuildingPeer[]>([
    {
      id: 'peer_hassaan',
      fullName: 'Hassaan Tariq',
      email: 'hassaan@enterprise.io',
      role: 'Lead Architect',
      department: 'Executive Suite',
      x: 26.0,
      y: 20.0,
      floor: 1,
      isOnline: true,
      avatarColor: '#F59E0B',
      lastUpdated: 'Live',
    },
    {
      id: 'peer_sarah',
      fullName: 'Dr. Sarah Jenkins',
      email: 'sarah.j@enterprise.io',
      role: 'RF Engineer',
      department: 'Lab 101',
      x: 6.0,
      y: 5.0,
      floor: 1,
      isOnline: true,
      avatarColor: '#EC4899',
      lastUpdated: 'Live',
    },
    {
      id: 'peer_marcus',
      fullName: 'Marcus Vance',
      email: 'm.vance@enterprise.io',
      role: 'Director of Product',
      department: 'Conference Room A',
      x: 26.0,
      y: 5.0,
      floor: 1,
      isOnline: true,
      avatarColor: '#38BDF8',
      lastUpdated: 'Live',
    },
    {
      id: 'peer_elena',
      fullName: 'Elena Rostova',
      email: 'elena@enterprise.io',
      role: 'Operations Lead',
      department: 'Cafeteria',
      x: 6.0,
      y: 20.0,
      floor: 1,
      isOnline: true,
      avatarColor: '#10B981',
      lastUpdated: 'Live',
    },
  ]);

  const nodes: SimulatorNode[] = useMemo(
    () => [
      { id: 'room_101', label: 'Lab 101', x: 6.0, y: 5.0, floor: 1, type: 'room' },
      { id: 'room_102', label: 'Conference Room A', x: 26.0, y: 5.0, floor: 1, type: 'room' },
      { id: 'room_103', label: 'Cafeteria', x: 6.0, y: 20.0, floor: 1, type: 'room' },
      { id: 'room_104', label: 'Executive Suite', x: 26.0, y: 20.0, floor: 1, type: 'room' },
      { id: 'room_105', label: 'Server Hub', x: 16.0, y: 2.8, floor: 1, type: 'room' },
      { id: 'corr_center', label: 'Central Atrium', x: 16.0, y: 12.5, floor: 1, type: 'corridor' },
      { id: 'corr_north', label: 'North Corridor', x: 16.0, y: 7.2, floor: 1, type: 'corridor' },
      { id: 'corr_south', label: 'South Lobby', x: 16.0, y: 19.5, floor: 1, type: 'corridor' },
      { id: 'corr_west', label: 'West Concourse', x: 7.0, y: 12.5, floor: 1, type: 'corridor' },
      { id: 'corr_east', label: 'East Concourse', x: 25.0, y: 12.5, floor: 1, type: 'corridor' },
    ],
    []
  );

  const edges: SimulatorEdge[] = useMemo(
    () => [
      { fromId: 'corr_center', toId: 'corr_north', weight: 5.3 },
      { fromId: 'corr_center', toId: 'corr_south', weight: 7.0 },
      { fromId: 'corr_center', toId: 'corr_west', weight: 9.0 },
      { fromId: 'corr_center', toId: 'corr_east', weight: 9.0 },
      { fromId: 'corr_north', toId: 'room_101', weight: 10.2 },
      { fromId: 'corr_north', toId: 'room_102', weight: 10.2 },
      { fromId: 'corr_north', toId: 'room_105', weight: 4.4 },
      { fromId: 'corr_south', toId: 'room_103', weight: 10.0 },
      { fromId: 'corr_south', toId: 'room_104', weight: 10.0 },
      { fromId: 'corr_west', toId: 'room_101', weight: 7.5 },
      { fromId: 'corr_west', toId: 'room_103', weight: 7.5 },
      { fromId: 'corr_east', toId: 'room_102', weight: 7.5 },
      { fromId: 'corr_east', toId: 'room_104', weight: 7.5 },
    ],
    []
  );

  const roomDestinations = useMemo(
    () => nodes.filter((n) => n.type === 'room'),
    [nodes]
  );

  const [userPose, setUserPose] = useState<UserPose>({
    x: 16.0,
    y: 12.5,
    floor: 1,
    heading: 90,
    stepCount: 0,
    totalDistanceMeters: 0,
    accuracy: 1.0,
  });

  const [targetPeerId, setTargetPeerId] = useState<string | null>('peer_hassaan');
  const [targetRoomId, setTargetRoomId] = useState<string | null>(null);
  const [targetLiveUserId, setTargetLiveUserId] = useState<string | null>(null);

  // Live Multi-User Presence & Demo Bots Toggle state
  const deviceType = useMemo(() => detectDeviceType(), []);
  const localPresenceTabId = useMemo(() => getOrCreateTabSessionId(), []);
  const [presenceProfile, setPresenceProfile] = useState<SavedPresenceProfile | null>(() =>
    getSavedPresenceProfile()
  );
  const [joinNameInput, setJoinNameInput] = useState<string>(() => {
    const saved = getSavedPresenceProfile();
    if (saved?.name) return saved.name;
    const raw = currentUser.name.trim();
    return raw && raw.toLowerCase() !== 'navigator' ? raw : '';
  });
  const [isJoinPromptOpen, setIsJoinPromptOpen] = useState<boolean>(() => !getSavedPresenceProfile());
  const [liveUsers, setLiveUsers] = useState<LivePresenceUser[]>([]);
  const [presenceStatus, setPresenceStatus] = useState<PresenceConnectionStatus>('disconnected');
  const [isOnlineDropdownOpen, setIsOnlineDropdownOpen] = useState(false);
  const [showDemoBots, setShowDemoBots] = useState(true);
  const [isSpotPickerActive, setIsSpotPickerActive] = useState(false);
  const presenceClientRef = useRef<LiveFloorPresenceClient | null>(null);

  // Mobile Bottom Sheet Directory State (desktop uses always-visible left sidebar)
  const [isMobileSheetOpen, setIsMobileSheetOpen] = useState(false);
  const [directoryTab, setDirectoryTab] = useState<DirectoryTab>('people');
  const [directorySearch, setDirectorySearch] = useState('');

  // Motion sensors, Live Simulation & Telemetry HUD state
  const [motionSensorsActive, setMotionSensorsActive] = useState(false);
  const [sensorStatusMessage, setSensorStatusMessage] = useState<string>('Enable Motion');
  const [pulseAnim, setPulseAnim] = useState(0);

  const [isSimulating, setIsSimulating] = useState(false);
  const [isTelemetryOpen, setIsTelemetryOpen] = useState(false);
  const [bleState, setBleState] = useState<BleSupportState>('checking');
  const [bleDeviceName, setBleDeviceName] = useState<string | null>(null);
  const [bleSuggestionDismissed, setBleSuggestionDismissed] = useState(false);
  const [isBleModalOpen, setIsBleModalOpen] = useState(false);
  const [bleScanMode, setBleScanMode] = useState<BleScanMode>('beacons');
  const [bleNamePrefix, setBleNamePrefix] = useState('');
  const [bleBusy, setBleBusy] = useState(false);
  const [bleStatusNote, setBleStatusNote] = useState<string | null>(null);
  const [blePairedDevice, setBlePairedDevice] = useState<PairedBleInfo | null>(null);
  const [bleKnownDevices, setBleKnownDevices] = useState<PairedBleInfo[]>([]);
  const [bleCustomAlias, setBleCustomAlias] = useState('');
  const bleDeviceRef = useRef<WebBluetoothDeviceLike | null>(null);
  const bleAdvCleanupRef = useRef<(() => void) | null>(null);
  const motionSensorsActiveRef = useRef<boolean>(false);
  const [lockedRoute, setLockedRoute] = useState<{
    targetId: string;
    pathCoordinates: { x: number; y: number }[];
    totalDistance: number;
    pathNodeIds: string[];
  } | null>(null);

  const [beacons, setBeacons] = useState<TelemetryBeaconSnapshot[]>(() =>
    createInitialBeacons(16.0, 12.5)
  );
  const [rawTrilatPose, setRawTrilatPose] = useState<{ x: number; y: number } | null>(null);
  const [kalmanTrilatPose, setKalmanTrilatPose] = useState<{ x: number; y: number } | null>(null);
  const [rawJitterError, setRawJitterError] = useState<number>(0);
  const [kalmanError, setKalmanError] = useState<number>(0);

  const userPoseRef = useRef<UserPose>(userPose);
  const beaconsRef = useRef<TelemetryBeaconSnapshot[]>(beacons);
  const activeRouteRef = useRef<ReturnType<typeof runAStarBetweenCoordinates>>(null);
  const activeTargetRef = useRef<{
    id: string;
    name: string;
    subtext: string;
    coords: { x: number; y: number };
    isPeer: boolean;
  } | null>(null);
  const simRuntimeRef = useRef<{
    strideAccumMeters: number;
    dwellTicks: number;
    routeCycleIndex: number;
  }>({
    strideAccumMeters: 0,
    dwellTicks: 0,
    routeCycleIndex: 0,
  });

  useEffect(() => {
    userPoseRef.current = userPose;
    if (presenceClientRef.current) {
      presenceClientRef.current.updateLocalState({
        x: userPose.x,
        y: userPose.y,
      });
    }
  }, [userPose]);

  useEffect(() => {
    beaconsRef.current = beacons;
  }, [beacons]);

  const avatarImagesRef = useRef<Map<string, HTMLImageElement | 'loading' | 'error'>>(new Map());
  const [avatarLoadTick, setAvatarLoadTick] = useState(0);

  // Preload OAuth profile avatars (Google/GitHub) with no-referrer for crisp canvas rendering
  useEffect(() => {
    const urls: string[] = [];
    if (currentUser.avatarUrl) urls.push(currentUser.avatarUrl);
    liveUsers.forEach((lu) => {
      if (lu.avatarUrl) urls.push(lu.avatarUrl);
    });

    urls.forEach((url) => {
      if (avatarImagesRef.current.has(url)) return;
      avatarImagesRef.current.set(url, 'loading');
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      img.onload = () => {
        avatarImagesRef.current.set(url, img);
        setAvatarLoadTick((tick) => tick + 1);
      };
      img.onerror = () => {
        avatarImagesRef.current.set(url, 'error');
      };
      img.src = url;
    });
  }, [currentUser.avatarUrl, liveUsers]);

  // Connect & sync Live Multi-User Presence over InsForge Realtime channel 'live-indoor-users'
  useEffect(() => {
    if (!presenceProfile) return;

    const client = new LiveFloorPresenceClient({
      localUser: {
        id: localPresenceTabId,
        name: presenceProfile.name,
        color: presenceProfile.color,
        avatarUrl: currentUser.avatarUrl,
        x: userPoseRef.current.x,
        y: userPoseRef.current.y,
        device: deviceType,
        lastSeen: Date.now(),
      },
      onUsersChange: (users) => {
        setLiveUsers(users);
      },
      onStatusChange: (status) => {
        setPresenceStatus(status);
      },
    });

    presenceClientRef.current = client;
    void client.start();

    return () => {
      if (presenceClientRef.current === client) {
        presenceClientRef.current = null;
      }
      void client.stop();
    };
  }, [presenceProfile, localPresenceTabId, deviceType, currentUser.avatarUrl]);

  // Compute camera that fits the entire Floor 1 dead-center inside any viewport with full-bleed presence
  const computeFitCamera = useCallback((w: number, h: number): MapCamera => {
    const isCompact = w < 640;
    const isTablet = w >= 640 && w < 1024;
    const padX = isCompact ? 12 : isTablet ? 24 : 40;
    const padTop = isCompact ? 62 : 70;
    const padBottom = isCompact ? 16 : 36;
    const availW = Math.max(160, w - padX * 2);
    const availH = Math.max(160, h - padTop - padBottom);
    const scale = Math.max(
      10,
      Math.min(46, Math.min(availW / WORLD_BOUNDS.width, availH / WORLD_BOUNDS.height))
    );
    const panX = w / 2 - WORLD_BOUNDS.centerX * scale;
    const panY = padTop + availH / 2 - WORLD_BOUNDS.centerY * scale;
    return { scale, panX, panY };
  }, []);

  const clampCameraPan = useCallback(
    (cam: MapCamera, w: number, h: number): MapCamera => {
      const fit = computeFitCamera(w, h);
      if (cam.scale <= fit.scale * 1.03) {
        return fit;
      }
      const marginX = w * 0.35;
      const marginY = h * 0.35;
      const minPanX = marginX - WORLD_BOUNDS.maxX * cam.scale;
      const maxPanX = w - marginX - WORLD_BOUNDS.minX * cam.scale;
      const minPanY = marginY - WORLD_BOUNDS.maxY * cam.scale;
      const maxPanY = h - marginY - WORLD_BOUNDS.minY * cam.scale;
      return {
        scale: cam.scale,
        panX: Math.max(minPanX, Math.min(maxPanX, cam.panX)),
        panY: Math.max(minPanY, Math.min(maxPanY, cam.panY)),
      };
    },
    [computeFitCamera]
  );

  const cancelCameraAnimation = useCallback(() => {
    if (cameraAnimRef.current !== null) {
      cancelAnimationFrame(cameraAnimRef.current);
      cameraAnimRef.current = null;
    }
  }, []);

  const animateCameraTo = useCallback(
    (targetCam: MapCamera) => {
      cancelCameraAnimation();
      const clampedTarget = clampCameraPan(
        targetCam,
        viewportSize.width,
        viewportSize.height
      );
      const prefersReduced =
        typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (prefersReduced) {
        setCamera(clampedTarget);
        return;
      }

      const startCam = { ...cameraRef.current };
      const startTime = performance.now();
      const durationMs = 340;

      const step = (now: number) => {
        const t = Math.min(1, (now - startTime) / durationMs);
        const eased = 1 - Math.pow(1 - t, 3);
        setCamera({
          scale: startCam.scale + (clampedTarget.scale - startCam.scale) * eased,
          panX: startCam.panX + (clampedTarget.panX - startCam.panX) * eased,
          panY: startCam.panY + (clampedTarget.panY - startCam.panY) * eased,
        });
        if (t < 1) {
          cameraAnimRef.current = requestAnimationFrame(step);
        } else {
          cameraAnimRef.current = null;
        }
      };

      cameraAnimRef.current = requestAnimationFrame(step);
    },
    [cancelCameraAnimation, clampCameraPan, viewportSize.width, viewportSize.height]
  );

  useEffect(() => {
    return () => cancelCameraAnimation();
  }, [cancelCameraAnimation]);

  const focusMapOnPoint = useCallback(
    (worldX: number, worldY: number, highlightColor = '#38BDF8') => {
      isManualCameraRef.current = true;
      const targetScale = Math.max(
        cameraRef.current.scale,
        viewportSize.width < 640 ? 24 : 30
      );
      focusHighlightRef.current = {
        x: worldX,
        y: worldY,
        color: highlightColor,
        until: Date.now() + 1600,
      };
      animateCameraTo({
        scale: targetScale,
        panX: viewportSize.width / 2 - worldX * targetScale,
        panY: viewportSize.height / 2 - worldY * targetScale,
      });
    },
    [animateCameraTo, viewportSize.width, viewportSize.height]
  );

  const fitFloorPlan = useCallback(() => {
    isManualCameraRef.current = false;
    animateCameraTo(computeFitCamera(viewportSize.width, viewportSize.height));
  }, [animateCameraTo, computeFitCamera, viewportSize.width, viewportSize.height]);

  const centerOnUser = useCallback(() => {
    focusMapOnPoint(userPose.x, userPose.y, '#3B82F6');
  }, [focusMapOnPoint, userPose.x, userPose.y]);

  const zoomBy = useCallback(
    (factor: number, focusX?: number, focusY?: number) => {
      cancelCameraAnimation();
      const fit = computeFitCamera(viewportSize.width, viewportSize.height);
      setCamera((prev) => {
        const nextScale = Math.max(fit.scale, Math.min(72, prev.scale * factor));
        if (nextScale <= fit.scale * 1.03) {
          isManualCameraRef.current = false;
          return fit;
        }
        isManualCameraRef.current = true;
        const fx = focusX ?? viewportSize.width / 2;
        const fy = focusY ?? viewportSize.height / 2;
        const worldX = (fx - prev.panX) / prev.scale;
        const worldY = (fy - prev.panY) / prev.scale;
        return clampCameraPan(
          {
            scale: nextScale,
            panX: fx - worldX * nextScale,
            panY: fy - worldY * nextScale,
          },
          viewportSize.width,
          viewportSize.height
        );
      });
    },
    [cancelCameraAnimation, viewportSize.width, viewportSize.height, computeFitCamera, clampCameraPan]
  );

  // Keep map locked dead-center across viewport resizes unless user intentionally zoomed in
  useEffect(() => {
    const el = mapContainerRef.current;
    if (!el) return;

    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const w = Math.round(rect.width);
        const h = Math.round(rect.height);
        setViewportSize({ width: w, height: h });
        if (!isManualCameraRef.current) {
          setCamera(computeFitCamera(w, h));
        } else {
          setCamera((prev) => clampCameraPan(prev, w, h));
        }
      }
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, [computeFitCamera, clampCameraPan]);

  // Detect Web Bluetooth availability & previously paired devices
  useEffect(() => {
    const nav =
      typeof navigator !== 'undefined'
        ? (navigator as Navigator & { bluetooth?: WebBluetoothNavigatorLike })
        : null;
    if (nav && 'bluetooth' in nav && nav.bluetooth) {
      setBleState('available');
      if (typeof nav.bluetooth.getDevices === 'function') {
        void nav.bluetooth
          .getDevices()
          .then((devices) => {
            setBleKnownDevices(
              devices.map((d) => ({
                id: d.id,
                displayName: formatCleanBleName(d.name, { id: d.id }),
                rawName: d.name || '',
                manufacturer: null,
                model: null,
                batteryPct: null,
                rssi: null,
                connected: Boolean(d.gatt?.connected),
                lastUpdated: 'Saved',
              }))
            );
          })
          .catch(() => {});
      }
    } else {
      setBleState('unsupported');
    }
  }, []);

  // Close mobile sheet, telemetry drawer, online dropdown, or BLE modal on Escape
  useEffect(() => {
    if (!isMobileSheetOpen && !isTelemetryOpen && !isOnlineDropdownOpen && !isBleModalOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsMobileSheetOpen(false);
        setIsTelemetryOpen(false);
        setIsOnlineDropdownOpen(false);
        setIsBleModalOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isMobileSheetOpen, isTelemetryOpen, isOnlineDropdownOpen, isBleModalOpen]);

  // Step Forward immediately along live headingRef direction
  const stepForward = useCallback((stepLength = 0.7) => {
    setUserPose((prev) => {
      const liveHeading = headingRef.current;
      const headingRad = ((liveHeading - 90) * Math.PI) / 180;
      const dx = Math.cos(headingRad) * stepLength;
      const dy = Math.sin(headingRad) * stepLength;

      const resolved = resolveWallCollision(prev.x, prev.y, dx, dy);
      const actualMoved = Math.hypot(resolved.x - prev.x, resolved.y - prev.y);

      if (resolved.hitWall) {
        wallHitUntilRef.current = Date.now() + 450;
      }

      if (actualMoved < 0.03) {
        return {
          ...prev,
          heading: Math.round(liveHeading),
        };
      }

      return {
        ...prev,
        x: resolved.x,
        y: resolved.y,
        heading: Math.round(liveHeading),
        stepCount: prev.stepCount + 1,
        totalDistanceMeters: Number((prev.totalDistanceMeters + actualMoved).toFixed(1)),
      };
    });
  }, []);

  const displayedDemoBots = useMemo(
    () => (showDemoBots ? peers : []),
    [showDemoBots, peers]
  );

  const activeTarget = useMemo(() => {
    if (targetLiveUserId) {
      const liveUser = liveUsers.find((u) => u.id === targetLiveUserId);
      if (liveUser) {
        return {
          id: liveUser.id,
          name: liveUser.name,
          subtext: `Live User · ${liveUser.device === 'mobile' ? 'Mobile' : 'Laptop'}`,
          coords: { x: liveUser.x, y: liveUser.y },
          isPeer: true,
        };
      }
    }
    if (targetPeerId && showDemoBots) {
      const peer = peers.find((p) => p.id === targetPeerId);
      if (peer) {
        return {
          id: peer.id,
          name: peer.fullName,
          subtext: `${peer.department} · ${peer.role}`,
          coords: { x: peer.x, y: peer.y },
          isPeer: true,
        };
      }
    }
    if (targetRoomId) {
      const room = nodes.find((n) => n.id === targetRoomId);
      if (room) {
        return {
          id: room.id,
          name: room.label,
          subtext: `Room ${ROOM_CODES[room.id] || ''} · Floor 1`,
          coords: { x: room.x, y: room.y },
          isPeer: false,
        };
      }
    }
    return null;
  }, [targetLiveUserId, liveUsers, targetPeerId, showDemoBots, targetRoomId, peers, nodes]);

  // Lock the active A* path when Motion Sensors are enabled so navigation stays on one fixed route
  useEffect(() => {
    motionSensorsActiveRef.current = motionSensorsActive;
    if (!motionSensorsActive || !activeTarget) {
      setLockedRoute((prev) => (prev ? null : prev));
      return;
    }

    setLockedRoute((prev) => {
      if (prev && prev.targetId === activeTarget.id) {
        return prev;
      }
      const computed = runAStarBetweenCoordinates(
        nodes,
        edges,
        { x: userPoseRef.current.x, y: userPoseRef.current.y },
        activeTarget.coords
      );
      if (!computed) return null;
      return {
        targetId: activeTarget.id,
        pathCoordinates: computed.pathCoordinates,
        totalDistance: computed.totalDistance,
        pathNodeIds: computed.pathNodeIds,
      };
    });
  }, [motionSensorsActive, activeTarget, nodes, edges]);

  const activeRoute = useMemo(() => {
    if (!activeTarget) return null;
    if (motionSensorsActive && lockedRoute && lockedRoute.targetId === activeTarget.id) {
      return {
        pathCoordinates: lockedRoute.pathCoordinates,
        totalDistance: lockedRoute.totalDistance,
        pathNodeIds: lockedRoute.pathNodeIds,
      };
    }
    return runAStarBetweenCoordinates(
      nodes,
      edges,
      { x: userPose.x, y: userPose.y },
      activeTarget.coords
    );
  }, [motionSensorsActive, lockedRoute, userPose.x, userPose.y, activeTarget, nodes, edges]);

  const liveDirectDistance = useMemo(() => {
    if (!activeTarget) return 0;
    return Math.hypot(activeTarget.coords.x - userPose.x, activeTarget.coords.y - userPose.y);
  }, [userPose.x, userPose.y, activeTarget]);

  const remainingDistanceMeters = useMemo(() => {
    if (!activeTarget) return 0;
    if (
      motionSensorsActive &&
      lockedRoute &&
      lockedRoute.targetId === activeTarget.id &&
      lockedRoute.pathCoordinates.length >= 2
    ) {
      return computeRemainingDistanceAlongPolyline(
        { x: userPose.x, y: userPose.y },
        lockedRoute.pathCoordinates
      );
    }
    if (activeRoute && activeRoute.totalDistance > 0) {
      return activeRoute.totalDistance;
    }
    return liveDirectDistance;
  }, [
    activeTarget,
    motionSensorsActive,
    lockedRoute,
    userPose.x,
    userPose.y,
    activeRoute,
    liveDirectDistance,
  ]);

  const hasArrived = Boolean(activeTarget && liveDirectDistance < 1.4);

  const walkableDistancesById = useMemo(() => {
    const map = new Map<string, number>();
    const origin = { x: userPose.x, y: userPose.y };
    for (const lu of liveUsers) {
      const res = findWallFreePath(origin, { x: lu.x, y: lu.y });
      map.set(lu.id, res ? res.totalDistance : Math.hypot(lu.x - origin.x, lu.y - origin.y));
    }
    for (const peer of displayedDemoBots) {
      const res = findWallFreePath(origin, { x: peer.x, y: peer.y });
      map.set(peer.id, res ? res.totalDistance : Math.hypot(peer.x - origin.x, peer.y - origin.y));
    }
    for (const room of roomDestinations) {
      const res = findWallFreePath(origin, { x: room.x, y: room.y });
      map.set(room.id, res ? res.totalDistance : Math.hypot(room.x - origin.x, room.y - origin.y));
    }
    return map;
  }, [userPose.x, userPose.y, liveUsers, displayedDemoBots, roomDestinations]);

  const filteredLiveUsers = useMemo(() => {
    const q = directorySearch.trim().toLowerCase();
    if (!q) return liveUsers;
    return liveUsers.filter(
      (u) => u.name.toLowerCase().includes(q) || u.device.toLowerCase().includes(q)
    );
  }, [liveUsers, directorySearch]);

  const filteredPeers = useMemo(() => {
    const q = directorySearch.trim().toLowerCase();
    if (!q) return displayedDemoBots;
    return displayedDemoBots.filter(
      (p) =>
        p.fullName.toLowerCase().includes(q) ||
        p.department.toLowerCase().includes(q) ||
        p.role.toLowerCase().includes(q)
    );
  }, [displayedDemoBots, directorySearch]);

  const filteredRooms = useMemo(() => {
    const q = directorySearch.trim().toLowerCase();
    if (!q) return roomDestinations;
    return roomDestinations.filter((r) => r.label.toLowerCase().includes(q));
  }, [roomDestinations, directorySearch]);

  useEffect(() => {
    activeRouteRef.current = activeRoute;
  }, [activeRoute]);

  useEffect(() => {
    activeTargetRef.current = activeTarget;
  }, [activeTarget]);

  const toggleLiveSimulation = useCallback(() => {
    setIsSimulating((prev) => {
      const next = !prev;
      if (next) {
        setBleSuggestionDismissed(true);
        simRuntimeRef.current.dwellTicks = 0;
        simRuntimeRef.current.strideAccumMeters = 0;
        if (!targetPeerId && !targetRoomId) {
          setTargetPeerId('peer_hassaan');
        }
      } else {
        setRawTrilatPose(null);
        setKalmanTrilatPose(null);
      }
      return next;
    });
  }, [targetPeerId, targetRoomId]);

  const hydrateBleDeviceInfo = useCallback(async (device: WebBluetoothDeviceLike) => {
    if (bleAdvCleanupRef.current) {
      bleAdvCleanupRef.current();
      bleAdvCleanupRef.current = null;
    }
    bleDeviceRef.current = device;

    const decoder = new TextDecoder('utf-8');
    let gapName: string | null = null;
    let manufacturer: string | null = null;
    let model: string | null = null;
    let batteryPct: number | null = null;
    let connected = Boolean(device.gatt?.connected);

    if (device.gatt) {
      try {
        const gattServer = await Promise.race([
          device.gatt.connect(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3500)),
        ]);
        connected = Boolean(gattServer?.connected);

        const readTextChar = async (serviceUuid: string | number, charUuid: string | number) => {
          try {
            const svc = await gattServer.getPrimaryService(serviceUuid);
            const ch = await svc.getCharacteristic(charUuid);
            const val = await ch.readValue();
            return decoder.decode(val.buffer).replace(/\0/g, '').trim() || null;
          } catch {
            return null;
          }
        };

        gapName = await readTextChar('generic_access', 0x2a00);
        manufacturer = await readTextChar('device_information', 0x2a29);
        model = await readTextChar('device_information', 0x2a24);

        try {
          const batSvc = await gattServer.getPrimaryService('battery_service');
          const batCh = await batSvc.getCharacteristic(0x2a19);
          const batVal = await batCh.readValue();
          if (batVal.byteLength > 0) {
            batteryPct = batVal.getUint8(0);
          }
        } catch {
          // Battery service optional
        }
      } catch {
        // Device may be broadcast-only (iBeacon/Eddystone) without GATT server
      }
    }

    const displayName = formatCleanBleName(device.name, {
      gapName,
      manufacturer,
      model,
      id: device.id,
    });
    const nowLabel = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const info: PairedBleInfo = {
      id: device.id,
      displayName,
      rawName: device.name || '',
      manufacturer,
      model,
      batteryPct,
      rssi: null,
      connected,
      lastUpdated: nowLabel,
    };

    setBleDeviceName(displayName);
    setBleCustomAlias(displayName);
    setBlePairedDevice(info);
    setBleState('connected');
    setIsSimulating(false);
    setBleSuggestionDismissed(true);
    setBleStatusNote(
      connected ? 'GATT connected · Name verified' : 'Paired · Passive BLE beacon mode'
    );

    if (typeof device.watchAdvertisements === 'function' && device.addEventListener) {
      const onAdv = (ev: Event) => {
        const adv = ev as Event & { rssi?: number; name?: string };
        const liveRssi = typeof adv.rssi === 'number' ? adv.rssi : null;
        if (liveRssi !== null) {
          setBlePairedDevice((prev) =>
            prev
              ? {
                  ...prev,
                  rssi: liveRssi,
                  lastUpdated: new Date().toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  }),
                }
              : prev
          );
          setBeacons((prevBeacons) =>
            prevBeacons.map((b, idx) => {
              if (idx !== 0) return b;
              const kalman = updateKalman1D(b.kalmanState, liveRssi);
              return {
                ...b,
                currentRawRssi: liveRssi,
                filteredRssi: Number(kalman.x.toFixed(1)),
                rawDistance: Number(rssiToDistance(liveRssi, b.txPower, b.pathLossN).toFixed(2)),
                estimatedDistance: Number(rssiToDistance(kalman.x, b.txPower, b.pathLossN).toFixed(2)),
                kalmanState: { q: kalman.q, r: kalman.r, p: kalman.p, x: kalman.x },
              };
            })
          );
        }
      };
      device.addEventListener('advertisementreceived', onAdv);
      void device.watchAdvertisements().catch(() => {});
      bleAdvCleanupRef.current = () => {
        device.removeEventListener?.('advertisementreceived', onAdv);
      };
    }

    const nav = navigator as Navigator & { bluetooth?: WebBluetoothNavigatorLike };
    if (nav.bluetooth?.getDevices) {
      void nav.bluetooth
        .getDevices()
        .then((list) => {
          setBleKnownDevices(
            list.map((d) => ({
              id: d.id,
              displayName: d.id === device.id ? displayName : formatCleanBleName(d.name, { id: d.id }),
              rawName: d.name || '',
              manufacturer: d.id === device.id ? manufacturer : null,
              model: d.id === device.id ? model : null,
              batteryPct: d.id === device.id ? batteryPct : null,
              rssi: null,
              connected: d.id === device.id ? connected : Boolean(d.gatt?.connected),
              lastUpdated: d.id === device.id ? nowLabel : 'Saved',
            }))
          );
        })
        .catch(() => {});
    }
  }, []);

  const scanAndPairHardwareBle = useCallback(
    async (modeOverride?: BleScanMode, prefixOverride?: string) => {
      const nav =
        typeof navigator !== 'undefined'
          ? (navigator as Navigator & { bluetooth?: WebBluetoothNavigatorLike })
          : null;
      if (!nav?.bluetooth) {
        setBleState('unsupported');
        setBleSuggestionDismissed(false);
        return;
      }

      const activeMode = modeOverride ?? bleScanMode;
      const prefix = (prefixOverride ?? bleNamePrefix).trim();

      setBleBusy(true);
      setBleStatusNote('Scanning nearby Bluetooth devices...');
      try {
        let requestOpts: {
          acceptAllDevices?: boolean;
          filters?: Array<{ namePrefix?: string; services?: Array<string | number> }>;
          optionalServices?: Array<string | number>;
        };

        if (activeMode === 'prefix' && prefix.length > 0) {
          requestOpts = {
            filters: [{ namePrefix: prefix }],
            optionalServices: BLE_OPTIONAL_SERVICES,
          };
        } else if (activeMode === 'beacons') {
          requestOpts = {
            filters: [
              { services: ['0000feaa-0000-1000-8000-00805f9b34fb'] },
              { services: ['0000fe9a-0000-1000-8000-00805f9b34fb'] },
              { services: ['device_information'] },
              { services: ['battery_service'] },
              { services: ['generic_access'] },
              { services: ['heart_rate'] },
              { namePrefix: 'ESP' },
              { namePrefix: 'Beacon' },
              { namePrefix: 'iBeacon' },
              { namePrefix: 'Indoor' },
              { namePrefix: 'Nordic' },
              { namePrefix: 'nRF' },
              { namePrefix: 'HM' },
              { namePrefix: 'JDY' },
            ],
            optionalServices: BLE_OPTIONAL_SERVICES,
          };
        } else {
          requestOpts = {
            acceptAllDevices: true,
            optionalServices: BLE_OPTIONAL_SERVICES,
          };
        }

        const device = await nav.bluetooth.requestDevice(requestOpts);
        await hydrateBleDeviceInfo(device);
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.toLowerCase().includes('cancel')) {
          setBleStatusNote('Scan cancelled. Try "All Nearby Devices" if your beacon was hidden.');
        } else {
          setBleState('denied');
          setBleStatusNote('Bluetooth permission declined or unavailable.');
          setBleSuggestionDismissed(false);
        }
      } finally {
        setBleBusy(false);
      }
    },
    [bleScanMode, bleNamePrefix, hydrateBleDeviceInfo]
  );

  const refreshHardwareBle = useCallback(async () => {
    const nav =
      typeof navigator !== 'undefined'
        ? (navigator as Navigator & { bluetooth?: WebBluetoothNavigatorLike })
        : null;
    if (!nav?.bluetooth) {
      setBleState('unsupported');
      return;
    }

    setBleBusy(true);
    setBleStatusNote('Refreshing Bluetooth devices & signal...');
    try {
      if (bleDeviceRef.current) {
        await hydrateBleDeviceInfo(bleDeviceRef.current);
      } else if (typeof nav.bluetooth.getDevices === 'function') {
        const saved = await nav.bluetooth.getDevices();
        setBleKnownDevices(
          saved.map((d) => ({
            id: d.id,
            displayName: formatCleanBleName(d.name, { id: d.id }),
            rawName: d.name || '',
            manufacturer: null,
            model: null,
            batteryPct: null,
            rssi: null,
            connected: Boolean(d.gatt?.connected),
            lastUpdated: 'Refreshed',
          }))
        );
        if (saved.length > 0) {
          await hydrateBleDeviceInfo(saved[0]);
        } else {
          setIsBleModalOpen(true);
          setBleStatusNote('No paired device yet. Select a filter and scan.');
        }
      } else {
        setIsBleModalOpen(true);
        setBleStatusNote('Select a filter and scan for BLE beacons.');
      }
    } catch {
      setBleStatusNote('Could not refresh device. Try Re-scanning.');
    } finally {
      setBleBusy(false);
    }
  }, [hydrateBleDeviceInfo]);

  const disconnectHardwareBle = useCallback(() => {
    if (bleAdvCleanupRef.current) {
      bleAdvCleanupRef.current();
      bleAdvCleanupRef.current = null;
    }
    try {
      if (bleDeviceRef.current?.gatt?.connected) {
        bleDeviceRef.current.gatt.disconnect();
      }
    } catch {
      // Ignore disconnect errors
    }
    bleDeviceRef.current = null;
    setBlePairedDevice(null);
    setBleDeviceName(null);
    setBleCustomAlias('');
    setBleState('available');
    setBleStatusNote('Disconnected.');
  }, []);

  useEffect(() => {
    return () => {
      if (bleAdvCleanupRef.current) {
        bleAdvCleanupRef.current();
      }
    };
  }, []);

  // Evaluator Live Simulation Mode loop:
  // Walks along the active A* route, updates PDR steps/heading, synthesizes noisy RSSI across 4 BLE beacons,
  // runs 1D Kalman filtering + 2D trilateration to compare raw jitter vs smoothed position.
  useEffect(() => {
    if (!isSimulating) return;

    const runSimTick = () => {
      const curPose = userPoseRef.current;
      let nextX = curPose.x;
      let nextY = curPose.y;
      let nextHeading = curPose.heading;
      let addedSteps = 0;
      let addedMeters = 0;

      const route = activeRouteRef.current;
      const target = activeTargetRef.current;

      if (!target) {
        const pick = SIMULATION_TARGETS[simRuntimeRef.current.routeCycleIndex % SIMULATION_TARGETS.length];
        if (pick.kind === 'peer') {
          setTargetPeerId(pick.id);
          setTargetRoomId(null);
        } else {
          setTargetRoomId(pick.id);
          setTargetPeerId(null);
        }
      } else if (route && route.pathCoordinates.length >= 2) {
        const distToGoal = Math.hypot(target.coords.x - curPose.x, target.coords.y - curPose.y);
        if (distToGoal < 1.1) {
          if (!motionSensorsActiveRef.current) {
            simRuntimeRef.current.dwellTicks += 1;
            if (simRuntimeRef.current.dwellTicks >= 4) {
              simRuntimeRef.current.dwellTicks = 0;
              simRuntimeRef.current.routeCycleIndex =
                (simRuntimeRef.current.routeCycleIndex + 1) % SIMULATION_TARGETS.length;
              const nextPick = SIMULATION_TARGETS[simRuntimeRef.current.routeCycleIndex];
              if (nextPick.kind === 'peer') {
                setTargetPeerId(nextPick.id);
                setTargetRoomId(null);
              } else {
                setTargetRoomId(nextPick.id);
                setTargetPeerId(null);
              }
            }
          }
        } else {
          simRuntimeRef.current.dwellTicks = 0;
          const coords = route.pathCoordinates;
          let wp = coords[coords.length - 1];
          for (let i = 1; i < coords.length; i++) {
            if (Math.hypot(coords[i].x - curPose.x, coords[i].y - curPose.y) > 0.18) {
              wp = coords[i];
              break;
            }
          }

          const dx = wp.x - curPose.x;
          const dy = wp.y - curPose.y;
          const segDist = Math.hypot(dx, dy);
          if (segDist > 0.02) {
            const moveStep = Math.min(0.44, segDist);
            const resolved = resolveWallCollision(
              curPose.x,
              curPose.y,
              (dx / segDist) * moveStep,
              (dy / segDist) * moveStep
            );
            const moved = Math.hypot(resolved.x - curPose.x, resolved.y - curPose.y);
            if (moved > 0.01) {
              nextX = resolved.x;
              nextY = resolved.y;
              addedMeters = moved;
              simRuntimeRef.current.strideAccumMeters += moved;
              while (simRuntimeRef.current.strideAccumMeters >= 0.68) {
                addedSteps += 1;
                simRuntimeRef.current.strideAccumMeters -= 0.68;
              }
            }
            const angleDeg = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 360) % 360);
            nextHeading = angleDeg;
            headingRef.current = angleDeg;
          }
        }
      }

      if (addedMeters > 0 || addedSteps > 0 || nextHeading !== curPose.heading) {
        setUserPose((prev) => ({
          ...prev,
          x: nextX,
          y: nextY,
          heading: nextHeading,
          stepCount: prev.stepCount + addedSteps,
          totalDistanceMeters: Number((prev.totalDistanceMeters + addedMeters).toFixed(1)),
          accuracy: 0.75,
        }));
      }

      // Generate synthetic BLE RSSI with Gaussian noise & pass through 1D Kalman Filter
      const nextBeacons: TelemetryBeaconSnapshot[] = beaconsRef.current.map((b) => {
        const trueDist = Math.max(0.2, Math.hypot(b.x - nextX, b.y - nextY));
        const rawRssi = simulateRawRssi(trueDist, b.txPower, b.pathLossN, 2.8);
        const kalmanOut = updateKalman1D(b.kalmanState, rawRssi);
        const rawDist = rssiToDistance(rawRssi, b.txPower, b.pathLossN);
        const filteredDist = rssiToDistance(kalmanOut.x, b.txPower, b.pathLossN);
        return {
          ...b,
          currentRawRssi: Number(rawRssi.toFixed(1)),
          filteredRssi: Number(kalmanOut.x.toFixed(1)),
          rawDistance: Number(rawDist.toFixed(2)),
          estimatedDistance: Number(filteredDist.toFixed(2)),
          kalmanState: {
            q: kalmanOut.q,
            r: kalmanOut.r,
            p: kalmanOut.p,
            x: kalmanOut.x,
          },
        };
      });

      setBeacons(nextBeacons);

      const nearestThree = [...nextBeacons]
        .sort((a, b) => a.estimatedDistance - b.estimatedDistance)
        .slice(0, 3);

      const kalmanSolved = solveTrilateration(nearestThree);
      const rawSolved = solveTrilateration(
        nearestThree.map((b) => ({ ...b, estimatedDistance: b.rawDistance }))
      );

      if (kalmanSolved) {
        const clampedK = {
          x: Math.max(WORLD_BOUNDS.minX, Math.min(WORLD_BOUNDS.maxX, kalmanSolved.x)),
          y: Math.max(WORLD_BOUNDS.minY, Math.min(WORLD_BOUNDS.maxY, kalmanSolved.y)),
        };
        setKalmanTrilatPose(clampedK);
        setKalmanError(Number(Math.hypot(clampedK.x - nextX, clampedK.y - nextY).toFixed(2)));
      }

      if (rawSolved) {
        const clampedR = {
          x: Math.max(WORLD_BOUNDS.minX - 1.5, Math.min(WORLD_BOUNDS.maxX + 1.5, rawSolved.x)),
          y: Math.max(WORLD_BOUNDS.minY - 1.5, Math.min(WORLD_BOUNDS.maxY + 1.5, rawSolved.y)),
        };
        setRawTrilatPose(clampedR);
        setRawJitterError(Number(Math.hypot(clampedR.x - nextX, clampedR.y - nextY).toFixed(2)));
      }
    };

    runSimTick();
    const timer = window.setInterval(runSimTick, 380);
    return () => window.clearInterval(timer);
  }, [isSimulating]);

  useEffect(() => {
    let frame: number;
    const tick = () => {
      setPulseAnim((prev) => (prev + 0.016) % 1);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setPeers((prev) =>
        prev.map((peer, idx) => {
          const angle = Date.now() / 1400 + idx * 1.5;
          const bases = [
            { x: 26.0, y: 20.0 },
            { x: 6.0, y: 5.0 },
            { x: 26.0, y: 5.0 },
            { x: 6.0, y: 20.0 },
          ];
          const b = bases[idx] || { x: peer.x, y: peer.y };
          return {
            ...peer,
            x: Number((b.x + Math.sin(angle) * 0.45).toFixed(2)),
            y: Number((b.y + Math.cos(angle) * 0.45).toFixed(2)),
            lastUpdated: 'Live',
          };
        })
      );
    }, 700);
    return () => clearInterval(interval);
  }, []);

  const handleOrientation = useCallback((e: DeviceOrientationEvent) => {
    const compass = (e as unknown as { webkitCompassHeading?: number }).webkitCompassHeading;
    const screenAngle =
      typeof window !== 'undefined' && window.screen?.orientation
        ? window.screen.orientation.angle || 0
        : 0;

    let rawHeading: number | null = null;
    if (compass !== undefined && compass !== null && !Number.isNaN(compass)) {
      rawHeading = (compass + screenAngle + 360) % 360;
    } else if (e.alpha !== null && !Number.isNaN(e.alpha)) {
      rawHeading = (360 - e.alpha + screenAngle + 360) % 360;
    }

    if (rawHeading === null) return;
    rawHeadingRef.current = rawHeading;

    const calibrated = (rawHeading - headingOffsetRef.current + 360) % 360;
    const smoothed = smoothHeadingDegrees(headingRef.current, calibrated, 0.48);
    headingRef.current = smoothed;

    const now = Date.now();
    if (now - lastHeadingSyncRef.current >= 40) {
      lastHeadingSyncRef.current = now;
      const rounded = Math.round(smoothed);
      setUserPose((prev) =>
        Math.abs(prev.heading - rounded) >= 2 ? { ...prev, heading: rounded } : prev
      );
    }
  }, []);

  const handleMotion = useCallback(
    (e: DeviceMotionEvent) => {
      const accG = e.accelerationIncludingGravity;
      const accLin = e.acceleration;
      if (!accG && !accLin) return;

      const ax = accG?.x ?? 0;
      const ay = accG?.y ?? 0;
      const az = accG?.z ?? 0;

      const result = stepDetectorRef.current.processSample({
        ax,
        ay,
        az,
        linAx: accLin?.x ?? null,
        linAy: accLin?.y ?? null,
        linAz: accLin?.z ?? null,
        rotAlpha: e.rotationRate?.alpha ?? null,
        rotBeta: e.rotationRate?.beta ?? null,
        rotGamma: e.rotationRate?.gamma ?? null,
        timestampMs: Date.now(),
      });

      if (result.stepDetected) {
        stepForward(result.stepLengthMeters);
      } else if (result.shakeRejected) {
        setSensorStatusMessage('Shake Ignored');
        if (shakeHintTimerRef.current) {
          window.clearTimeout(shakeHintTimerRef.current);
        }
        shakeHintTimerRef.current = window.setTimeout(() => {
          setSensorStatusMessage('Motion Active');
        }, 900);
      }
    },
    [stepForward]
  );

  const alignPhoneHeadingToMap = useCallback(() => {
    if (rawHeadingRef.current !== null) {
      headingOffsetRef.current = rawHeadingRef.current;
    }
    headingRef.current = 0;
    setUserPose((prev) => ({ ...prev, heading: 0 }));
    setSensorStatusMessage('Aligned');
    window.setTimeout(() => {
      setSensorStatusMessage((cur) => (cur === 'Aligned' ? 'Motion Active' : cur));
    }, 1100);
  }, []);

  const attachMotionListeners = useCallback(() => {
    if (sensorCleanupRef.current) {
      sensorCleanupRef.current();
      sensorCleanupRef.current = null;
    }

    stepDetectorRef.current.reset();

    let hasAbsoluteOrientation = false;
    const onAbsOrientation = (e: Event) => {
      const de = e as DeviceOrientationEvent;
      if (de.alpha !== null && !Number.isNaN(de.alpha)) {
        hasAbsoluteOrientation = true;
      }
      handleOrientation(de);
    };
    const onOrientation = (e: DeviceOrientationEvent) => {
      const compass = (e as unknown as { webkitCompassHeading?: number }).webkitCompassHeading;
      if (
        !hasAbsoluteOrientation ||
        (compass !== undefined && compass !== null)
      ) {
        handleOrientation(e);
      }
    };

    window.addEventListener('deviceorientationabsolute', onAbsOrientation);
    window.addEventListener('deviceorientation', onOrientation);
    window.addEventListener('devicemotion', handleMotion);

    sensorCleanupRef.current = () => {
      window.removeEventListener('deviceorientationabsolute', onAbsOrientation);
      window.removeEventListener('deviceorientation', onOrientation);
      window.removeEventListener('devicemotion', handleMotion);
    };

    setMotionSensorsActive(true);
    setSensorStatusMessage('Motion Active');
  }, [handleOrientation, handleMotion]);

  const detachMotionListeners = useCallback(() => {
    if (sensorCleanupRef.current) {
      sensorCleanupRef.current();
      sensorCleanupRef.current = null;
    }
    if (shakeHintTimerRef.current) {
      window.clearTimeout(shakeHintTimerRef.current);
      shakeHintTimerRef.current = null;
    }
    stepDetectorRef.current.reset();
    setMotionSensorsActive(false);
    setSensorStatusMessage('Enable Motion');
  }, []);

  const requestSensorAccess = useCallback(async () => {
    try {
      const reqOri = (
        DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }
      )?.requestPermission;
      const reqMot = (
        DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> }
      )?.requestPermission;

      const oriPromise = typeof reqOri === 'function' ? reqOri() : Promise.resolve('granted');
      const motPromise = typeof reqMot === 'function' ? reqMot() : Promise.resolve('granted');

      const [oriPerm, motPerm] = await Promise.all([oriPromise, motPromise]);
      if (oriPerm !== 'granted' || motPerm !== 'granted') {
        setMotionSensorsActive(false);
        setSensorStatusMessage('Permission Denied');
        return;
      }

      attachMotionListeners();
    } catch {
      setMotionSensorsActive(false);
      setSensorStatusMessage('Permission Denied');
    }
  }, [attachMotionListeners]);

  const toggleMotionSensors = useCallback(async () => {
    if (motionSensorsActive) {
      detachMotionListeners();
      return;
    }
    await requestSensorAccess();
  }, [motionSensorsActive, detachMotionListeners, requestSensorAccess]);

  useEffect(() => {
    const needsExplicitPrompt =
      typeof (DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> })
        ?.requestPermission === 'function' ||
      typeof (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> })
        ?.requestPermission === 'function';

    if (!needsExplicitPrompt) {
      attachMotionListeners();
    }

    return () => {
      if (sensorCleanupRef.current) {
        sensorCleanupRef.current();
      }
      if (shakeHintTimerRef.current) {
        window.clearTimeout(shakeHintTimerRef.current);
      }
    };
  }, [attachMotionListeners]);

  // Full-Viewport HiDPI Enterprise Spatial Map Painter
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width: viewW, height: viewH } = viewportSize;
    if (viewW <= 0 || viewH <= 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const backingW = Math.round(viewW * dpr);
    const backingH = Math.round(viewH * dpr);
    if (canvas.width !== backingW || canvas.height !== backingH) {
      canvas.width = backingW;
      canvas.height = backingH;
    }

    ctx.save();
    ctx.scale(dpr, dpr);

    // 1. Transparent Canvas Stage over Full-Bleed Engineering Coordinate Grid
    ctx.clearRect(0, 0, viewW, viewH);

    const { scale, panX, panY } = camera;
    const wx = (mx: number) => panX + mx * scale;
    const wy = (my: number) => panY + my * scale;
    const labelYScale = is25DMode ? 1.132 : 1;

    const bx = wx(WORLD_BOUNDS.minX);
    const by = wy(WORLD_BOUNDS.minY);
    const bw = WORLD_BOUNDS.width * scale;
    const bh = WORLD_BOUNDS.height * scale;

    // Subtle building architectural floor elevation shadow
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.72)';
    ctx.shadowBlur = is25DMode ? 48 : 36;
    ctx.shadowOffsetY = is25DMode ? 22 : 12;
    ctx.fillStyle = '#0B111C';
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 4);
    ctx.fill();
    ctx.restore();

    // Track occupied label boxes so markers & room titles never collide
    const occupiedLabels: LabelRect[] = [];

    // Helper: Draw tiny vector micro-icon badge for each functional room zone
    const drawRoomMicroIcon = (roomId: string, cx: number, cy: number, color: string) => {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1, labelYScale);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.25;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (roomId === 'room_101') {
        // Lab 101: Precision conical flask
        ctx.beginPath();
        ctx.moveTo(-2, -4.5);
        ctx.lineTo(2, -4.5);
        ctx.moveTo(-1.3, -4.5);
        ctx.lineTo(-1.3, -1.5);
        ctx.lineTo(-4.2, 3.8);
        ctx.lineTo(4.2, 3.8);
        ctx.lineTo(1.3, -1.5);
        ctx.lineTo(1.3, -4.5);
        ctx.stroke();
      } else if (roomId === 'room_105') {
        // Server Hub: Dual rack blades + LED dot
        ctx.strokeRect(-4.5, -4, 9, 3.2);
        ctx.strokeRect(-4.5, 0.8, 9, 3.2);
        ctx.fillRect(-3, -2.8, 1.4, 1);
        ctx.fillRect(-3, 2, 1.4, 1);
      } else if (roomId === 'room_102') {
        // Conference Room A: Presentation board
        ctx.strokeRect(-4.5, -4, 9, 5.6);
        ctx.beginPath();
        ctx.moveTo(0, 1.6);
        ctx.lineTo(0, 4.2);
        ctx.moveTo(-2.5, 4.2);
        ctx.lineTo(2.5, 4.2);
        ctx.stroke();
      } else if (roomId === 'room_103') {
        // Cafeteria: Coffee cup + handle
        ctx.beginPath();
        ctx.roundRect(-4.2, -1.8, 6.4, 5.6, 1.4);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(2.2, 0.8, 1.8, -Math.PI / 2, Math.PI / 2);
        ctx.stroke();
      } else if (roomId === 'room_104') {
        // Executive Suite: Briefcase / shield
        ctx.strokeRect(-4.5, -2.2, 9, 6);
        ctx.beginPath();
        ctx.moveTo(-2, -2.2);
        ctx.lineTo(-2, -4);
        ctx.lineTo(2, -4);
        ctx.lineTo(2, -2.2);
        ctx.stroke();
      }
      ctx.restore();
    };

    // 2. Walkable Corridors & Main Concourse Pavement
    ctx.save();
    ctx.beginPath();
    ctx.rect(bx, by, bw, bh);
    ctx.clip();

    // Lit architectural terrazzo corridor floor
    ctx.fillStyle = '#182235';
    ctx.fillRect(bx, by, bw, bh);

    // Subtle 2m x 2m architectural slab grid across walkable corridors
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.06)';
    ctx.lineWidth = 1;
    for (let mx = WORLD_BOUNDS.minX; mx <= WORLD_BOUNDS.maxX; mx += 2) {
      const px = wx(mx);
      ctx.beginPath();
      ctx.moveTo(px, by);
      ctx.lineTo(px, by + bh);
      ctx.stroke();
    }
    for (let my = WORLD_BOUNDS.minY; my <= WORLD_BOUNDS.maxY; my += 2) {
      const py = wy(my);
      ctx.beginPath();
      ctx.moveTo(bx, py);
      ctx.lineTo(bx + bw, py);
      ctx.stroke();
    }

    // Subtle corridor circulation centerline guides
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.13)';
    ctx.lineWidth = Math.max(1, scale * 0.04);
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.moveTo(wx(2.0), wy(12.5));
    ctx.lineTo(wx(13.0), wy(12.5));
    ctx.moveTo(wx(19.0), wy(12.5));
    ctx.lineTo(wx(30.0), wy(12.5));
    ctx.moveTo(wx(16.0), wy(4.8));
    ctx.lineTo(wx(16.0), wy(10.0));
    ctx.moveTo(wx(16.0), wy(15.0));
    ctx.lineTo(wx(16.0), wy(23.0));
    ctx.stroke();
    ctx.setLineDash([]);

    // Corridor & Lobby Architectural Zone Labels
    if (scale >= 11) {
      const hallFont = Math.max(8, Math.min(10.5, scale * 0.31));
      ctx.fillStyle = 'rgba(148, 163, 184, 0.44)';
      ctx.font = `600 ${hallFont}px "JetBrains Mono", monospace`;
      ctx.textAlign = 'center';
      const drawHallLabel = (text: string, mx: number, my: number) => {
        ctx.save();
        ctx.translate(wx(mx), wy(my));
        ctx.scale(1, labelYScale);
        ctx.fillText(text, 0, 0);
        ctx.restore();
      };
      drawHallLabel('NORTH CORRIDOR', 16.0, 7.1);
      drawHallLabel('SOUTH LOBBY', 16.0, 21.8);
      drawHallLabel('WEST CONCOURSE', 7.0, 14.3);
      drawHallLabel('EAST CONCOURSE', 25.0, 14.3);
      ctx.textAlign = 'left';
    }

    // 3. Enclosed Rooms, Distinct Functional Ambient Tints, CAD Fixtures & Micro-Icon Badges
    const ROOM_ACCENTS: Record<string, { fill: string; badgeBg: string; stroke: string }> = {
      room_101: {
        fill: 'rgba(14, 165, 233, 0.085)',
        badgeBg: 'rgba(56, 189, 248, 0.14)',
        stroke: '#38BDF8',
      },
      room_105: {
        fill: 'rgba(16, 185, 129, 0.085)',
        badgeBg: 'rgba(52, 211, 153, 0.14)',
        stroke: '#34D399',
      },
      room_102: {
        fill: 'rgba(139, 92, 246, 0.08)',
        badgeBg: 'rgba(167, 139, 250, 0.14)',
        stroke: '#A78BFA',
      },
      room_103: {
        fill: 'rgba(245, 158, 11, 0.08)',
        badgeBg: 'rgba(251, 191, 36, 0.14)',
        stroke: '#FBBF24',
      },
      room_104: {
        fill: 'rgba(234, 179, 8, 0.065)',
        badgeBg: 'rgba(250, 204, 21, 0.12)',
        stroke: '#FACC15',
      },
    };

    FLOOR_ROOMS.forEach((r) => {
      const rx = wx(r.x);
      const ry = wy(r.y);
      const rw = r.w * scale;
      const rh = r.h * scale;
      const isRoomTarget = targetRoomId === r.id;
      const isAtrium = r.id === 'corr_center';

      // Base room slab
      ctx.fillStyle = isAtrium ? '#152136' : '#0F1624';
      ctx.fillRect(rx, ry, rw, rh);

      // Subtle ambient zone micro-tint
      const accent = ROOM_ACCENTS[r.id];
      if (isRoomTarget) {
        ctx.fillStyle = 'rgba(56, 189, 248, 0.15)';
        ctx.fillRect(rx, ry, rw, rh);
      } else if (accent) {
        ctx.fillStyle = accent.fill;
        ctx.fillRect(rx, ry, rw, rh);
      }

      // Atrium skylight glow + concentric floor tile rings + subtle BLE signal waves
      if (isAtrium) {
        const atriumGlow = ctx.createRadialGradient(
          wx(16.0),
          wy(12.5),
          0,
          wx(16.0),
          wy(12.5),
          Math.max(rw, rh) * 0.62
        );
        atriumGlow.addColorStop(0, 'rgba(56, 189, 248, 0.13)');
        atriumGlow.addColorStop(1, 'rgba(56, 189, 248, 0)');
        ctx.fillStyle = atriumGlow;
        ctx.fillRect(rx, ry, rw, rh);
      }

      // Subtle architectural room furniture & structural inlays
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.15)';
      ctx.fillStyle = 'rgba(148, 163, 184, 0.045)';
      ctx.lineWidth = Math.max(1, scale * 0.04);

      if (r.id === 'room_101') {
        ctx.fillRect(wx(2.0), wy(3.3), 2.3 * scale, 1.05 * scale);
        ctx.strokeRect(wx(2.0), wy(3.3), 2.3 * scale, 1.05 * scale);
        ctx.fillRect(wx(2.0), wy(5.7), 2.3 * scale, 1.05 * scale);
        ctx.strokeRect(wx(2.0), wy(5.7), 2.3 * scale, 1.05 * scale);
        ctx.fillRect(wx(8.2), wy(1.7), 2.0 * scale, 1.15 * scale);
        ctx.strokeRect(wx(8.2), wy(1.7), 2.0 * scale, 1.15 * scale);
      } else if (r.id === 'room_102') {
        ctx.beginPath();
        ctx.roundRect(wx(24.0), wy(6.1), 4.6 * scale, 1.55 * scale, 0.72 * scale);
        ctx.fill();
        ctx.stroke();
        for (let cx = 24.7; cx <= 28.0; cx += 1.1) {
          ctx.beginPath();
          ctx.arc(wx(cx), wy(5.85), 0.16 * scale, 0, Math.PI * 2);
          ctx.arc(wx(cx), wy(7.9), 0.16 * scale, 0, Math.PI * 2);
          ctx.stroke();
        }
      } else if (r.id === 'room_105') {
        for (const sx of [13.9, 15.5, 17.1]) {
          ctx.fillRect(wx(sx), wy(1.35), 1.0 * scale, 0.58 * scale);
          ctx.strokeRect(wx(sx), wy(1.35), 1.0 * scale, 0.58 * scale);
          if (scale >= 14) {
            ctx.fillStyle = 'rgba(52, 211, 153, 0.7)';
            ctx.fillRect(wx(sx + 0.18), wy(1.56), 0.15 * scale, 0.15 * scale);
            ctx.fillStyle = 'rgba(148, 163, 184, 0.045)';
          }
        }
      } else if (r.id === 'room_103') {
        for (const [tx, ty] of [
          [2.7, 19.0],
          [2.7, 22.0],
          [8.4, 22.1],
        ]) {
          ctx.beginPath();
          ctx.arc(wx(tx), wy(ty), 0.66 * scale, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      } else if (r.id === 'room_104') {
        ctx.fillRect(wx(28.5), wy(18.2), 1.5 * scale, 4.0 * scale);
        ctx.strokeRect(wx(28.5), wy(18.2), 1.5 * scale, 4.0 * scale);
        ctx.beginPath();
        ctx.arc(wx(23.3), wy(22.1), 0.62 * scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else if (isAtrium) {
        // Concentric architectural tile rings + subtle center BLE signal wave rings
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
        ctx.beginPath();
        ctx.arc(wx(16.0), wy(12.5), 2.15 * scale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(wx(16.0), wy(12.5), 1.35 * scale, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = `rgba(56, 189, 248, ${0.24 * (1 - pulseAnim)})`;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.arc(wx(16.0), wy(12.5), (0.9 + pulseAnim * 1.45) * scale, 0, Math.PI * 2);
        ctx.stroke();

        for (const [colX, colY] of [
          [13.45, 10.45],
          [18.25, 10.45],
          [13.45, 14.25],
          [18.25, 14.25],
        ]) {
          ctx.fillStyle = 'rgba(148, 163, 184, 0.32)';
          ctx.fillRect(wx(colX), wy(colY), 0.3 * scale, 0.3 * scale);
        }
      }

      if (isRoomTarget) {
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.65)';
        ctx.lineWidth = 1.8;
        ctx.strokeRect(rx + 1, ry + 1, rw - 2, rh - 2);
      }

      // Zero-Clip Room Typography + Micro-Icon Badge
      const labelPadX = Math.max(7, scale * 0.42);
      const showIconBadge = !isAtrium && scale >= 15 && rw >= 95;
      const badgeSize = showIconBadge ? 18 : 0;
      const badgeGap = showIconBadge ? 7 : 0;
      const textStartX = rx + labelPadX + badgeSize + badgeGap;
      const maxLabelW = Math.max(24, rw - labelPadX * 2 - badgeSize - badgeGap);
      const baseLabelFont = Math.max(9.5, Math.min(13, scale * 0.41));
      const codeFontSize = Math.max(8, Math.min(10, scale * 0.3));

      if (isAtrium) {
        const atriumFont = Math.max(8, Math.min(10, scale * 0.31));
        ctx.font = `700 ${atriumFont}px "JetBrains Mono", monospace`;
        const atriumTitle = 'CENTRAL ATRIUM';
        const tw = ctx.measureText(atriumTitle).width;
        const tx = rx + rw / 2;
        const ty = ry + Math.max(13, scale * 0.54);
        ctx.fillStyle = 'rgba(148, 163, 184, 0.78)';
        ctx.textAlign = 'center';
        ctx.save();
        ctx.translate(tx, ty);
        ctx.scale(1, labelYScale);
        ctx.fillText(atriumTitle, 0, 0, maxLabelW);
        ctx.restore();
        ctx.textAlign = 'left';
        occupiedLabels.push({
          x: tx - Math.min(tw, maxLabelW) / 2 - 2,
          y: ty - atriumFont,
          w: Math.min(tw, maxLabelW) + 4,
          h: atriumFont + 4,
        });
      } else {
        const labelPadY =
          r.id === 'room_105'
            ? Math.max(24, scale * 1.38)
            : Math.max(16, scale * 0.8);
        ctx.font = `600 ${baseLabelFont}px "Plus Jakarta Sans", system-ui, sans-serif`;

        let lines: string[] = [r.name];
        let actualFont = baseLabelFont;
        const measuredFull = ctx.measureText(r.name).width;
        if (measuredFull > maxLabelW) {
          const words = r.name.split(' ');
          if (words.length >= 2 && r.h >= 5) {
            const splitIdx = Math.ceil(words.length / 2);
            const l1 = words.slice(0, splitIdx).join(' ');
            const l2 = words.slice(splitIdx).join(' ');
            const widest = Math.max(ctx.measureText(l1).width, ctx.measureText(l2).width);
            if (widest > maxLabelW) {
              actualFont = Math.max(8, baseLabelFont * (maxLabelW / widest) * 0.94);
            }
            lines = [l1, l2];
          } else {
            actualFont = Math.max(8, baseLabelFont * (maxLabelW / measuredFull) * 0.94);
          }
        }

        if (showIconBadge && accent) {
          const badgeX = rx + labelPadX;
          const badgeY = ry + labelPadY - actualFont * 0.92;
          ctx.fillStyle = accent.badgeBg;
          ctx.beginPath();
          ctx.roundRect(badgeX, badgeY, badgeSize, badgeSize, 5);
          ctx.fill();
          ctx.strokeStyle = `${accent.stroke}55`;
          ctx.lineWidth = 1;
          ctx.stroke();
          drawRoomMicroIcon(r.id, badgeX + badgeSize / 2, badgeY + badgeSize / 2, accent.stroke);
        }

        ctx.fillStyle = isRoomTarget ? '#7DD3FC' : '#E2E8F0';
        ctx.font = `600 ${actualFont}px "Plus Jakarta Sans", system-ui, sans-serif`;

        let maxLineW = 0;
        lines.forEach((line, idx) => {
          const ly = ry + labelPadY + idx * (actualFont + 2);
          ctx.save();
          ctx.translate(textStartX, ly);
          ctx.scale(1, labelYScale);
          ctx.fillText(line, 0, 0, maxLabelW);
          ctx.restore();
          maxLineW = Math.max(maxLineW, Math.min(maxLabelW, ctx.measureText(line).width));
        });

        const code = ROOM_CODES[r.id];
        let totalTextH = lines.length * (actualFont + 2);
        if (code && scale >= 13) {
          ctx.fillStyle = '#64748B';
          ctx.font = `500 ${codeFontSize}px "JetBrains Mono", monospace`;
          const codeY = ry + labelPadY + lines.length * (actualFont + 2) + 2;
          ctx.save();
          ctx.translate(textStartX, codeY);
          ctx.scale(1, labelYScale);
          ctx.fillText(`RM ${code}`, 0, 0, maxLabelW);
          ctx.restore();
          totalTextH += codeFontSize + 5;
        }

        occupiedLabels.push({
          x: rx + labelPadX - 2,
          y: ry + labelPadY - actualFont - 1,
          w: badgeSize + badgeGap + maxLineW + 6,
          h: Math.max(badgeSize, totalTextH) + 4,
        });
      }
    });

    // 4. Open Doorway Floor Thresholds, Jamb Caps & CAD Door-Swing Arcs
    FLOOR_ROOMS.forEach((r) => {
      const rx = wx(r.x);
      const ry = wy(r.y);
      const rw = r.w * scale;
      const rh = r.h * scale;
      const isAtrium = r.id === 'corr_center';

      r.doors.forEach((d) => {
        const doorLenPx = (d.end - d.start) * scale;
        const swingR = Math.min(doorLenPx * 0.56, scale * 1.18);

        // Doorway threshold floor strip matching corridor terrazzo
        ctx.strokeStyle = '#182235';
        ctx.lineWidth = Math.max(5, scale * 0.25);
        ctx.beginPath();
        if (d.side === 'top') {
          ctx.moveTo(wx(r.x + d.start), ry);
          ctx.lineTo(wx(r.x + d.end), ry);
        } else if (d.side === 'bottom') {
          ctx.moveTo(wx(r.x + d.start), ry + rh);
          ctx.lineTo(wx(r.x + d.end), ry + rh);
        } else if (d.side === 'left') {
          ctx.moveTo(rx, wy(r.y + d.start));
          ctx.lineTo(rx, wy(r.y + d.end));
        } else {
          ctx.moveTo(rx + rw, wy(r.y + d.start));
          ctx.lineTo(rx + rw, wy(r.y + d.end));
        }
        ctx.stroke();

        // Crisp threshold guide line
        ctx.strokeStyle = isAtrium ? 'rgba(56, 189, 248, 0.45)' : 'rgba(56, 189, 248, 0.34)';
        ctx.lineWidth = Math.max(1.2, scale * 0.05);
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        if (d.side === 'top') {
          ctx.moveTo(wx(r.x + d.start), ry);
          ctx.lineTo(wx(r.x + d.end), ry);
        } else if (d.side === 'bottom') {
          ctx.moveTo(wx(r.x + d.start), ry + rh);
          ctx.lineTo(wx(r.x + d.end), ry + rh);
        } else if (d.side === 'left') {
          ctx.moveTo(rx, wy(r.y + d.start));
          ctx.lineTo(rx, wy(r.y + d.end));
        } else {
          ctx.moveTo(rx + rw, wy(r.y + d.start));
          ctx.lineTo(rx + rw, wy(r.y + d.end));
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Architectural CAD inward door swing arc + jamb caps
        if (!isAtrium && scale >= 12) {
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.32)';
          ctx.lineWidth = 1.15;
          ctx.beginPath();
          if (d.side === 'top') {
            const hx = wx(r.x + d.start);
            ctx.moveTo(hx, ry);
            ctx.lineTo(hx, ry + swingR);
            ctx.arc(hx, ry, swingR, Math.PI / 2, 0, true);
          } else if (d.side === 'bottom') {
            const hx = wx(r.x + d.start);
            ctx.moveTo(hx, ry + rh);
            ctx.lineTo(hx, ry + rh - swingR);
            ctx.arc(hx, ry + rh, swingR, -Math.PI / 2, 0, false);
          } else if (d.side === 'left') {
            const hy = wy(r.y + d.start);
            ctx.moveTo(rx, hy);
            ctx.lineTo(rx + swingR, hy);
            ctx.arc(rx, hy, swingR, 0, Math.PI / 2, false);
          } else {
            const hy = wy(r.y + d.start);
            ctx.moveTo(rx + rw, hy);
            ctx.lineTo(rx + rw - swingR, hy);
            ctx.arc(rx + rw, hy, swingR, Math.PI, Math.PI / 2, true);
          }
          ctx.stroke();

          ctx.fillStyle = '#94A3B8';
          const jSize = 2.6;
          if (d.side === 'top' || d.side === 'bottom') {
            const jy = d.side === 'top' ? ry : ry + rh;
            ctx.fillRect(wx(r.x + d.start) - jSize / 2, jy - jSize / 2, jSize, jSize);
            ctx.fillRect(wx(r.x + d.end) - jSize / 2, jy - jSize / 2, jSize, jSize);
          } else {
            const jx = d.side === 'left' ? rx : rx + rw;
            ctx.fillRect(jx - jSize / 2, wy(r.y + d.start) - jSize / 2, jSize, jSize);
            ctx.fillRect(jx - jSize / 2, wy(r.y + d.end) - jSize / 2, jSize, jSize);
          }
        }
      });
    });

    // 5. Crisp Structural Partition Walls + Bevel Highlight
    ctx.lineCap = 'square';
    FLOOR_WALL_SEGMENTS.forEach((w, idx) => {
      const isOuter = idx < 4;
      ctx.strokeStyle = isOuter ? '#7C93B0' : '#566F91';
      ctx.lineWidth = isOuter ? Math.max(3.6, scale * 0.19) : Math.max(2.4, scale * 0.13);
      ctx.beginPath();
      ctx.moveTo(wx(w.x1), wy(w.y1));
      ctx.lineTo(wx(w.x2), wy(w.y2));
      ctx.stroke();

      if (scale >= 14) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(wx(w.x1), wy(w.y1));
        ctx.lineTo(wx(w.x2), wy(w.y2));
        ctx.stroke();
      }
    });

    ctx.restore(); // Release building footprint clip

    // Crisp outer perimeter frame shell + inner architectural bevel
    ctx.strokeStyle = '#879DBB';
    ctx.lineWidth = Math.max(3.4, scale * 0.18);
    ctx.strokeRect(bx, by, bw, bh);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.11)';
    ctx.lineWidth = 1;
    ctx.strokeRect(bx + 1.5, by + 1.5, Math.max(1, bw - 3), Math.max(1, bh - 3));

    // 6. Luminous Next-Gen A* Wayfinding Path + Travelling Directional Chevrons
    if (activeRoute && activeRoute.pathCoordinates.length > 1) {
      const coords = activeRoute.pathCoordinates;

      // Layer A: Soft luminous outer cyan glow
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.25)';
      ctx.lineWidth = Math.max(10.5, scale * 0.44);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(wx(coords[0].x), wy(coords[0].y));
      coords.forEach((c) => ctx.lineTo(wx(c.x), wy(c.y)));
      ctx.stroke();

      // Layer B: Dark contrast casing separating route cleanly from floor geometry
      ctx.strokeStyle = '#070C16';
      ctx.lineWidth = Math.max(5.0, scale * 0.23);
      ctx.beginPath();
      ctx.moveTo(wx(coords[0].x), wy(coords[0].y));
      coords.forEach((c) => ctx.lineTo(wx(c.x), wy(c.y)));
      ctx.stroke();

      // Layer C: Luminous solid core + gentle travelling energy pulse
      ctx.strokeStyle = '#0EA5E9';
      ctx.lineWidth = Math.max(2.8, scale * 0.13);
      ctx.beginPath();
      ctx.moveTo(wx(coords[0].x), wy(coords[0].y));
      coords.forEach((c) => ctx.lineTo(wx(c.x), wy(c.y)));
      ctx.stroke();

      ctx.strokeStyle = '#7DD3FC';
      ctx.lineWidth = Math.max(2.0, scale * 0.09);
      ctx.setLineDash([12, 18]);
      ctx.lineDashOffset = -pulseAnim * 30;
      ctx.beginPath();
      ctx.moveTo(wx(coords[0].x), wy(coords[0].y));
      coords.forEach((c) => ctx.lineTo(wx(c.x), wy(c.y)));
      ctx.stroke();
      ctx.setLineDash([]);

      // Forward sliding directional chevron arrowheads along segments
      const chevronSpacingM = 2.6;
      const chevronSize = Math.max(4.6, Math.min(7.5, scale * 0.23));
      ctx.strokeStyle = '#F0F9FF';
      ctx.lineWidth = Math.max(1.7, scale * 0.075);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (let i = 0; i < coords.length - 1; i++) {
        const ax = coords[i].x;
        const ay = coords[i].y;
        const dx = coords[i + 1].x - ax;
        const dy = coords[i + 1].y - ay;
        const segLen = Math.hypot(dx, dy);
        if (segLen < 1.5) continue;

        const angle = Math.atan2(dy, dx);
        const count = Math.max(1, Math.floor(segLen / chevronSpacingM));
        for (let k = 0; k < count; k++) {
          const frac = (k + pulseAnim) / count;
          if (frac <= 0.12 || frac >= 0.9) continue;
          const cx = wx(ax + dx * frac);
          const cy = wy(ay + dy * frac);

          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(angle);
          ctx.beginPath();
          ctx.moveTo(-chevronSize * 0.65, -chevronSize * 0.65);
          ctx.lineTo(chevronSize * 0.45, 0);
          ctx.lineTo(-chevronSize * 0.65, chevronSize * 0.65);
          ctx.stroke();
          ctx.restore();
        }
      }

      // Clean corridor/doorway turn-node joints
      for (let i = 1; i < coords.length - 1; i++) {
        const turnX = wx(coords[i].x);
        const turnY = wy(coords[i].y);
        ctx.fillStyle = '#070C16';
        ctx.beginPath();
        ctx.arc(turnX, turnY, Math.max(3.6, scale * 0.15), 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#7DD3FC';
        ctx.lineWidth = 1.8;
        ctx.stroke();
      }
    }

    // Destination beacon ring (Room or Peer arrival pulse)
    if (activeTarget) {
      const tx = wx(activeTarget.coords.x);
      const ty = wy(activeTarget.coords.y);
      ctx.strokeStyle = activeTarget.isPeer
        ? `rgba(245, 158, 11, ${0.42 * (1 - pulseAnim)})`
        : `rgba(56, 189, 248, ${0.8 * (1 - pulseAnim)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(tx, ty, 10 + pulseAnim * 20, 0, Math.PI * 2);
      ctx.stroke();

      if (targetRoomId && !activeTarget.isPeer) {
        ctx.fillStyle = '#38BDF8';
        ctx.beginPath();
        ctx.arc(tx, ty, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
    }

    // 6.5 Subtle Hardware BLE Beacon Nodes (Always visible for spatial trilateration clarity)
    beacons.forEach((b, idx) => {
      const bxPos = wx(b.x);
      const byPos = wy(b.y);
      const dSize = Math.max(4.5, scale * 0.17);
      const beaconPulse = (pulseAnim + idx * 0.25) % 1;

      // Subtle pulsing BLE broadcast ring
      ctx.strokeStyle = `rgba(56, 189, 248, ${(isSimulating || isTelemetryOpen ? 0.48 : 0.26) * (1 - beaconPulse)})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(bxPos, byPos, dSize + 2 + beaconPulse * (isSimulating ? 15 : 10), 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = '#090E1A';
      ctx.strokeStyle = isSimulating || isTelemetryOpen ? 'rgba(56, 189, 248, 0.9)' : 'rgba(56, 189, 248, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(bxPos, byPos - dSize);
      ctx.lineTo(bxPos + dSize, byPos);
      ctx.lineTo(bxPos, byPos + dSize);
      ctx.lineTo(bxPos - dSize, byPos);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#38BDF8';
      ctx.beginPath();
      ctx.arc(bxPos, byPos, 1.8, 0, Math.PI * 2);
      ctx.fill();

      if (scale >= 14) {
        ctx.fillStyle = isSimulating || isTelemetryOpen ? 'rgba(125, 211, 252, 0.9)' : 'rgba(125, 211, 252, 0.55)';
        ctx.font = '600 9px "JetBrains Mono", monospace';
        ctx.save();
        ctx.translate(bxPos + dSize + 4, byPos + 3);
        ctx.scale(1, labelYScale);
        ctx.fillText(b.id, 0, 0);
        ctx.restore();
      }
    });

    // Camera Focus Highlight Ripple when selecting user from list or dropdown
    const focusFx = focusHighlightRef.current;
    if (focusFx) {
      const remainingMs = focusFx.until - Date.now();
      if (remainingMs <= 0) {
        focusHighlightRef.current = null;
      } else {
        const progress = 1 - remainingMs / 1600;
        ctx.strokeStyle = focusFx.color;
        ctx.globalAlpha = Math.max(0, 0.85 * (1 - progress));
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.arc(wx(focusFx.x), wy(focusFx.y), 14 + progress * 34, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // 7. Current User Position Radar Puck & Directional Heading Cone
    const ux = wx(userPose.x);
    const uy = wy(userPose.y);

    ctx.fillStyle = 'rgba(59, 130, 246, 0.1)';
    ctx.beginPath();
    ctx.arc(ux, uy, userPose.accuracy * scale, 0, Math.PI * 2);
    ctx.fill();

    const headingRad = ((userPose.heading - 90) * Math.PI) / 180;
    const coneRadius = Math.max(40, scale * 1.75);
    const coneGrad = ctx.createRadialGradient(ux, uy, 4, ux, uy, coneRadius);
    coneGrad.addColorStop(0, 'rgba(59, 130, 246, 0.48)');
    coneGrad.addColorStop(1, 'rgba(59, 130, 246, 0.02)');
    ctx.fillStyle = coneGrad;
    ctx.beginPath();
    ctx.moveTo(ux, uy);
    ctx.arc(ux, uy, coneRadius, headingRad - 0.44, headingRad + 0.44);
    ctx.closePath();
    ctx.fill();

    const isWallBlocked = Date.now() < wallHitUntilRef.current;

    ctx.strokeStyle = isWallBlocked
      ? 'rgba(244, 63, 94, 0.9)'
      : `rgba(59, 130, 246, ${0.85 * (1 - pulseAnim)})`;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(ux, uy, 9 + pulseAnim * 21, 0, Math.PI * 2);
    ctx.stroke();

    const youAvatar = currentUser.avatarUrl
      ? avatarImagesRef.current.get(currentUser.avatarUrl)
      : undefined;
    const youPinR = youAvatar instanceof HTMLImageElement ? 12 : 8.5;

    if (youAvatar instanceof HTMLImageElement) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(ux, uy, youPinR, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(youAvatar, ux - youPinR, uy - youPinR, youPinR * 2, youPinR * 2);
      ctx.restore();

      ctx.strokeStyle = isWallBlocked ? '#F43F5E' : '#3B82F6';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(ux, uy, youPinR, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(ux, uy, youPinR + 1.5, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.fillStyle = isWallBlocked ? '#F43F5E' : '#3B82F6';
      ctx.beginPath();
      ctx.arc(ux, uy, youPinR, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    occupiedLabels.push({
      x: ux - youPinR - 2,
      y: uy - youPinR - 2,
      w: (youPinR + 2) * 2,
      h: (youPinR + 2) * 2,
    });

    const youText = presenceProfile ? `You · ${getShortPersonLabel(presenceProfile.name)}` : 'You';
    ctx.font = '700 10.5px "Plus Jakarta Sans", system-ui, sans-serif';
    const youBoxW = ctx.measureText(youText).width + 14;
    const youBoxH = 20;
    const youRect = placeNonOverlappingLabel(
      ux,
      uy,
      youPinR,
      youBoxW,
      youBoxH,
      viewW,
      viewH,
      occupiedLabels,
      ['below', 'above', 'left', 'right']
    );

    ctx.save();
    ctx.translate(youRect.x + youRect.w / 2, youRect.y + youRect.h / 2);
    ctx.scale(1, labelYScale);
    ctx.fillStyle = 'rgba(30, 58, 138, 0.96)';
    ctx.beginPath();
    ctx.roundRect(-youRect.w / 2, -youRect.h / 2, youRect.w, youRect.h, 6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(147, 197, 253, 0.9)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(youText, -youRect.w / 2 + 7, -youRect.h / 2 + 13.5);
    ctx.restore();

    // 7.5 Live Connected Users (Vibrant High-Contrast Pins + LIVE Emerald Indicator)
    liveUsers.forEach((lu) => {
      const lx = wx(lu.x);
      const ly = wy(lu.y);
      const isTarget = targetLiveUserId === lu.id;

      ctx.fillStyle = `${lu.color}30`;
      ctx.beginPath();
      ctx.arc(lx, ly, isTarget ? 16 + pulseAnim * 12 : 14, 0, Math.PI * 2);
      ctx.fill();

      if (isTarget) {
        ctx.strokeStyle = lu.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(lx, ly, 10 + pulseAnim * 20, 0, Math.PI * 2);
        ctx.stroke();
      }

      const luAvatar = lu.avatarUrl ? avatarImagesRef.current.get(lu.avatarUrl) : undefined;
      const luPinR = luAvatar instanceof HTMLImageElement ? 11.5 : 8;
      if (luAvatar instanceof HTMLImageElement) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(lx, ly, luPinR, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(luAvatar, lx - luPinR, ly - luPinR, luPinR * 2, luPinR * 2);
        ctx.restore();

        ctx.strokeStyle = isTarget ? '#FFFFFF' : lu.color;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(lx, ly, luPinR, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = lu.color;
        ctx.beginPath();
        ctx.arc(lx, ly, luPinR, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }

      occupiedLabels.push({
        x: lx - luPinR - 1,
        y: ly - luPinR - 1,
        w: (luPinR + 1) * 2,
        h: (luPinR + 1) * 2,
      });

      const tagText = lu.name;
      ctx.font = '600 11px "Plus Jakarta Sans", system-ui, sans-serif';
      const pillW = ctx.measureText(tagText).width + 24;
      const pillH = 22;
      const pillRect = placeNonOverlappingLabel(
        lx,
        ly,
        luPinR,
        pillW,
        pillH,
        viewW,
        viewH,
        occupiedLabels,
        ['above', 'right', 'left', 'below']
      );

      ctx.save();
      ctx.translate(pillRect.x + pillRect.w / 2, pillRect.y + pillRect.h / 2);
      ctx.scale(1, labelYScale);
      ctx.fillStyle = 'rgba(17, 22, 34, 0.96)';
      ctx.beginPath();
      ctx.roundRect(-pillRect.w / 2, -pillRect.h / 2, pillRect.w, pillRect.h, 6);
      ctx.fill();
      ctx.strokeStyle = isTarget ? '#FFFFFF' : `${lu.color}D0`;
      ctx.lineWidth = 1.25;
      ctx.stroke();

      // Emerald LIVE dot inside tag
      ctx.fillStyle = '#34D399';
      ctx.beginPath();
      ctx.arc(-pillRect.w / 2 + 8.5, 0, 2.7, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#F8FAFC';
      ctx.fillText(tagText, -pillRect.w / 2 + 15, -pillRect.h / 2 + 14.5);
      ctx.restore();
    });

    // 7.6 Building Demo Bots (Subtly Muted unless Targeted)
    displayedDemoBots.forEach((peer) => {
      const px = wx(peer.x);
      const py = wy(peer.y);
      const isTarget = targetPeerId === peer.id;

      if (isTarget) {
        ctx.strokeStyle = `rgba(245, 158, 11, ${0.85 * (1 - pulseAnim)})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(px, py, 9 + pulseAnim * 22, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = '#F59E0B';
        ctx.beginPath();
        ctx.arc(px, py, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2.5;
        ctx.stroke();

        const labelText = peer.fullName;
        ctx.font = '600 11px "Plus Jakarta Sans", system-ui, sans-serif';
        const boxW = ctx.measureText(labelText).width + 14;
        const boxH = 22;
        const labelRect = placeNonOverlappingLabel(
          px,
          py,
          8,
          boxW,
          boxH,
          viewW,
          viewH,
          occupiedLabels,
          ['above', 'below', 'left', 'right']
        );

        ctx.save();
        ctx.translate(labelRect.x + labelRect.w / 2, labelRect.y + labelRect.h / 2);
        ctx.scale(1, labelYScale);
        ctx.fillStyle = 'rgba(17, 22, 34, 0.96)';
        ctx.beginPath();
        ctx.roundRect(-labelRect.w / 2, -labelRect.h / 2, labelRect.w, labelRect.h, 6);
        ctx.fill();
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.65)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#FDE68A';
        ctx.fillText(labelText, -labelRect.w / 2 + 7, -labelRect.h / 2 + 14.5);
        ctx.restore();
      } else {
        ctx.fillStyle = '#475569';
        ctx.beginPath();
        ctx.arc(px, py, 4.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#090A0F';
        ctx.lineWidth = 1.8;
        ctx.stroke();

        ctx.font = '500 10px "Plus Jakarta Sans", system-ui, sans-serif';
        const shortName = getShortPersonLabel(peer.fullName);
        const textW = ctx.measureText(shortName).width;
        const peerRect = placeNonOverlappingLabel(
          px,
          py,
          5,
          textW + 4,
          14,
          viewW,
          viewH,
          occupiedLabels,
          ['below', 'above', 'right', 'left']
        );
        ctx.save();
        ctx.translate(peerRect.x + 2, peerRect.y + 11);
        ctx.scale(1, labelYScale);
        ctx.fillStyle = 'rgba(148, 163, 184, 0.62)';
        ctx.fillText(shortName, 0, 0);
        ctx.restore();
      }
    });

    // 7.7 Raw Jitter vs. 1D Kalman Trilateration Comparison Overlay (Simulation)
    if (isSimulating && rawTrilatPose && kalmanTrilatPose) {
      const rxRaw = wx(rawTrilatPose.x);
      const ryRaw = wy(rawTrilatPose.y);
      const kxEst = wx(kalmanTrilatPose.x);
      const kyEst = wy(kalmanTrilatPose.y);

      ctx.strokeStyle = 'rgba(251, 146, 60, 0.45)';
      ctx.lineWidth = 1.25;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(rxRaw, ryRaw);
      ctx.lineTo(kxEst, kyEst);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.strokeStyle = 'rgba(251, 146, 60, 0.9)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(rxRaw, ryRaw, 4.5, 0, Math.PI * 2);
      ctx.moveTo(rxRaw - 6, ryRaw);
      ctx.lineTo(rxRaw + 6, ryRaw);
      ctx.moveTo(rxRaw, ryRaw - 6);
      ctx.lineTo(rxRaw, ryRaw + 6);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(34, 211, 238, 0.85)';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(kxEst, kyEst, 11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 8. Architectural 5m Scale Bar + North Arrow (bottom-left)
    const scaleX = 16;
    const scaleY = viewH - 16;
    const scaleLen = 5 * scale;
    if (scaleLen <= viewW * 0.45) {
      const northX = scaleX + 7;
      const northY = scaleY - 22;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
      ctx.fillStyle = 'rgba(56, 189, 248, 0.85)';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(northX, northY - 7);
      ctx.lineTo(northX - 4, northY + 2);
      ctx.lineTo(northX, northY);
      ctx.lineTo(northX + 4, northY + 2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#94A3B8';
      ctx.font = '600 9.5px "JetBrains Mono", monospace';
      ctx.fillText('N', northX + 8, northY + 1);

      ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(scaleX, scaleY - 4);
      ctx.lineTo(scaleX, scaleY);
      ctx.lineTo(scaleX + scaleLen, scaleY);
      ctx.lineTo(scaleX + scaleLen, scaleY - 4);
      ctx.stroke();
      ctx.fillStyle = '#64748B';
      ctx.font = '500 10px "JetBrains Mono", monospace';
      ctx.fillText('5 m', scaleX + scaleLen + 6, scaleY + 1);
    }

    ctx.restore();
  }, [
    viewportSize,
    camera,
    is25DMode,
    userPose,
    activeRoute,
    displayedDemoBots,
    liveUsers,
    presenceProfile,
    currentUser.avatarUrl,
    avatarLoadTick,
    targetPeerId,
    targetLiveUserId,
    targetRoomId,
    activeTarget,
    pulseAnim,
    isSimulating,
    isTelemetryOpen,
    beacons,
    rawTrilatPose,
    kalmanTrilatPose,
  ]);

  // Select live user / peer / room OR set laptop coordinate from canvas click coordinates (2D & 2.5D safe)
  const selectMapTargetAtClientPoint = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const screenX = ((clientX - rect.left) / Math.max(1, rect.width)) * viewportSize.width;
      const screenY = ((clientY - rect.top) / Math.max(1, rect.height)) * viewportSize.height;
      const meterX = (screenX - camera.panX) / camera.scale;
      const meterY = (screenY - camera.panY) / camera.scale;

      if (!isSpotPickerActive) {
        const clickedLiveUser = liveUsers.find((u) => Math.hypot(u.x - meterX, u.y - meterY) < 1.8);
        if (clickedLiveUser) {
          setTargetLiveUserId(clickedLiveUser.id);
          setTargetPeerId(null);
          setTargetRoomId(null);
          return;
        }

        if (showDemoBots) {
          const clickedPeer = peers.find((p) => Math.hypot(p.x - meterX, p.y - meterY) < 1.8);
          if (clickedPeer) {
            setTargetPeerId(clickedPeer.id);
            setTargetLiveUserId(null);
            setTargetRoomId(null);
            return;
          }
        }

        const clickedRoom = nodes.find(
          (n) => Math.hypot(n.x - meterX, n.y - meterY) < 2.2 && n.type === 'room'
        );
        if (clickedRoom) {
          setTargetRoomId(clickedRoom.id);
          setTargetPeerId(null);
          setTargetLiveUserId(null);
          return;
        }
      }

      // Laptop spot placement (or explicit Relocate Spot mode): click anywhere on the floor plan
      if (
        (isSpotPickerActive || (deviceType === 'laptop' && !isSimulating)) &&
        meterX >= WORLD_BOUNDS.minX + 0.45 &&
        meterX <= WORLD_BOUNDS.maxX - 0.45 &&
        meterY >= WORLD_BOUNDS.minY + 0.45 &&
        meterY <= WORLD_BOUNDS.maxY - 0.45
      ) {
        const clampedX = Number(meterX.toFixed(2));
        const clampedY = Number(meterY.toFixed(2));
        setUserPose((prev) => ({
          ...prev,
          x: clampedX,
          y: clampedY,
        }));
        setIsSpotPickerActive(false);
      }
    },
    [
      camera,
      viewportSize.width,
      viewportSize.height,
      isSpotPickerActive,
      liveUsers,
      showDemoBots,
      peers,
      nodes,
      deviceType,
      isSimulating,
    ]
  );

  // Mouse pan & click handlers
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    cancelCameraAnimation();
    pointerStateRef.current.isDragging = true;
    pointerStateRef.current.movedPx = 0;
    pointerStateRef.current.startX = e.clientX;
    pointerStateRef.current.startY = e.clientY;
    pointerStateRef.current.origPanX = camera.panX;
    pointerStateRef.current.origPanY = camera.panY;
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const st = pointerStateRef.current;
    if (!st.isDragging) return;
    const dx = e.clientX - st.startX;
    const dy = e.clientY - st.startY;
    st.movedPx = Math.max(st.movedPx, Math.hypot(dx, dy));
    if (!isManualCameraRef.current) return;
    setCamera((prev) =>
      clampCameraPan(
        {
          ...prev,
          panX: st.origPanX + dx,
          panY: st.origPanY + dy,
        },
        viewportSize.width,
        viewportSize.height
      )
    );
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const st = pointerStateRef.current;
    if (!st.isDragging) return;
    st.isDragging = false;
    if (st.movedPx < 6) {
      selectMapTargetAtClientPoint(e.clientX, e.clientY);
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const fx = e.clientX - rect.left;
    const fy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    zoomBy(factor, fx, fy);
  };

  // Touch single-finger pan (when zoomed in) + two-finger pinch zoom handlers
  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    cancelCameraAnimation();
    const st = pointerStateRef.current;
    if (e.touches.length === 1) {
      const t = e.touches[0];
      st.isDragging = true;
      st.pinchDist = null;
      st.movedPx = 0;
      st.startX = t.clientX;
      st.startY = t.clientY;
      st.origPanX = camera.panX;
      st.origPanY = camera.panY;
    } else if (e.touches.length === 2) {
      const [t1, t2] = [e.touches[0], e.touches[1]];
      const rect = e.currentTarget.getBoundingClientRect();
      st.isDragging = false;
      st.movedPx = 999;
      st.pinchDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      st.pinchMidX = (t1.clientX + t2.clientX) / 2 - rect.left;
      st.pinchMidY = (t1.clientY + t2.clientY) / 2 - rect.top;
      st.origScale = camera.scale;
      st.origPanX = camera.panX;
      st.origPanY = camera.panY;
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    const st = pointerStateRef.current;
    if (e.touches.length === 1 && st.isDragging) {
      const t = e.touches[0];
      const dx = t.clientX - st.startX;
      const dy = t.clientY - st.startY;
      st.movedPx = Math.max(st.movedPx, Math.hypot(dx, dy));
      if (!isManualCameraRef.current) return;
      setCamera((prev) =>
        clampCameraPan(
          {
            ...prev,
            panX: st.origPanX + dx,
            panY: st.origPanY + dy,
          },
          viewportSize.width,
          viewportSize.height
        )
      );
    } else if (e.touches.length === 2 && st.pinchDist && st.pinchDist > 0) {
      const [t1, t2] = [e.touches[0], e.touches[1]];
      const fit = computeFitCamera(viewportSize.width, viewportSize.height);
      const nextDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const ratio = nextDist / st.pinchDist;
      const nextScale = Math.max(fit.scale, Math.min(72, st.origScale * ratio));
      if (nextScale <= fit.scale * 1.03) {
        isManualCameraRef.current = false;
        setCamera(fit);
        return;
      }
      isManualCameraRef.current = true;
      const worldX = (st.pinchMidX - st.origPanX) / st.origScale;
      const worldY = (st.pinchMidY - st.origPanY) / st.origScale;
      setCamera(
        clampCameraPan(
          {
            scale: nextScale,
            panX: st.pinchMidX - worldX * nextScale,
            panY: st.pinchMidY - worldY * nextScale,
          },
          viewportSize.width,
          viewportSize.height
        )
      );
    }
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLCanvasElement>) => {
    const st = pointerStateRef.current;
    if (e.touches.length === 0) {
      if (st.isDragging && st.movedPx < 8 && e.changedTouches[0]) {
        selectMapTargetAtClientPoint(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
      }
      st.isDragging = false;
      st.pinchDist = null;
    }
  };

  const firstName = currentUser.name.trim().split(/\s+/)[0] || 'Navigator';
  const totalLiveOnlineCount = (presenceProfile ? 1 : 0) + liveUsers.length;
  const totalDirectoryPeopleCount = liveUsers.length + (showDemoBots ? peers.length : 0);
  const onlinePeersCount = liveUsers.length + (showDemoBots ? peers.filter((p) => p.isOnline).length : 0);
  const positioningMode: 'Simulation' | 'Hardware BLE' | 'PDR Sensors' = isSimulating
    ? 'Simulation'
    : bleState === 'connected'
      ? 'Hardware BLE'
      : 'PDR Sensors';
  const routeEtaSeconds = Math.max(1, Math.round(remainingDistanceMeters / 1.15));
  const estimatedRouteSteps =
    remainingDistanceMeters <= 0.4 ? 0 : Math.max(1, Math.round(remainingDistanceMeters / 0.72));
  const showBleAutoSuggestion =
    !isSimulating &&
    bleState !== 'connected' &&
    !bleSuggestionDismissed &&
    (bleState === 'unsupported' || bleState === 'denied');

  const handleJoinMapSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = joinNameInput.trim();
    if (!clean) return;
    const profile: SavedPresenceProfile = {
      name: clean,
      color: presenceProfile?.color || pickAvatarColor(`${clean}_${localPresenceTabId}`),
    };
    savePresenceProfile(profile);
    setPresenceProfile(profile);
    setIsJoinPromptOpen(false);
  };

  // Reusable Directory List Content (shared between Desktop Left Sidebar & Mobile Bottom Sheet)
  const renderDirectoryList = (isMobileSheet: boolean) => (
    <>
      <div className="space-y-3">
        <div className="relative">
          <Search
            className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <input
            type="text"
            value={directorySearch}
            onChange={(e) => setDirectorySearch(e.target.value)}
            placeholder="Search people or rooms..."
            aria-label="Search people or rooms"
            className="w-full min-h-[44px] bg-[#0D121D] border border-white/[0.08] focus:border-sky-400 rounded-xl pl-10 pr-3.5 py-2 text-xs text-white placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          />
        </div>

        <div
          role="tablist"
          aria-label="Directory category"
          className="grid grid-cols-2 p-1 rounded-xl bg-[#0D121D] border border-white/[0.08]"
        >
          <button
            type="button"
            role="tab"
            aria-selected={directoryTab === 'people'}
            onClick={() => setDirectoryTab('people')}
            className={`min-h-[44px] rounded-lg text-xs font-semibold transition-colors ${
              directoryTab === 'people'
                ? 'bg-sky-400 text-slate-950'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            People ({totalDirectoryPeopleCount})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={directoryTab === 'rooms'}
            onClick={() => setDirectoryTab('rooms')}
            className={`min-h-[44px] rounded-lg text-xs font-semibold transition-colors ${
              directoryTab === 'rooms'
                ? 'bg-sky-400 text-slate-950'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Rooms ({roomDestinations.length})
          </button>
        </div>

        {directoryTab === 'people' && (
          <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-[#0D121D] border border-white/[0.08]">
            <span className="text-xs text-slate-300 font-medium">Demo Bots</span>
            <button
              type="button"
              role="switch"
              aria-checked={showDemoBots}
              onClick={() => setShowDemoBots((prev) => !prev)}
              className={`min-h-[34px] px-2.5 rounded-lg text-[11px] font-mono font-semibold border transition-colors ${
                showDemoBots
                  ? 'bg-sky-400/15 text-sky-300 border-sky-400/40'
                  : 'bg-[#141B2B] text-slate-400 border-white/[0.08]'
              }`}
            >
              {showDemoBots ? 'ON' : 'OFF'}
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto pt-3 space-y-2">
        {directoryTab === 'people' ? (
          filteredLiveUsers.length === 0 && filteredPeers.length === 0 ? (
            <p className="text-xs text-slate-500 text-center py-8">
              {showDemoBots
                ? 'No matching users found.'
                : 'No other live users connected yet. Toggle Demo Bots ON or open a second tab.'}
            </p>
          ) : (
            <>
              {filteredLiveUsers.map((lu) => {
                const distance =
                  walkableDistancesById.get(lu.id) ??
                  Math.hypot(lu.x - userPose.x, lu.y - userPose.y);
                const isTarget = targetLiveUserId === lu.id;

                return (
                  <button
                    key={lu.id}
                    type="button"
                      onClick={() => {
                      if (isTarget) {
                        setTargetLiveUserId(null);
                      } else {
                        setTargetLiveUserId(lu.id);
                        setTargetPeerId(null);
                        setTargetRoomId(null);
                        focusMapOnPoint(lu.x, lu.y, lu.color);
                      }
                      if (isMobileSheet) setIsMobileSheetOpen(false);
                    }}
                    className={`w-full text-left p-3 rounded-xl border transition-colors flex items-center justify-between gap-3 min-h-[60px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                      isTarget
                        ? 'bg-emerald-500/12 border-emerald-400/50'
                        : 'bg-[#0D121D] border-white/[0.08] hover:border-white/[0.18] hover:bg-[#141B2B]'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <UserAvatar
                        src={lu.avatarUrl}
                        name={lu.name}
                        className="w-9 h-9 rounded-lg text-xs shrink-0"
                        style={{
                          backgroundColor: `${lu.color}25`,
                          color: lu.color,
                          border: `1px solid ${lu.color}55`,
                        }}
                      />
                      <div className="min-w-0">
                        <div className="font-semibold text-white text-sm truncate flex items-center gap-1.5">
                          <span className="truncate">{lu.name}</span>
                          <span className="text-[10px] font-mono uppercase text-emerald-400 shrink-0">
                            Live
                          </span>
                        </div>
                        <div className="text-xs text-slate-400 truncate capitalize">
                          {lu.device} <span aria-hidden="true">·</span> Real-time position
                        </div>
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <div
                        className={`text-xs font-mono tabular-nums font-semibold ${
                          isTarget ? 'text-emerald-300' : 'text-sky-400'
                        }`}
                      >
                        {distance.toFixed(1)} m
                      </div>
                      <div className="text-[11px] font-medium text-slate-400 mt-0.5">
                        {isTarget ? 'Routing' : 'Route'}
                      </div>
                    </div>
                  </button>
                );
              })}

              {filteredPeers.map((peer) => {
                const distance =
                  walkableDistancesById.get(peer.id) ??
                  Math.hypot(peer.x - userPose.x, peer.y - userPose.y);
                const isTarget = targetPeerId === peer.id;

                return (
                  <button
                    key={peer.id}
                    type="button"
                    onClick={() => {
                      if (isTarget) {
                        setTargetPeerId(null);
                      } else {
                        setTargetPeerId(peer.id);
                        setTargetLiveUserId(null);
                        setTargetRoomId(null);
                        focusMapOnPoint(peer.x, peer.y, '#F59E0B');
                      }
                      if (isMobileSheet) setIsMobileSheetOpen(false);
                    }}
                    className={`w-full text-left p-3 rounded-xl border transition-colors flex items-center justify-between gap-3 min-h-[60px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                      isTarget
                        ? 'bg-amber-500/12 border-amber-400/50'
                        : 'bg-[#0D121D] border-white/[0.06] hover:border-white/[0.16] hover:bg-[#141B2B]'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className="w-9 h-9 rounded-lg flex items-center justify-center font-bold text-xs shrink-0"
                        style={{
                          backgroundColor: `${peer.avatarColor}20`,
                          color: peer.avatarColor,
                          border: `1px solid ${peer.avatarColor}45`,
                        }}
                      >
                        {peer.fullName[0]}
                      </div>
                      <div className="min-w-0">
                        <div className="font-semibold text-white text-sm truncate flex items-center gap-1.5">
                          <span className="truncate">{peer.fullName}</span>
                          <span className="text-[10px] font-mono uppercase text-slate-500 shrink-0">
                            Demo
                          </span>
                        </div>
                        <div className="text-xs text-slate-400 truncate">
                          {peer.department} <span aria-hidden="true">·</span> {peer.role}
                        </div>
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <div
                        className={`text-xs font-mono tabular-nums font-semibold ${
                          isTarget ? 'text-amber-300' : 'text-sky-400'
                        }`}
                      >
                        {distance.toFixed(1)} m
                      </div>
                      <div className="text-[11px] font-medium text-slate-400 mt-0.5">
                        {isTarget ? 'Routing' : 'Route'}
                      </div>
                    </div>
                  </button>
                );
              })}
            </>
          )
        ) : filteredRooms.length === 0 ? (
          <p className="text-xs text-slate-500 text-center py-8">No matching rooms found.</p>
        ) : (
          filteredRooms.map((room) => {
            const distance =
              walkableDistancesById.get(room.id) ??
              Math.hypot(room.x - userPose.x, room.y - userPose.y);
            const isTarget = targetRoomId === room.id;

            return (
              <button
                key={room.id}
                type="button"
                onClick={() => {
                  if (isTarget) {
                    setTargetRoomId(null);
                  } else {
                    setTargetRoomId(room.id);
                    setTargetPeerId(null);
                    setTargetLiveUserId(null);
                    focusMapOnPoint(room.x, room.y, '#38BDF8');
                  }
                  if (isMobileSheet) setIsMobileSheetOpen(false);
                }}
                className={`w-full text-left p-3 rounded-xl border transition-colors flex items-center justify-between gap-3 min-h-[60px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                  isTarget
                    ? 'bg-sky-400/12 border-sky-400/50'
                    : 'bg-[#0D121D] border-white/[0.06] hover:border-white/[0.16] hover:bg-[#141B2B]'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-[#161F33] border border-white/[0.08] flex items-center justify-center text-sky-400 shrink-0">
                    <MapPin className="w-4 h-4" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-semibold text-white text-sm truncate">{room.label}</div>
                    <div className="text-xs text-slate-400 font-mono tabular-nums">
                      Room {ROOM_CODES[room.id] || ''}
                    </div>
                  </div>
                </div>

                <div className="text-right shrink-0">
                  <div className="text-xs font-mono tabular-nums font-semibold text-sky-400">
                    {distance.toFixed(1)} m
                  </div>
                  <div className="text-[11px] font-medium text-slate-400 mt-0.5">
                    {isTarget ? 'Routing' : 'Route'}
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </>
  );

  return (
    <div className="h-[100dvh] w-full bg-[#090A0F] text-slate-100 flex flex-col lg:flex-row font-sans select-none overflow-hidden overflow-x-hidden">
      {/* DESKTOP LEFT WORKSPACE SIDEBAR (lg+) */}
      <aside className="hidden lg:flex lg:w-[340px] lg:shrink-0 flex-col bg-[#111622] border-r border-white/[0.08] p-5 z-20">
        {/* Brand Header */}
        <div className="flex items-center gap-3 pb-4 border-b border-white/[0.08]">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-sky-400 to-blue-500 p-[1.5px] shrink-0">
            <div className="w-full h-full bg-[#111622] rounded-[10px] flex items-center justify-center">
              <Compass className="w-5 h-5 text-sky-400" aria-hidden="true" />
            </div>
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-bold text-white tracking-tight truncate">IndoorNav</h1>
            <p className="text-xs text-slate-400 font-mono tabular-nums">
              Floor 1 <span aria-hidden="true">·</span> {totalLiveOnlineCount} live{' '}
              <span aria-hidden="true">·</span> {displayedDemoBots.length} demo
            </p>
          </div>
        </div>

        {/* Directory Search, Tabs & List */}
        <div className="flex-1 min-h-0 flex flex-col pt-4">{renderDirectoryList(false)}</div>

        {/* User Profile & Sign Out Footer */}
        <div className="pt-4 mt-3 border-t border-white/[0.08] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <UserAvatar
              src={currentUser.avatarUrl}
              name={currentUser.name}
              className="w-8 h-8 rounded-lg bg-sky-400/15 border border-sky-400/30 text-sky-300 text-xs shrink-0"
            />
            <div className="min-w-0">
              <div className="text-xs font-semibold text-white truncate">
                Welcome, {firstName}
              </div>
              <div className="text-[11px] text-slate-400 truncate">{currentUser.role}</div>
            </div>
          </div>

          <button
            type="button"
            onClick={onSignOut}
            className="min-h-[44px] px-3 rounded-xl text-xs font-medium text-slate-300 hover:text-white bg-[#0D121D] hover:bg-slate-800 border border-white/[0.08] transition-colors flex items-center gap-1.5 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            title="Sign Out"
            aria-label="Sign out"
          >
            <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* MOBILE COMPACT TOP BAR (< lg) */}
      <header className="lg:hidden min-h-[56px] px-3 py-1.5 bg-[#111622]/95 border-b border-white/[0.08] backdrop-blur-md flex items-center justify-between gap-1.5 shrink-0 z-30">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-sky-400 to-blue-500 p-[1.5px] shrink-0">
            <div className="w-full h-full bg-[#111622] rounded-[6.5px] flex items-center justify-center">
              <Compass className="w-4 h-4 text-sky-400" aria-hidden="true" />
            </div>
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-bold text-white tracking-tight truncate">IndoorNav</h1>
            <p className="text-[11px] text-slate-400 leading-none mt-0.5 truncate font-mono tabular-nums">
              F1 <span aria-hidden="true">·</span>{' '}
              {positioningMode === 'Simulation' ? 'Sim' : `${totalLiveOnlineCount} live`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={toggleLiveSimulation}
            aria-pressed={isSimulating}
            className={`min-h-[44px] px-2.5 rounded-xl text-xs font-semibold border transition-colors flex items-center gap-1.5 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
              isSimulating
                ? 'bg-sky-400 text-slate-950 border-sky-300'
                : 'bg-[#0D121D] text-slate-100 border-white/[0.1] hover:border-white/[0.2]'
            }`}
          >
            {isSimulating ? (
              <Square className="w-3.5 h-3.5 fill-current shrink-0" aria-hidden="true" />
            ) : (
              <Play className="w-3.5 h-3.5 fill-current shrink-0" aria-hidden="true" />
            )}
            <span>{isSimulating ? 'Stop Sim' : 'Live Sim'}</span>
          </button>

          <button
            type="button"
            onClick={() => setIsTelemetryOpen((prev) => !prev)}
            aria-expanded={isTelemetryOpen}
            aria-label="Toggle telemetry drawer"
            className={`min-h-[44px] px-2.5 rounded-xl text-xs font-medium border transition-colors flex items-center gap-1.5 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
              isTelemetryOpen
                ? 'bg-white text-slate-950 border-white'
                : 'bg-[#0D121D] text-slate-200 border-white/[0.1]'
            }`}
          >
            <Activity className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">Telemetry</span>
          </button>

          <button
            type="button"
            onClick={onSignOut}
            className="w-11 h-11 rounded-xl text-slate-300 hover:text-white hover:bg-slate-800/80 border border-transparent hover:border-white/[0.08] flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            aria-label="Sign out"
            title="Sign Out"
          >
            <LogOut className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* FULL-BLEED INTERACTIVE SPATIAL MAP VIEWPORT */}
      <main
        ref={mapContainerRef}
        className="flex-1 relative spatial-grid-bg overflow-hidden min-h-0"
      >
        <div className="spatial-vignette pointer-events-none absolute inset-0 z-0" aria-hidden="true" />

        <div className="spatial-stage-perspective w-full h-full relative z-10">
          <div className={`w-full h-full spatial-plate ${is25DMode ? 'spatial-plate--tilt' : ''}`}>
            <canvas
              ref={canvasRef}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={() => {
                pointerStateRef.current.isDragging = false;
              }}
              onWheel={handleWheel}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              className="block w-full h-full cursor-grab active:cursor-grabbing touch-none"
            />
          </div>
        </div>

        {/* Mobile Floating Sensor, 2.5D & Online Pill Controls (Top of Map) */}
        <div className="lg:hidden flex items-start justify-between gap-2 absolute top-3 inset-x-3 z-20 pointer-events-none">
          <div className="flex flex-wrap items-center gap-1.5 pointer-events-auto">
            <button
              type="button"
              onClick={toggleMotionSensors}
              aria-pressed={motionSensorsActive}
              className={`min-h-[44px] px-3 rounded-xl text-xs font-medium border backdrop-blur-md transition-colors flex items-center gap-1.5 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                motionSensorsActive
                  ? 'bg-[#111622]/92 text-emerald-300 border-emerald-500/35'
                  : 'bg-[#111622]/92 text-slate-200 border-white/[0.1]'
              }`}
            >
              <Smartphone className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>{motionSensorsActive ? 'Motion Active' : 'Sensors'}</span>
            </button>

            <button
              type="button"
              onClick={() => setIs25DMode((prev) => !prev)}
              aria-pressed={is25DMode}
              aria-label="Toggle 2.5D perspective"
              className={`min-h-[44px] px-2.5 rounded-xl text-xs font-semibold border backdrop-blur-md transition-colors flex items-center gap-1 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                is25DMode
                  ? 'bg-sky-400 text-slate-950 border-sky-300'
                  : 'bg-[#111622]/92 text-slate-200 border-white/[0.1]'
              }`}
            >
              <Layers className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>{is25DMode ? '2.5D' : '2D'}</span>
            </button>

            {motionSensorsActive && (
              <button
                type="button"
                onClick={alignPhoneHeadingToMap}
                className="min-h-[44px] px-3 rounded-xl text-xs font-medium bg-[#111622]/92 text-sky-300 border border-white/[0.1] backdrop-blur-md transition-colors flex items-center gap-1.5 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                aria-label="Align compass heading to map north"
              >
                <Compass className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>Align</span>
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => setIsOnlineDropdownOpen((prev) => !prev)}
            aria-expanded={isOnlineDropdownOpen}
            className="pointer-events-auto min-h-[44px] px-3 rounded-xl text-xs font-semibold bg-[#111622]/94 hover:bg-[#171E2E] text-white border border-white/[0.12] backdrop-blur-md flex items-center gap-2 whitespace-nowrap shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            <span
              className={`w-2 h-2 rounded-full ${
                presenceStatus === 'connected' ? 'bg-emerald-400' : 'bg-amber-400'
              }`}
              aria-hidden="true"
            />
            <span className="font-mono tabular-nums">{totalLiveOnlineCount} Online</span>
            <ChevronDown className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
          </button>
        </div>

        {/* Desktop Floating Top Control Bar (Non-overlapping Left + Right groups) */}
        <div className="hidden lg:flex items-center justify-between gap-3 absolute top-3.5 inset-x-3.5 z-20 pointer-events-none">
          <div className="flex items-center gap-2 pointer-events-auto">
            <button
              type="button"
              onClick={toggleLiveSimulation}
              aria-pressed={isSimulating}
              className={`min-h-[44px] flex items-center gap-2 px-3.5 rounded-xl text-xs font-semibold border backdrop-blur-md transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                isSimulating
                  ? 'bg-sky-400 text-slate-950 border-sky-300 shadow-lg shadow-sky-500/15'
                  : 'bg-[#111622]/92 hover:bg-[#171E2E] text-white border-white/[0.12]'
              }`}
              title="Simulate live walking trajectory, noisy BLE beacons, Kalman filtering & A* navigation"
            >
              {isSimulating ? (
                <Square className="w-3.5 h-3.5 fill-current shrink-0" aria-hidden="true" />
              ) : (
                <Play className="w-3.5 h-3.5 fill-current shrink-0" aria-hidden="true" />
              )}
              <span>{isSimulating ? 'Stop Live Simulation' : 'Live Simulation Mode'}</span>
            </button>

            <button
              type="button"
              onClick={toggleMotionSensors}
              aria-pressed={motionSensorsActive}
              className={`min-h-[44px] flex items-center gap-2 px-3.5 rounded-xl text-xs font-medium border backdrop-blur-md transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                motionSensorsActive
                  ? 'bg-[#111622]/90 text-emerald-300 border-emerald-500/35'
                  : 'bg-[#111622]/90 hover:bg-[#171E2E] text-slate-200 border-white/[0.1]'
              }`}
              title="Toggle anti-shake walking step detection & compass heading (locks active path while enabled)"
            >
              <Smartphone className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>{sensorStatusMessage}</span>
            </button>

            {motionSensorsActive && (
              <button
                type="button"
                onClick={alignPhoneHeadingToMap}
                className="min-h-[44px] flex items-center gap-1.5 px-3.5 rounded-xl text-xs font-medium bg-[#111622]/90 hover:bg-[#171E2E] text-sky-300 border border-white/[0.1] backdrop-blur-md transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                title="Point your phone toward the top of the map and tap Align"
              >
                <Compass className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>Align North</span>
              </button>
            )}

            {bleState !== 'unsupported' && bleState !== 'checking' && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setIsBleModalOpen(true)}
                  className={`min-h-[44px] flex items-center gap-1.5 px-3.5 rounded-xl text-xs font-medium border backdrop-blur-md transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                    bleState === 'connected'
                      ? 'bg-[#111622]/90 text-emerald-300 border-emerald-500/35'
                      : 'bg-[#111622]/90 hover:bg-[#171E2E] text-slate-200 border-white/[0.1]'
                  }`}
                  title="Pair or filter physical BLE beacon devices via Web Bluetooth"
                >
                  <Bluetooth className="w-3.5 h-3.5 text-sky-400 shrink-0" aria-hidden="true" />
                  <span className="max-w-[130px] truncate">
                    {bleState === 'connected' && bleDeviceName ? bleDeviceName : 'Pair BLE'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={refreshHardwareBle}
                  disabled={bleBusy}
                  aria-label="Refresh Bluetooth devices and signal"
                  title="Refresh Bluetooth devices & signal"
                  className="w-11 h-11 rounded-xl bg-[#111622]/90 hover:bg-[#171E2E] disabled:opacity-60 text-slate-200 border border-white/[0.1] backdrop-blur-md flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 text-sky-400 ${bleBusy ? 'animate-spin' : ''}`}
                    aria-hidden="true"
                  />
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 pointer-events-auto">
            {/* Sleek 2D Plan / 2.5D Tilt Segmented Control */}
            <div
              role="group"
              aria-label="Floor plan perspective"
              className="flex items-center p-1 rounded-xl bg-[#111622]/92 border border-white/[0.12] backdrop-blur-md"
            >
              <button
                type="button"
                onClick={() => setIs25DMode(false)}
                aria-pressed={!is25DMode}
                className={`min-h-[36px] px-2.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                  !is25DMode
                    ? 'bg-sky-400 text-slate-950'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                2D Plan
              </button>
              <button
                type="button"
                onClick={() => setIs25DMode(true)}
                aria-pressed={is25DMode}
                className={`min-h-[36px] px-2.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1 whitespace-nowrap ${
                  is25DMode
                    ? 'bg-sky-400 text-slate-950'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                <Layers className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>2.5D Tilt</span>
              </button>
            </div>

            <button
              type="button"
              onClick={() => setIsOnlineDropdownOpen((prev) => !prev)}
              aria-expanded={isOnlineDropdownOpen}
              className={`min-h-[44px] flex items-center gap-2 px-3.5 rounded-xl text-xs font-semibold border backdrop-blur-md transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                isOnlineDropdownOpen
                  ? 'bg-emerald-500/15 text-emerald-200 border-emerald-400/50'
                  : 'bg-[#111622]/92 hover:bg-[#171E2E] text-white border-white/[0.12]'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  presenceStatus === 'connected' ? 'bg-emerald-400' : 'bg-amber-400'
                }`}
                aria-hidden="true"
              />
              <span className="font-mono tabular-nums">{totalLiveOnlineCount} Online</span>
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
            </button>

            <button
              type="button"
              onClick={() => setIsTelemetryOpen((prev) => !prev)}
              aria-expanded={isTelemetryOpen}
              className={`min-h-[44px] flex items-center gap-2 px-3.5 rounded-xl text-xs font-medium border backdrop-blur-md transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                isTelemetryOpen
                  ? 'bg-white text-slate-950 border-white'
                  : 'bg-[#111622]/92 hover:bg-[#171E2E] text-slate-100 border-white/[0.1]'
              }`}
            >
              <Activity className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>Telemetry</span>
              <span
                className={`font-mono text-[11px] ${
                  isTelemetryOpen ? 'text-slate-600' : 'text-sky-400'
                }`}
              >
                {positioningMode}
              </span>
            </button>
          </div>
        </div>

        {/* Clickable Online Users Dropdown Overlay (Mobile & Desktop) */}
        {isOnlineDropdownOpen && (
          <>
            <div
              onClick={() => setIsOnlineDropdownOpen(false)}
              className="fixed inset-0 z-30"
              aria-hidden="true"
            />
            <div
              role="dialog"
              aria-label="Online Floor Users"
              className="absolute top-[64px] right-3 lg:right-3.5 z-40 w-[min(328px,calc(100vw-24px))] max-h-[70dvh] bg-[#111622]/98 backdrop-blur-xl border border-white/[0.12] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
            >
              <div className="px-4 py-3 border-b border-white/[0.08] flex items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-bold text-white flex items-center gap-2">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        presenceStatus === 'connected' ? 'bg-emerald-400' : 'bg-amber-400'
                      }`}
                      aria-hidden="true"
                    />
                    <span>Online Users ({totalLiveOnlineCount})</span>
                  </div>
                  <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                    channel: live-indoor-users · {presenceStatus}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setIsOnlineDropdownOpen(false)}
                  aria-label="Close online users menu"
                  className="w-9 h-9 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 flex items-center justify-center"
                >
                  <X className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {/* Local User Row */}
                <div className="p-2.5 rounded-xl bg-[#0D121D] border border-sky-400/25 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <UserAvatar
                      src={currentUser.avatarUrl}
                      name={presenceProfile?.name || firstName}
                      className="w-8 h-8 rounded-lg text-xs text-white shrink-0 border border-white/20"
                      style={{
                        backgroundColor: presenceProfile?.color || '#3B82F6',
                      }}
                    />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-white truncate">
                        You · {presenceProfile?.name || 'Guest'}
                      </div>
                      <div className="text-[11px] text-slate-400 font-mono tabular-nums flex items-center gap-1">
                        {deviceType === 'laptop' ? (
                          <Laptop className="w-3 h-3" aria-hidden="true" />
                        ) : (
                          <Smartphone className="w-3 h-3" aria-hidden="true" />
                        )}
                        <span>
                          ({userPose.x.toFixed(1)}, {userPose.y.toFixed(1)})
                        </span>
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setIsOnlineDropdownOpen(false);
                      setIsJoinPromptOpen(true);
                    }}
                    className="min-h-[36px] px-2.5 rounded-lg text-[11px] font-medium bg-[#141B2B] hover:bg-slate-800 text-slate-200 border border-white/[0.08] flex items-center gap-1 shrink-0"
                  >
                    <Edit3 className="w-3 h-3" aria-hidden="true" />
                    <span>Name</span>
                  </button>
                </div>

                {/* Remote Connected Live Users */}
                {liveUsers.length === 0 ? (
                  <p className="text-[11px] text-slate-400 text-center py-4 px-2">
                    No other devices connected yet. Open this app in another tab or mobile browser to see live markers appear.
                  </p>
                ) : (
                  liveUsers.map((lu) => {
                    const dist =
                      walkableDistancesById.get(lu.id) ??
                      Math.hypot(lu.x - userPose.x, lu.y - userPose.y);
                    const isRouting = targetLiveUserId === lu.id;
                    return (
                      <button
                        key={lu.id}
                        type="button"
                        onClick={() => {
                          if (isRouting) {
                            setTargetLiveUserId(null);
                          } else {
                            setTargetLiveUserId(lu.id);
                            setTargetPeerId(null);
                            setTargetRoomId(null);
                            focusMapOnPoint(lu.x, lu.y, lu.color);
                          }
                          setIsOnlineDropdownOpen(false);
                        }}
                        className={`w-full min-h-[48px] p-2.5 rounded-xl border text-left flex items-center justify-between gap-2 transition-colors ${
                          isRouting
                            ? 'bg-emerald-500/15 border-emerald-400/50'
                            : 'bg-[#0D121D] border-white/[0.08] hover:border-white/[0.2]'
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <UserAvatar
                            src={lu.avatarUrl}
                            name={lu.name}
                            className="w-8 h-8 rounded-lg text-xs text-slate-950 shrink-0 border border-white/15"
                            style={{ backgroundColor: lu.color }}
                          />
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-white truncate">{lu.name}</div>
                            <div className="text-[11px] text-slate-400 capitalize">
                              {lu.device} · ({lu.x.toFixed(1)}, {lu.y.toFixed(1)})
                            </div>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-xs font-mono tabular-nums font-semibold text-sky-400">
                            {dist.toFixed(1)} m
                          </div>
                          <div className="text-[10px] text-slate-400">
                            {isRouting ? 'Routing' : 'Navigate'}
                          </div>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>

              <div className="p-3 border-t border-white/[0.08] bg-[#0D121D]/80 space-y-2">
                {deviceType === 'laptop' && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsSpotPickerActive((prev) => !prev);
                      setIsOnlineDropdownOpen(false);
                    }}
                    className={`w-full min-h-[44px] px-3 rounded-xl text-xs font-medium border transition-colors flex items-center justify-between ${
                      isSpotPickerActive
                        ? 'bg-sky-400 text-slate-950 border-sky-300'
                        : 'bg-[#141B2B] hover:bg-[#1B2438] text-slate-200 border-white/[0.08]'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <MapPin className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Set My Spot on Map</span>
                    </span>
                    <span className="text-[11px] font-mono">
                      {isSpotPickerActive ? 'Click map' : 'Laptop'}
                    </span>
                  </button>
                )}

                <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-[#141B2B] border border-white/[0.08]">
                  <span className="text-xs font-medium text-slate-200">Demo Bots</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={showDemoBots}
                    onClick={() => setShowDemoBots((prev) => !prev)}
                    className={`min-h-[34px] px-3 rounded-lg text-xs font-mono font-semibold border transition-colors ${
                      showDemoBots
                        ? 'bg-sky-400/20 text-sky-300 border-sky-400/40'
                        : 'bg-[#0D121D] text-slate-400 border-white/[0.08]'
                    }`}
                  >
                    {showDemoBots ? 'ON' : 'OFF'}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Non-Intrusive 1-Step "Join Floor Map" Prompt */}
        {isJoinPromptOpen && (
          <div className="absolute top-[68px] left-1/2 -translate-x-1/2 z-40 w-[min(380px,calc(100%-24px))]">
            <form
              onSubmit={handleJoinMapSubmit}
              className="bg-[#111622]/96 backdrop-blur-xl border border-sky-400/35 rounded-2xl p-4 shadow-2xl space-y-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <UserAvatar
                    src={currentUser.avatarUrl}
                    name={joinNameInput || currentUser.name}
                    className="w-9 h-9 rounded-xl bg-sky-400/15 border border-sky-400/35 text-sky-300 text-xs shrink-0"
                  />
                  <div className="min-w-0">
                    <h2 className="text-sm font-bold text-white">Join Floor Map</h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {deviceType === 'mobile'
                        ? 'Share your live indoor position with others on Floor 1.'
                        : 'Appear on the map now. Click any corridor spot to set your position.'}
                    </p>
                  </div>
                </div>
                {presenceProfile && (
                  <button
                    type="button"
                    onClick={() => setIsJoinPromptOpen(false)}
                    aria-label="Close join prompt"
                    className="w-9 h-9 rounded-lg text-slate-400 hover:text-white flex items-center justify-center"
                  >
                    <X className="w-4 h-4" aria-hidden="true" />
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={joinNameInput}
                  onChange={(e) => setJoinNameInput(e.target.value)}
                  placeholder="Enter your display name..."
                  aria-label="Your display name for the floor map"
                  maxLength={32}
                  autoFocus
                  className="flex-1 min-w-0 min-h-[44px] bg-[#0D121D] border border-white/[0.12] focus:border-sky-400 rounded-xl px-3 py-2 text-sm text-white placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                />
                <button
                  type="submit"
                  disabled={!joinNameInput.trim()}
                  className="min-h-[44px] px-4 rounded-xl bg-sky-400 hover:bg-sky-300 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 text-xs font-bold whitespace-nowrap transition-colors"
                >
                  Join Map
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Laptop Spot-Picker Active Hint */}
        {isSpotPickerActive && (
          <div className="absolute top-[68px] left-1/2 -translate-x-1/2 z-30 px-3.5 py-2 rounded-xl bg-sky-400 text-slate-950 text-xs font-semibold shadow-xl flex items-center gap-2">
            <MapPin className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Click anywhere on the floor plan to place your marker</span>
          </div>
        )}

        {/* Desktop Floating Wayfinding Guidance Card (Anchored cleanly below Top-Left controls) */}
        {activeTarget && (
          <div className="hidden lg:block absolute top-[68px] left-3.5 w-[348px] z-20 animate-fade-in">
            <div
              className={`border rounded-2xl px-4 py-3 shadow-2xl backdrop-blur-xl flex items-center justify-between gap-3 transition-colors ${
                hasArrived
                  ? 'bg-emerald-950/92 border-emerald-500/50'
                  : 'bg-[#111622]/92 border-white/[0.1]'
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border ${
                    hasArrived
                      ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/35'
                      : 'bg-sky-400/12 text-sky-400 border-sky-400/30'
                  }`}
                >
                  {hasArrived ? (
                    <CheckCircle2 className="w-5 h-5" aria-hidden="true" />
                  ) : (
                    <Navigation className="w-4 h-4" aria-hidden="true" />
                  )}
                </div>

                <div className="min-w-0">
                  <div className="text-xs text-slate-400 truncate">
                    {hasArrived ? 'Arrived at' : 'Routing to'}{' '}
                    <span
                      className={`font-semibold ${
                        hasArrived ? 'text-emerald-300' : 'text-sky-300'
                      }`}
                    >
                      {activeTarget.name}
                    </span>
                  </div>
                  <div className="text-sm font-semibold text-white truncate mt-0.5">
                    {hasArrived ? 'Destination reached' : activeTarget.subtext}
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] text-slate-400 mt-0.5 font-mono tabular-nums">
                    <Clock className="w-3 h-3 text-slate-500 shrink-0" aria-hidden="true" />
                    <span>
                      {hasArrived
                        ? 'At target location'
                        : `~${routeEtaSeconds}s walk · ~${estimatedRouteSteps} steps`}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2.5 shrink-0">
                {!hasArrived && (
                  <div className="text-right">
                    <div className="text-sm font-bold font-mono tabular-nums text-white leading-none">
                      {remainingDistanceMeters.toFixed(1)} m
                    </div>
                    <div className="text-[10px] text-slate-400 mt-1">A* dist</div>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setTargetPeerId(null);
                    setTargetLiveUserId(null);
                    setTargetRoomId(null);
                  }}
                  className="min-h-[44px] px-3 rounded-xl text-xs font-semibold bg-[#1A2233] hover:bg-slate-800 text-slate-200 border border-white/[0.08] transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                >
                  {hasArrived ? 'Done' : 'Cancel'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Auto-Suggested Evaluator Banner when Web Bluetooth is Unavailable or Denied */}
        {showBleAutoSuggestion && (
          <div className="absolute bottom-3.5 left-3.5 right-[68px] lg:right-auto lg:left-1/2 lg:-translate-x-1/2 lg:w-[480px] z-20">
            <div className="bg-[#111622]/94 backdrop-blur-xl border border-white/[0.12] rounded-2xl px-3.5 py-2.5 shadow-2xl flex items-center justify-between gap-2.5">
              <div className="min-w-0 flex items-center gap-2.5">
                <Bluetooth className="w-4 h-4 text-sky-400 shrink-0" aria-hidden="true" />
                <p className="text-xs text-slate-200 leading-snug">
                  {bleState === 'denied'
                    ? 'Bluetooth access declined. Run Live Simulation Mode to preview Kalman BLE + PDR.'
                    : 'Web Bluetooth unavailable. Start Live Simulation Mode to preview Kalman BLE + A*.'}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={toggleLiveSimulation}
                  className="min-h-[44px] px-3 rounded-xl bg-sky-400 hover:bg-sky-300 text-slate-950 text-xs font-semibold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
                >
                  Start Sim
                </button>
                <button
                  type="button"
                  onClick={() => setBleSuggestionDismissed(true)}
                  aria-label="Dismiss Bluetooth suggestion"
                  className="w-11 h-11 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800/80 flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                >
                  <X className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Map Camera Controls (Bottom-Right on both Phone & Desktop — strict 44x44 tap targets) */}
        <div className="absolute bottom-3.5 right-3.5 z-20 flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => zoomBy(1.25)}
            aria-label="Zoom in"
            title="Zoom in"
            className="w-11 h-11 rounded-xl bg-[#111622]/90 hover:bg-[#171E2E] border border-white/[0.1] backdrop-blur-md text-slate-200 flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => zoomBy(0.8)}
            aria-label="Zoom out"
            title="Zoom out"
            className="w-11 h-11 rounded-xl bg-[#111622]/90 hover:bg-[#171E2E] border border-white/[0.1] backdrop-blur-md text-slate-200 flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            <Minus className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={centerOnUser}
            aria-label="Center on my location"
            title="Center on my location"
            className="w-11 h-11 rounded-xl bg-[#111622]/90 hover:bg-[#171E2E] border border-white/[0.1] backdrop-blur-md text-sky-400 flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            <LocateFixed className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={fitFloorPlan}
            aria-label="Fit entire floor plan"
            title="Fit floor plan"
            className="w-11 h-11 rounded-xl bg-[#111622]/90 hover:bg-[#171E2E] border border-white/[0.1] backdrop-blur-md text-slate-300 flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            <Maximize2 className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Desktop Subtle Telemetry Strip (Hidden when auto-suggestion banner is visible) */}
        {!showBleAutoSuggestion && (
          <div className="hidden lg:flex items-center gap-2.5 absolute bottom-3.5 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-xl bg-[#111622]/85 border border-white/[0.08] backdrop-blur-md text-[11px] text-slate-400 pointer-events-none z-20">
            <span className="font-mono tabular-nums text-slate-200">
              HDG {String(userPose.heading).padStart(3, '0')}°
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">{userPose.stepCount} steps</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">
              {isSimulating
                ? `Kalman ±${kalmanError.toFixed(1)}m`
                : `${totalLiveOnlineCount} live · ${displayedDemoBots.length} demo`}
            </span>
          </div>
        )}
      </main>

      {/* COLLAPSIBLE MINIMALIST TELEMETRY DRAWER / HUD */}
      {isTelemetryOpen && (
        <>
          <div
            onClick={() => setIsTelemetryOpen(false)}
            className="fixed inset-0 z-40 bg-black/45 backdrop-blur-[1px] lg:bg-transparent lg:backdrop-blur-none"
            aria-hidden="true"
          />
          <aside
            role="dialog"
            aria-modal="false"
            aria-label="Live Positioning Telemetry"
            className="fixed inset-y-0 right-0 z-50 w-full max-w-[348px] h-[100dvh] bg-[#111622]/98 backdrop-blur-xl border-l border-white/[0.08] shadow-2xl flex flex-col"
          >
            <div className="px-4 py-3.5 border-b border-white/[0.08] flex items-center justify-between gap-3 shrink-0">
              <div>
                <h2 className="text-sm font-bold text-white tracking-tight">Live Telemetry</h2>
                <p className="text-[11px] text-slate-400 mt-0.5 font-mono">
                  Kalman BLE <span aria-hidden="true">·</span> PDR <span aria-hidden="true">·</span> A*
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsTelemetryOpen(false)}
                aria-label="Close telemetry drawer"
                className="w-11 h-11 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800/80 border border-white/[0.08] flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3.5">
              {/* Positioning Mode Card */}
              <div className="p-3.5 rounded-xl bg-[#0D121D] border border-white/[0.08] space-y-2.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-400">Positioning Mode</span>
                  <span
                    className={`font-mono font-semibold ${
                      positioningMode === 'Simulation'
                        ? 'text-sky-400'
                        : positioningMode === 'Hardware BLE'
                          ? 'text-emerald-400'
                          : 'text-slate-200'
                    }`}
                  >
                    {positioningMode}
                  </span>
                </div>
                {bleDeviceName && (
                  <div className="flex items-center justify-between text-[11px] text-slate-400">
                    <span>BLE Device</span>
                    <span className="font-mono text-slate-200 truncate max-w-[160px]">
                      {bleDeviceName}
                    </span>
                  </div>
                )}
                <div className="flex items-center gap-2 pt-0.5">
                  <button
                    type="button"
                    onClick={toggleLiveSimulation}
                    className={`flex-1 min-h-[44px] px-3 rounded-xl text-xs font-semibold border transition-colors flex items-center justify-center gap-1.5 ${
                      isSimulating
                        ? 'bg-sky-400 text-slate-950 border-sky-300'
                        : 'bg-[#141B2B] hover:bg-[#1B2438] text-white border-white/[0.1]'
                    }`}
                  >
                    {isSimulating ? (
                      <Square className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
                    ) : (
                      <Play className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
                    )}
                    <span>{isSimulating ? 'Stop Simulation' : 'Run Simulation'}</span>
                  </button>

                  {bleState !== 'unsupported' && bleState !== 'checking' ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setIsBleModalOpen(true)}
                        className="min-h-[44px] px-3 rounded-xl text-xs font-medium bg-[#141B2B] hover:bg-[#1B2438] text-slate-200 border border-white/[0.1] flex items-center gap-1.5"
                      >
                        <Bluetooth className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
                        <span>{bleState === 'connected' ? 'BLE' : 'Pair BLE'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={refreshHardwareBle}
                        disabled={bleBusy}
                        aria-label="Refresh Bluetooth devices"
                        title="Refresh Bluetooth devices & signal"
                        className="w-11 h-11 rounded-xl bg-[#141B2B] hover:bg-[#1B2438] disabled:opacity-60 text-slate-200 border border-white/[0.1] flex items-center justify-center shrink-0"
                      >
                        <RefreshCw
                          className={`w-3.5 h-3.5 text-sky-400 ${bleBusy ? 'animate-spin' : ''}`}
                          aria-hidden="true"
                        />
                      </button>
                    </>
                  ) : null}
                </div>
              </div>

              {/* PDR Metrics */}
              <div className="p-3.5 rounded-xl bg-[#0D121D] border border-white/[0.08]">
                <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-2.5">
                  PDR Inertial Fusion
                </div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="p-2 rounded-lg bg-[#111622] border border-white/[0.06]">
                    <div className="text-[10px] text-slate-400">Steps</div>
                    <div className="text-sm font-mono tabular-nums font-bold text-white mt-0.5">
                      {userPose.stepCount}
                    </div>
                  </div>
                  <div className="p-2 rounded-lg bg-[#111622] border border-white/[0.06]">
                    <div className="text-[10px] text-slate-400">Heading</div>
                    <div className="text-sm font-mono tabular-nums font-bold text-sky-400 mt-0.5">
                      {String(userPose.heading).padStart(3, '0')}°
                    </div>
                  </div>
                  <div className="p-2 rounded-lg bg-[#111622] border border-white/[0.06]">
                    <div className="text-[10px] text-slate-400">Walked</div>
                    <div className="text-sm font-mono tabular-nums font-bold text-white mt-0.5">
                      {userPose.totalDistanceMeters.toFixed(1)}m
                    </div>
                  </div>
                </div>
              </div>

              {/* Active A* Route Metrics */}
              <div className="p-3.5 rounded-xl bg-[#0D121D] border border-white/[0.08] space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
                    A* Floor Route
                  </span>
                  <span className="text-xs font-mono tabular-nums text-sky-400">
                    {activeTarget
                      ? hasArrived
                        ? 'Arrived'
                        : `${remainingDistanceMeters.toFixed(1)}m · ~${routeEtaSeconds}s · ~${estimatedRouteSteps} steps`
                      : 'Idle'}
                  </span>
                </div>
                <div className="text-xs text-white font-medium truncate">
                  {activeTarget ? activeTarget.name : 'Select a peer or room to route'}
                </div>
              </div>

              {/* BLE Raw RSSI vs 1D Kalman Distance */}
              <div className="p-3.5 rounded-xl bg-[#0D121D] border border-white/[0.08] space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
                    Raw RSSI vs. Kalman
                  </span>
                  {isSimulating && (
                    <span className="text-[11px] font-mono tabular-nums text-slate-300">
                      <span className="text-amber-400">±{rawJitterError.toFixed(1)}m</span>
                      <span className="text-slate-500"> → </span>
                      <span className="text-cyan-400">±{kalmanError.toFixed(1)}m</span>
                    </span>
                  )}
                </div>

                <div className="space-y-1.5">
                  {beacons.map((b) => (
                    <div
                      key={b.id}
                      className="px-2.5 py-2 rounded-lg bg-[#111622] border border-white/[0.06] flex items-center justify-between text-xs font-mono tabular-nums"
                    >
                      <div className="min-w-0">
                        <span className="font-semibold text-slate-200">{b.id}</span>
                        <span className="text-slate-500 font-sans text-[11px] ml-1.5">
                          {b.name}
                        </span>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-[11px]">
                          <span className="text-amber-400">{b.currentRawRssi.toFixed(0)}dBm</span>
                          <span className="text-slate-500"> → </span>
                          <span className="text-cyan-400">{b.filteredRssi.toFixed(0)}dBm</span>
                        </div>
                        <div className="text-[10px] text-slate-400">
                          {b.rawDistance.toFixed(1)}m → {b.estimatedDistance.toFixed(1)}m
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Realtime Peers Status */}
              <div className="p-3.5 rounded-xl bg-[#0D121D] border border-white/[0.08] space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold flex items-center gap-1.5">
                    <Radio className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                    <span>Realtime Presence</span>
                  </span>
                  <span className="text-xs font-mono tabular-nums font-semibold text-emerald-400">
                    {totalLiveOnlineCount} live
                  </span>
                </div>
                <div className="space-y-1">
                  {liveUsers.map((lu) => (
                    <div
                      key={lu.id}
                      className="flex items-center justify-between text-[11px] py-1 border-b border-white/[0.04] last:border-b-0"
                    >
                      <span className="text-emerald-300 truncate">{lu.name}</span>
                      <span className="font-mono tabular-nums text-slate-400 shrink-0">
                        ({lu.x.toFixed(1)}, {lu.y.toFixed(1)})
                      </span>
                    </div>
                  ))}
                  {displayedDemoBots.map((peer) => (
                    <div
                      key={peer.id}
                      className="flex items-center justify-between text-[11px] py-1 border-b border-white/[0.04] last:border-b-0"
                    >
                      <span className="text-slate-300 truncate">{peer.fullName}</span>
                      <span className="font-mono tabular-nums text-slate-400 shrink-0">
                        ({peer.x.toFixed(1)}, {peer.y.toFixed(1)})
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </aside>
        </>
      )}

      {/* MOBILE THUMB-ZONE BOTTOM WAYFINDING DOCK (< lg) */}
      <div className="lg:hidden shrink-0 bg-[#111622] border-t border-white/[0.08] px-3 py-2 z-30">
        {activeTarget ? (
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setIsMobileSheetOpen(true)}
              className="min-h-[44px] flex items-center gap-2.5 min-w-0 flex-1 text-left py-1 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              <div
                className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border ${
                  hasArrived
                    ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/35'
                    : 'bg-sky-400/12 text-sky-400 border-sky-400/30'
                }`}
              >
                {hasArrived ? (
                  <CheckCircle2 className="w-5 h-5" aria-hidden="true" />
                ) : (
                  <Navigation className="w-4 h-4" aria-hidden="true" />
                )}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-bold text-white truncate">{activeTarget.name}</span>
                  <ChevronUp className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
                </div>
                <div className="text-xs font-mono tabular-nums text-slate-400 truncate">
                  {hasArrived ? (
                    <span className="text-emerald-400 font-sans font-medium">
                      Arrived at destination
                    </span>
                  ) : (
                    <>
                      <span className="text-sky-400 font-semibold">
                        {remainingDistanceMeters.toFixed(1)} m
                      </span>{' '}
                      · ~{routeEtaSeconds}s · ~{estimatedRouteSteps} steps
                    </>
                  )}
                </div>
              </div>
            </button>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => setIsMobileSheetOpen(true)}
                aria-label="Open directory"
                className="min-h-[44px] px-3 rounded-xl text-xs font-semibold bg-[#182030] text-slate-200 border border-white/[0.08] flex items-center gap-1.5"
              >
                <Users className="w-3.5 h-3.5" aria-hidden="true" />
                <span>List</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setTargetPeerId(null);
                  setTargetLiveUserId(null);
                  setTargetRoomId(null);
                }}
                className="min-h-[44px] px-3 rounded-xl text-xs font-semibold bg-slate-800 text-slate-200 border border-white/[0.08]"
              >
                {hasArrived ? 'Done' : 'Cancel'}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setIsMobileSheetOpen(true)}
            className="w-full min-h-[46px] px-4 rounded-xl bg-sky-400 hover:bg-sky-300 text-slate-950 text-sm font-semibold flex items-center justify-between transition-colors"
          >
            <span className="flex items-center gap-2">
              <Users className="w-4 h-4" aria-hidden="true" />
              <span>Find People &amp; Rooms</span>
            </span>
            <span className="text-xs font-mono tabular-nums font-bold">
              {totalLiveOnlineCount} live
            </span>
          </button>
        )}
      </div>

      {/* MOBILE BOTTOM SHEET DIRECTORY (< lg) */}
      {isMobileSheetOpen && (
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsMobileSheetOpen(false);
          }}
          className="lg:hidden fixed inset-0 z-50 flex flex-col justify-end bg-black/65 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Floor 1 Directory"
        >
          <div className="w-full max-h-[78dvh] bg-[#111622] border-t border-white/[0.1] rounded-t-2xl px-4 pt-2.5 pb-6 flex flex-col shadow-2xl animate-sheet-up">
            {/* Grab Handle */}
            <div
              className="w-10 h-1 rounded-full bg-slate-700 mx-auto mb-3 shrink-0"
              aria-hidden="true"
            />

            <div className="flex items-center justify-between pb-3 border-b border-white/[0.08]">
              <div>
                <h2 className="text-base font-bold text-white leading-tight">Floor 1 Directory</h2>
                <p className="text-xs text-slate-400 mt-0.5 font-mono tabular-nums">
                  {totalLiveOnlineCount} live <span aria-hidden="true">·</span>{' '}
                  {displayedDemoBots.length} demo <span aria-hidden="true">·</span>{' '}
                  {roomDestinations.length} rooms
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsMobileSheetOpen(false)}
                aria-label="Close directory"
                className="w-11 h-11 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 flex items-center justify-center transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 min-h-0 flex flex-col pt-3">{renderDirectoryList(true)}</div>
          </div>
        </div>
      )}

      {/* BLE SCANNER, CLEAN NAME FILTER & REFRESH MODAL */}
      {isBleModalOpen && (
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsBleModalOpen(false);
          }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/65 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Bluetooth BLE Beacon Scanner"
        >
          <div className="w-full max-w-[420px] bg-[#111622] border border-white/[0.12] rounded-2xl shadow-2xl overflow-hidden flex flex-col">
            <div className="px-4 py-3.5 border-b border-white/[0.08] flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-9 h-9 rounded-xl bg-sky-400/15 border border-sky-400/30 flex items-center justify-center shrink-0">
                  <Bluetooth className="w-4 h-4 text-sky-400" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-sm font-bold text-white truncate">Bluetooth Beacon Scanner</h2>
                  <p className="text-[11px] text-slate-400 truncate">
                    Filter clean device names &amp; refresh live signal
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={refreshHardwareBle}
                  disabled={bleBusy}
                  aria-label="Refresh Bluetooth devices"
                  title="Refresh paired device & signal"
                  className="w-10 h-10 rounded-xl bg-[#0D121D] hover:bg-slate-800 disabled:opacity-60 text-sky-400 border border-white/[0.08] flex items-center justify-center transition-colors"
                >
                  <RefreshCw className={`w-4 h-4 ${bleBusy ? 'animate-spin' : ''}`} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => setIsBleModalOpen(false)}
                  aria-label="Close Bluetooth scanner"
                  className="w-10 h-10 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 flex items-center justify-center transition-colors"
                >
                  <X className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
            </div>

            <div className="p-4 space-y-3.5 max-h-[75dvh] overflow-y-auto">
              {/* Scan Filter Mode (Eliminates Unknown/Hex Device Spam) */}
              <div className="space-y-2">
                <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
                  Device Filter Before Pairing
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setBleScanMode('beacons')}
                    className={`min-h-[40px] px-2 rounded-xl text-[11px] font-semibold border transition-colors ${
                      bleScanMode === 'beacons'
                        ? 'bg-sky-400 text-slate-950 border-sky-300'
                        : 'bg-[#0D121D] text-slate-300 border-white/[0.08] hover:border-white/[0.2]'
                    }`}
                  >
                    Named / Beacons
                  </button>
                  <button
                    type="button"
                    onClick={() => setBleScanMode('prefix')}
                    className={`min-h-[40px] px-2 rounded-xl text-[11px] font-semibold border transition-colors ${
                      bleScanMode === 'prefix'
                        ? 'bg-sky-400 text-slate-950 border-sky-300'
                        : 'bg-[#0D121D] text-slate-300 border-white/[0.08] hover:border-white/[0.2]'
                    }`}
                  >
                    By Name Prefix
                  </button>
                  <button
                    type="button"
                    onClick={() => setBleScanMode('all')}
                    className={`min-h-[40px] px-2 rounded-xl text-[11px] font-semibold border transition-colors ${
                      bleScanMode === 'all'
                        ? 'bg-sky-400 text-slate-950 border-sky-300'
                        : 'bg-[#0D121D] text-slate-300 border-white/[0.08] hover:border-white/[0.2]'
                    }`}
                  >
                    All Nearby
                  </button>
                </div>

                {bleScanMode === 'prefix' && (
                  <input
                    type="text"
                    value={bleNamePrefix}
                    onChange={(e) => setBleNamePrefix(e.target.value)}
                    placeholder="e.g. ESP, Beacon, Galaxy, iPhone..."
                    aria-label="Bluetooth device name prefix filter"
                    className="w-full min-h-[44px] bg-[#0D121D] border border-white/[0.12] focus:border-sky-400 rounded-xl px-3 py-2 text-xs text-white placeholder:text-slate-500 focus-visible:outline-none"
                  />
                )}

                <p className="text-[11px] text-slate-400 leading-snug">
                  {bleScanMode === 'beacons'
                    ? 'Hides anonymous MAC/hex packets and shows standard BLE beacons & GATT devices.'
                    : bleScanMode === 'prefix'
                      ? 'Only shows devices whose Bluetooth name starts with your prefix.'
                      : 'Lists every nearby Bluetooth packet (including unnamed devices).'}
                </p>

                <button
                  type="button"
                  disabled={bleBusy || (bleScanMode === 'prefix' && !bleNamePrefix.trim())}
                  onClick={() => void scanAndPairHardwareBle()}
                  className="w-full min-h-[44px] px-4 rounded-xl bg-sky-400 hover:bg-sky-300 disabled:opacity-50 text-slate-950 text-xs font-bold flex items-center justify-center gap-2 transition-colors"
                >
                  <Bluetooth className="w-4 h-4" aria-hidden="true" />
                  <span>{bleBusy ? 'Scanning...' : 'Scan & Pair Device'}</span>
                </button>
              </div>

              {bleStatusNote && (
                <div className="px-3 py-2 rounded-xl bg-[#0D121D] border border-white/[0.08] text-[11px] text-slate-300">
                  {bleStatusNote}
                </div>
              )}

              {/* Active Paired Device with Clean Resolved Metadata & Friendly Rename */}
              {blePairedDevice && (
                <div className="p-3.5 rounded-xl bg-[#0D121D] border border-emerald-500/35 space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-white truncate">
                        {blePairedDevice.displayName}
                      </div>
                      <div className="text-[11px] text-slate-400 mt-0.5 truncate">
                        {[
                          blePairedDevice.manufacturer,
                          blePairedDevice.model,
                          blePairedDevice.batteryPct !== null ? `${blePairedDevice.batteryPct}% bat` : null,
                          blePairedDevice.rssi !== null ? `${blePairedDevice.rssi} dBm` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ') || 'Active BLE Beacon'}
                      </div>
                    </div>
                    <span className="text-[10px] font-mono text-emerald-400 shrink-0">
                      {blePairedDevice.lastUpdated}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={bleCustomAlias}
                      onChange={(e) => setBleCustomAlias(e.target.value)}
                      placeholder="Friendly beacon name..."
                      aria-label="Friendly beacon name"
                      className="flex-1 min-w-0 min-h-[38px] bg-[#111622] border border-white/[0.1] rounded-lg px-2.5 text-xs text-white focus-visible:outline-none focus-visible:border-sky-400"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const clean = bleCustomAlias.trim();
                        if (!clean) return;
                        setBleDeviceName(clean);
                        setBlePairedDevice((prev) => (prev ? { ...prev, displayName: clean } : prev));
                      }}
                      className="min-h-[38px] px-3 rounded-lg bg-[#182133] hover:bg-slate-800 text-xs font-semibold text-sky-300 border border-white/[0.08]"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={disconnectHardwareBle}
                      className="min-h-[38px] px-2.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-xs font-semibold text-rose-300 border border-rose-500/30"
                    >
                      Unpair
                    </button>
                  </div>
                </div>
              )}

              {/* Saved Devices Quick Refresh List */}
              {bleKnownDevices.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
                    Paired Browser Devices ({bleKnownDevices.length})
                  </div>
                  {bleKnownDevices.map((d) => (
                    <div
                      key={d.id}
                      className="px-3 py-2 rounded-xl bg-[#0D121D] border border-white/[0.08] flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="text-slate-200 font-medium truncate">{d.displayName}</span>
                      <span className="text-[10px] font-mono text-slate-400 shrink-0">
                        {d.connected ? 'Connected' : d.lastUpdated}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
