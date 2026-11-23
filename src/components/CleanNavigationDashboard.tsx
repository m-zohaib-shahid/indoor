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
  currentUser: { name: string; role: string; email: string };
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

  // Viewport size & interactive pan/zoom camera
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number }>({
    width: 960,
    height: 700,
  });
  const [camera, setCamera] = useState<MapCamera>({
    scale: 26,
    panX: 80,
    panY: 40,
  });
  const cameraInitializedRef = useRef(false);

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
    stepCount: 142,
    totalDistanceMeters: 92.4,
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

  // Connect & sync Live Multi-User Presence over InsForge Realtime channel 'live-indoor-users'
  useEffect(() => {
    if (!presenceProfile) return;

    const client = new LiveFloorPresenceClient({
      localUser: {
        id: localPresenceTabId,
        name: presenceProfile.name,
        color: presenceProfile.color,
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
  }, [presenceProfile, localPresenceTabId, deviceType]);

  // Compute camera that fits the entire Floor 1 neatly inside any viewport (portrait phone or wide desktop)
  const computeFitCamera = useCallback((w: number, h: number): MapCamera => {
    const isCompact = w < 640;
    const padX = isCompact ? 20 : 56;
    const padTop = isCompact ? 28 : 96;
    const padBottom = isCompact ? 28 : 56;
    const availW = Math.max(160, w - padX * 2);
    const availH = Math.max(160, h - padTop - padBottom);
    const scale = Math.max(
      10,
      Math.min(44, Math.min(availW / WORLD_BOUNDS.width, availH / WORLD_BOUNDS.height))
    );
    const panX = w / 2 - WORLD_BOUNDS.centerX * scale;
    const panY = padTop + availH / 2 - WORLD_BOUNDS.centerY * scale;
    return { scale, panX, panY };
  }, []);

  const fitFloorPlan = useCallback(() => {
    setCamera(computeFitCamera(viewportSize.width, viewportSize.height));
  }, [computeFitCamera, viewportSize.width, viewportSize.height]);

  const centerOnUser = useCallback(() => {
    setCamera((prev) => {
      const targetScale = Math.max(prev.scale, viewportSize.width < 640 ? 22 : 28);
      return {
        scale: targetScale,
        panX: viewportSize.width / 2 - userPose.x * targetScale,
        panY: viewportSize.height / 2 - userPose.y * targetScale,
      };
    });
  }, [userPose.x, userPose.y, viewportSize.width, viewportSize.height]);

  const zoomBy = useCallback(
    (factor: number, focusX?: number, focusY?: number) => {
      setCamera((prev) => {
        const nextScale = Math.max(10, Math.min(72, prev.scale * factor));
        const fx = focusX ?? viewportSize.width / 2;
        const fy = focusY ?? viewportSize.height / 2;
        const worldX = (fx - prev.panX) / prev.scale;
        const worldY = (fy - prev.panY) / prev.scale;
        return {
          scale: nextScale,
          panX: fx - worldX * nextScale,
          panY: fy - worldY * nextScale,
        };
      });
    },
    [viewportSize.width, viewportSize.height]
  );

  // Measure map viewport via ResizeObserver so canvas fills 100% of screen on any phone or desktop
  useEffect(() => {
    const el = mapContainerRef.current;
    if (!el) return;

    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const w = Math.round(rect.width);
        const h = Math.round(rect.height);
        setViewportSize({ width: w, height: h });
        if (!cameraInitializedRef.current) {
          cameraInitializedRef.current = true;
          setCamera(computeFitCamera(w, h));
        }
      }
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, [computeFitCamera]);

  // Detect Web Bluetooth availability for evaluator auto-suggestion & hardware BLE support
  useEffect(() => {
    const nav =
      typeof navigator !== 'undefined'
        ? (navigator as Navigator & {
            bluetooth?: { requestDevice: (opts: { acceptAllDevices: boolean }) => Promise<{ name?: string }> };
          })
        : null;
    if (nav && 'bluetooth' in nav && nav.bluetooth) {
      setBleState('available');
    } else {
      setBleState('unsupported');
    }
  }, []);

  // Close mobile sheet, telemetry drawer, or online dropdown on Escape
  useEffect(() => {
    if (!isMobileSheetOpen && !isTelemetryOpen && !isOnlineDropdownOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsMobileSheetOpen(false);
        setIsTelemetryOpen(false);
        setIsOnlineDropdownOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isMobileSheetOpen, isTelemetryOpen, isOnlineDropdownOpen]);

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

  const activeRoute = useMemo(() => {
    if (!activeTarget) return null;
    return runAStarBetweenCoordinates(
      nodes,
      edges,
      { x: userPose.x, y: userPose.y },
      activeTarget.coords
    );
  }, [userPose.x, userPose.y, activeTarget, nodes, edges]);

  const liveDirectDistance = useMemo(() => {
    if (!activeTarget) return 0;
    return Math.hypot(activeTarget.coords.x - userPose.x, activeTarget.coords.y - userPose.y);
  }, [userPose.x, userPose.y, activeTarget]);

  const remainingDistanceMeters = useMemo(() => {
    if (!activeTarget) return 0;
    if (activeRoute && activeRoute.totalDistance > 0) {
      return activeRoute.totalDistance;
    }
    return liveDirectDistance;
  }, [activeRoute, liveDirectDistance, activeTarget]);

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

  const connectHardwareBle = useCallback(async () => {
    const nav =
      typeof navigator !== 'undefined'
        ? (navigator as Navigator & {
            bluetooth?: { requestDevice: (opts: { acceptAllDevices: boolean }) => Promise<{ name?: string }> };
          })
        : null;
    if (!nav?.bluetooth) {
      setBleState('unsupported');
      setBleSuggestionDismissed(false);
      return;
    }
    try {
      const device = await nav.bluetooth.requestDevice({ acceptAllDevices: true });
      setBleDeviceName(device?.name || 'BLE Beacon');
      setBleState('connected');
      setIsSimulating(false);
      setBleSuggestionDismissed(true);
    } catch {
      setBleState('denied');
      setBleSuggestionDismissed(false);
    }
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

  const requestSensorAccess = async () => {
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
  };

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

    // 1. Deep Obsidian Survey Backdrop
    ctx.fillStyle = '#080C14';
    ctx.fillRect(0, 0, viewW, viewH);

    // Subtle survey coordinate dots outside building
    const { scale, panX, panY } = camera;
    const stepPx = scale * 2;
    if (stepPx >= 16) {
      ctx.fillStyle = 'rgba(148, 163, 184, 0.12)';
      const startX = ((panX % stepPx) + stepPx) % stepPx;
      const startY = ((panY % stepPx) + stepPx) % stepPx;
      for (let gx = startX; gx < viewW; gx += stepPx) {
        for (let gy = startY; gy < viewH; gy += stepPx) {
          ctx.fillRect(gx - 0.75, gy - 0.75, 1.5, 1.5);
        }
      }
    }

    // Helper: World meters -> Screen px
    const wx = (mx: number) => panX + mx * scale;
    const wy = (my: number) => panY + my * scale;

    // 2. Walkable Corridors & Main Concourse Pavement (Visibly lighter than enclosed rooms!)
    const bx = wx(WORLD_BOUNDS.minX);
    const by = wy(WORLD_BOUNDS.minY);
    const bw = WORLD_BOUNDS.width * scale;
    const bh = WORLD_BOUNDS.height * scale;

    ctx.save();
    ctx.beginPath();
    ctx.rect(bx, by, bw, bh);
    ctx.clip();

    // Lit architectural terrazzo corridor floor
    ctx.fillStyle = '#1E293B';
    ctx.fillRect(bx, by, bw, bh);

    // Subtle 2m x 2m floor tile lines across walkable corridors
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

    // Subtle corridor circulation centerline guides (dashed architectural lane markers)
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
    ctx.lineWidth = Math.max(1, scale * 0.04);
    ctx.setLineDash([6, 8]);
    // East-West concourse axis
    ctx.beginPath();
    ctx.moveTo(wx(2.0), wy(12.5));
    ctx.lineTo(wx(13.0), wy(12.5));
    ctx.moveTo(wx(19.0), wy(12.5));
    ctx.lineTo(wx(30.0), wy(12.5));
    // North-South corridor axis
    ctx.moveTo(wx(16.0), wy(4.8));
    ctx.lineTo(wx(16.0), wy(10.0));
    ctx.moveTo(wx(16.0), wy(15.0));
    ctx.lineTo(wx(16.0), wy(23.0));
    ctx.stroke();
    ctx.setLineDash([]);

    // Corridor & Lobby Architectural Zone Labels
    if (scale >= 11) {
      const hallFont = Math.max(8.5, Math.min(11, scale * 0.34));
      ctx.fillStyle = 'rgba(148, 163, 184, 0.42)';
      ctx.font = `600 ${hallFont}px "JetBrains Mono", monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('NORTH CORRIDOR', wx(16.0), wy(7.1));
      ctx.fillText('SOUTH LOBBY', wx(16.0), wy(21.8));
      ctx.fillText('WEST CONCOURSE', wx(7.0), wy(14.3));
      ctx.fillText('EAST CONCOURSE', wx(25.0), wy(14.3));
      ctx.textAlign = 'left';
    }

    // 3. Enclosed Rooms, Recessed Floor Surfaces & CAD Furniture Context
    FLOOR_ROOMS.forEach((r) => {
      const rx = wx(r.x);
      const ry = wy(r.y);
      const rw = r.w * scale;
      const rh = r.h * scale;
      const isRoomTarget = targetRoomId === r.id;
      const isAtrium = r.id === 'corr_center';

      ctx.fillStyle = isRoomTarget
        ? 'rgba(56, 189, 248, 0.14)'
        : isAtrium
          ? '#172236'
          : '#111827';
      ctx.fillRect(rx, ry, rw, rh);

      // Subtle architectural room furniture & structural inlays (low-contrast CAD layer)
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.13)';
      ctx.fillStyle = 'rgba(148, 163, 184, 0.045)';
      ctx.lineWidth = Math.max(1, scale * 0.04);

      if (r.id === 'room_101') {
        // Two Lab workbenches on west wall + corner instrumentation desk
        ctx.fillRect(wx(2.0), wy(3.2), 2.3 * scale, 1.1 * scale);
        ctx.strokeRect(wx(2.0), wy(3.2), 2.3 * scale, 1.1 * scale);
        ctx.fillRect(wx(2.0), wy(5.6), 2.3 * scale, 1.1 * scale);
        ctx.strokeRect(wx(2.0), wy(5.6), 2.3 * scale, 1.1 * scale);
        ctx.fillRect(wx(8.2), wy(1.7), 2.0 * scale, 1.2 * scale);
        ctx.strokeRect(wx(8.2), wy(1.7), 2.0 * scale, 1.2 * scale);
      } else if (r.id === 'room_102') {
        // Boardroom oval table in upper-right clear of peer pin (26, 5)
        ctx.beginPath();
        ctx.roundRect(wx(24.0), wy(2.0), 4.6 * scale, 1.6 * scale, 0.75 * scale);
        ctx.fill();
        ctx.stroke();
        // Chair ticks along top & bottom of table
        for (let cx = 24.7; cx <= 28.0; cx += 1.1) {
          ctx.beginPath();
          ctx.arc(wx(cx), wy(1.75), 0.18 * scale, 0, Math.PI * 2);
          ctx.arc(wx(cx), wy(3.85), 0.18 * scale, 0, Math.PI * 2);
          ctx.stroke();
        }
      } else if (r.id === 'room_105') {
        // 3 Server rack bays along north wall
        for (const sx of [13.9, 15.5, 17.1]) {
          ctx.fillRect(wx(sx), wy(1.45), 1.0 * scale, 0.65 * scale);
          ctx.strokeRect(wx(sx), wy(1.45), 1.0 * scale, 0.65 * scale);
        }
      } else if (r.id === 'room_103') {
        // 3 circular cafe tables clear of peer pin (6, 20)
        for (const [tx, ty] of [
          [2.7, 18.6],
          [2.7, 21.8],
          [8.4, 22.1],
        ]) {
          ctx.beginPath();
          ctx.arc(wx(tx), wy(ty), 0.68 * scale, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      } else if (r.id === 'room_104') {
        // Executive L-desk along east wall + lounge corner table clear of (26, 20)
        ctx.fillRect(wx(28.5), wy(18.0), 1.5 * scale, 4.0 * scale);
        ctx.strokeRect(wx(28.5), wy(18.0), 1.5 * scale, 4.0 * scale);
        ctx.beginPath();
        ctx.arc(wx(23.3), wy(22.1), 0.65 * scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else if (isAtrium) {
        // Central Atrium architectural medallion & 4 structural columns
        ctx.beginPath();
        ctx.arc(wx(16.0), wy(12.5), 1.85 * scale, 0, Math.PI * 2);
        ctx.stroke();
        for (const [colX, colY] of [
          [13.45, 10.45],
          [18.25, 10.45],
          [13.45, 14.25],
          [18.25, 14.25],
        ]) {
          ctx.fillStyle = 'rgba(100, 116, 139, 0.35)';
          ctx.fillRect(wx(colX), wy(colY), 0.3 * scale, 0.3 * scale);
        }
      }

      if (isRoomTarget) {
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(rx + 1, ry + 1, rw - 2, rh - 2);
      }

      // Room Typography
      const labelFontSize = Math.max(10, Math.min(13.5, scale * 0.44));
      const codeFontSize = Math.max(8.5, Math.min(10.5, scale * 0.34));
      const labelPadX = Math.max(8, scale * 0.45);
      const labelPadY = Math.max(16, scale * 0.85);

      ctx.fillStyle = isRoomTarget ? '#7DD3FC' : '#E2E8F0';
      ctx.font = `600 ${labelFontSize}px "Plus Jakarta Sans", system-ui, sans-serif`;
      ctx.fillText(r.name, rx + labelPadX, ry + labelPadY);

      const code = ROOM_CODES[r.id];
      if (code && scale >= 14 && !isAtrium) {
        ctx.fillStyle = '#64748B';
        ctx.font = `500 ${codeFontSize}px "JetBrains Mono", monospace`;
        ctx.fillText(`RM ${code}`, rx + labelPadX, ry + labelPadY + codeFontSize + 5);
      }
    });

    // 4. Open Doorway Floor Thresholds & CAD Door-Swing Arcs
    FLOOR_ROOMS.forEach((r) => {
      const rx = wx(r.x);
      const ry = wy(r.y);
      const rw = r.w * scale;
      const rh = r.h * scale;
      const isAtrium = r.id === 'corr_center';

      r.doors.forEach((d) => {
        const doorLenPx = (d.end - d.start) * scale;
        const swingR = Math.min(doorLenPx * 0.55, scale * 1.15);

        // Paint doorway threshold floor strip in corridor color so wall visibly opens
        ctx.strokeStyle = '#1E293B';
        ctx.lineWidth = Math.max(4, scale * 0.22);
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

        // Subtle dashed cyan threshold saddle line
        ctx.strokeStyle = isAtrium ? 'rgba(56, 189, 248, 0.42)' : 'rgba(56, 189, 248, 0.32)';
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

        // Architectural CAD inward door swing arc on standard enclosed rooms
        if (!isAtrium && scale >= 12) {
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
          ctx.lineWidth = 1.1;
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
        }
      });
    });

    // 5. Crisp Structural Partition Walls + Thick Exterior Envelope
    ctx.lineCap = 'square';
    FLOOR_WALL_SEGMENTS.forEach((w, idx) => {
      const isOuter = idx < 4;
      ctx.strokeStyle = isOuter ? '#64748B' : '#4E6382';
      ctx.lineWidth = isOuter ? Math.max(3.2, scale * 0.17) : Math.max(2.2, scale * 0.12);
      ctx.beginPath();
      ctx.moveTo(wx(w.x1), wy(w.y1));
      ctx.lineTo(wx(w.x2), wy(w.y2));
      ctx.stroke();
    });

    ctx.restore(); // Release building footprint clip

    // Crisp outer perimeter frame stroke cleanly framing the building shell
    ctx.strokeStyle = '#64748B';
    ctx.lineWidth = Math.max(2.8, scale * 0.15);
    ctx.strokeRect(bx, by, bw, bh);

    // 6. 3-Layer High-Craft Wayfinding Path + Forward Directional Chevrons
    if (activeRoute && activeRoute.pathCoordinates.length > 1) {
      const coords = activeRoute.pathCoordinates;

      // Layer A: Soft atmospheric sky-cyan glow
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.22)';
      ctx.lineWidth = Math.max(9, scale * 0.38);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(wx(coords[0].x), wy(coords[0].y));
      coords.forEach((c) => ctx.lineTo(wx(c.x), wy(c.y)));
      ctx.stroke();

      // Layer B: Dark contrast casing separating route from corridor tiles & threshold lines
      ctx.strokeStyle = '#09111E';
      ctx.lineWidth = Math.max(4.5, scale * 0.21);
      ctx.beginPath();
      ctx.moveTo(wx(coords[0].x), wy(coords[0].y));
      coords.forEach((c) => ctx.lineTo(wx(c.x), wy(c.y)));
      ctx.stroke();

      // Layer C: Bright animated directional route core
      ctx.strokeStyle = '#38BDF8';
      ctx.lineWidth = Math.max(2.6, scale * 0.12);
      ctx.setLineDash([8, 6]);
      ctx.lineDashOffset = -pulseAnim * 28;
      ctx.beginPath();
      ctx.moveTo(wx(coords[0].x), wy(coords[0].y));
      coords.forEach((c) => ctx.lineTo(wx(c.x), wy(c.y)));
      ctx.stroke();
      ctx.setLineDash([]);

      // Forward directional chevron arrowheads along path segments
      const chevronSpacingM = 3.0;
      const chevronSize = Math.max(4.5, Math.min(7.5, scale * 0.23));
      ctx.strokeStyle = '#E0F2FE';
      ctx.lineWidth = Math.max(1.6, scale * 0.075);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (let i = 0; i < coords.length - 1; i++) {
        const ax = coords[i].x;
        const ay = coords[i].y;
        const dx = coords[i + 1].x - ax;
        const dy = coords[i + 1].y - ay;
        const segLen = Math.hypot(dx, dy);
        if (segLen < 1.8) continue;

        const angle = Math.atan2(dy, dx);
        const count = Math.floor(segLen / chevronSpacingM);
        for (let k = 1; k <= count; k++) {
          const frac = (k * chevronSpacingM) / (segLen + 0.5);
          if (frac <= 0.15 || frac >= 0.88) continue;
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
        ctx.fillStyle = '#09111E';
        ctx.beginPath();
        ctx.arc(turnX, turnY, Math.max(3.5, scale * 0.15), 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#7DD3FC';
        ctx.lineWidth = 1.8;
        ctx.stroke();
      }
    }

    // Room target pin if navigating to a room
    if (targetRoomId && activeTarget && !activeTarget.isPeer) {
      const tx = wx(activeTarget.coords.x);
      const ty = wy(activeTarget.coords.y);

      ctx.strokeStyle = `rgba(56, 189, 248, ${0.8 * (1 - pulseAnim)})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(tx, ty, 9 + pulseAnim * 20, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = '#38BDF8';
      ctx.beginPath();
      ctx.arc(tx, ty, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // 6. Building Demo Bots (optional toggle) + Real-Time Connected Live Users
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
        const textWidth = ctx.measureText(labelText).width;
        const boxW = textWidth + 14;
        const boxH = 22;
        const boxX = Math.max(10, Math.min(viewW - boxW - 10, px - boxW / 2));
        const boxY = Math.max(10, py - 34);

        ctx.fillStyle = 'rgba(17, 22, 34, 0.94)';
        ctx.beginPath();
        ctx.roundRect(boxX, boxY, boxW, boxH, 6);
        ctx.fill();
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.6)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#FDE68A';
        ctx.fillText(labelText, boxX + 7, boxY + 14.5);
      } else {
        ctx.fillStyle = '#64748B';
        ctx.beginPath();
        ctx.arc(px, py, 5.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#0B0F17';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = '#94A3B8';
        ctx.font = '500 10.5px "Plus Jakarta Sans", system-ui, sans-serif';
        const first = peer.fullName.split(' ')[0];
        const w = ctx.measureText(first).width;
        ctx.fillText(first, px - w / 2, py - 10);
      }
    });

    // Live Connected Users (Supabase/InsForge Realtime Presence)
    liveUsers.forEach((lu) => {
      const lx = wx(lu.x);
      const ly = wy(lu.y);
      const isTarget = targetLiveUserId === lu.id;

      // Soft colored aura
      ctx.fillStyle = `${lu.color}2A`;
      ctx.beginPath();
      ctx.arc(lx, ly, isTarget ? 15 + pulseAnim * 12 : 13, 0, Math.PI * 2);
      ctx.fill();

      if (isTarget) {
        ctx.strokeStyle = lu.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(lx, ly, 10 + pulseAnim * 20, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Crisp user pin
      ctx.fillStyle = lu.color;
      ctx.beginPath();
      ctx.arc(lx, ly, 7.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // Name tag pill above marker
      const tagText = lu.name;
      ctx.font = '600 11px "Plus Jakarta Sans", system-ui, sans-serif';
      const tagWidth = ctx.measureText(tagText).width;
      const pillW = tagWidth + 16;
      const pillH = 22;
      const pillX = Math.max(8, Math.min(viewW - pillW - 8, lx - pillW / 2));
      const pillY = Math.max(8, ly - 34);

      ctx.fillStyle = 'rgba(17, 22, 34, 0.95)';
      ctx.beginPath();
      ctx.roundRect(pillX, pillY, pillW, pillH, 6);
      ctx.fill();
      ctx.strokeStyle = isTarget ? '#FFFFFF' : `${lu.color}B8`;
      ctx.lineWidth = 1.25;
      ctx.stroke();

      ctx.fillStyle = '#F8FAFC';
      ctx.fillText(tagText, pillX + 8, pillY + 14.5);
    });

    // 6.5 Virtual BLE Beacons + Raw Jitter vs. 1D Kalman Trilateration Overlay
    if (isSimulating || isTelemetryOpen) {
      beacons.forEach((b) => {
        const bxPos = wx(b.x);
        const byPos = wy(b.y);
        const dSize = Math.max(4.5, scale * 0.18);

        ctx.fillStyle = '#0B0F17';
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.72)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(bxPos, byPos - dSize);
        ctx.lineTo(bxPos + dSize, byPos);
        ctx.lineTo(bxPos, byPos + dSize);
        ctx.lineTo(bxPos - dSize, byPos);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        if (scale >= 12) {
          ctx.fillStyle = 'rgba(125, 211, 252, 0.85)';
          ctx.font = '600 9.5px "JetBrains Mono", monospace';
          ctx.fillText(b.id, bxPos + dSize + 4, byPos + 3.5);
        }
      });
    }

    if (isSimulating && rawTrilatPose && kalmanTrilatPose) {
      const rxRaw = wx(rawTrilatPose.x);
      const ryRaw = wy(rawTrilatPose.y);
      const kxEst = wx(kalmanTrilatPose.x);
      const kyEst = wy(kalmanTrilatPose.y);

      // Jitter vector from noisy raw RSSI solution to Kalman-smoothed estimate
      ctx.strokeStyle = 'rgba(251, 146, 60, 0.45)';
      ctx.lineWidth = 1.25;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(rxRaw, ryRaw);
      ctx.lineTo(kxEst, kyEst);
      ctx.stroke();
      ctx.setLineDash([]);

      // Raw noisy BLE marker (amber cross/ring)
      ctx.strokeStyle = 'rgba(251, 146, 60, 0.9)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(rxRaw, ryRaw, 4.5, 0, Math.PI * 2);
      ctx.moveTo(rxRaw - 6, ryRaw);
      ctx.lineTo(rxRaw + 6, ryRaw);
      ctx.moveTo(rxRaw, ryRaw - 6);
      ctx.lineTo(rxRaw, ryRaw + 6);
      ctx.stroke();

      // Kalman-smoothed BLE trilateration ring
      ctx.strokeStyle = 'rgba(34, 211, 238, 0.85)';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(kxEst, kyEst, 11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 7. Current User Position Beacon & Heading Cone
    const ux = wx(userPose.x);
    const uy = wy(userPose.y);

    ctx.fillStyle = 'rgba(59, 130, 246, 0.1)';
    ctx.beginPath();
    ctx.arc(ux, uy, userPose.accuracy * scale, 0, Math.PI * 2);
    ctx.fill();

    const headingRad = ((userPose.heading - 90) * Math.PI) / 180;
    const coneRadius = Math.max(36, scale * 1.65);
    const coneGrad = ctx.createRadialGradient(ux, uy, 4, ux, uy, coneRadius);
    coneGrad.addColorStop(0, 'rgba(59, 130, 246, 0.42)');
    coneGrad.addColorStop(1, 'rgba(59, 130, 246, 0.02)');
    ctx.fillStyle = coneGrad;
    ctx.beginPath();
    ctx.moveTo(ux, uy);
    ctx.arc(ux, uy, coneRadius, headingRad - 0.42, headingRad + 0.42);
    ctx.closePath();
    ctx.fill();

    const isWallBlocked = Date.now() < wallHitUntilRef.current;

    ctx.strokeStyle = isWallBlocked
      ? 'rgba(244, 63, 94, 0.9)'
      : `rgba(59, 130, 246, ${0.85 * (1 - pulseAnim)})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(ux, uy, 9 + pulseAnim * 20, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = isWallBlocked ? '#F43F5E' : '#3B82F6';
    ctx.beginPath();
    ctx.arc(ux, uy, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Distinct "You" Marker Tag so current user is immediately distinguishable from peers
    const youText = presenceProfile ? `You · ${presenceProfile.name.split(' ')[0]}` : 'You';
    ctx.font = '700 10.5px "Plus Jakarta Sans", system-ui, sans-serif';
    const youTextW = ctx.measureText(youText).width;
    const youBoxW = youTextW + 14;
    const youBoxH = 20;
    const youBoxX = Math.max(8, Math.min(viewW - youBoxW - 8, ux - youBoxW / 2));
    const youBoxY = Math.min(viewH - youBoxH - 8, uy + 14);

    ctx.fillStyle = 'rgba(30, 58, 138, 0.94)';
    ctx.beginPath();
    ctx.roundRect(youBoxX, youBoxY, youBoxW, youBoxH, 6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(147, 197, 253, 0.85)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(youText, youBoxX + 7, youBoxY + 13.5);

    // 8. Architectural 5m Scale Bar (bottom-left)
    const scaleX = 16;
    const scaleY = viewH - 16;
    const scaleLen = 5 * scale;
    if (scaleLen <= viewW * 0.45) {
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
    userPose,
    activeRoute,
    displayedDemoBots,
    liveUsers,
    presenceProfile,
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

  // Select live user / peer / room OR set laptop coordinate from canvas click coordinates
  const selectMapTargetAtClientPoint = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const screenX = clientX - rect.left;
      const screenY = clientY - rect.top;
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
    [camera, isSpotPickerActive, liveUsers, showDemoBots, peers, nodes, deviceType, isSimulating]
  );

  // Mouse pan & click handlers
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
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
    setCamera((prev) => ({
      ...prev,
      panX: st.origPanX + dx,
      panY: st.origPanY + dy,
    }));
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

  // Touch single-finger pan + two-finger pinch zoom handlers
  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
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
      setCamera((prev) => ({
        ...prev,
        panX: st.origPanX + dx,
        panY: st.origPanY + dy,
      }));
    } else if (e.touches.length === 2 && st.pinchDist && st.pinchDist > 0) {
      const [t1, t2] = [e.touches[0], e.touches[1]];
      const nextDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const ratio = nextDist / st.pinchDist;
      const nextScale = Math.max(10, Math.min(72, st.origScale * ratio));
      const worldX = (st.pinchMidX - st.origPanX) / st.origScale;
      const worldY = (st.pinchMidY - st.origPanY) / st.origScale;
      setCamera({
        scale: nextScale,
        panX: st.pinchMidX - worldX * nextScale,
        panY: st.pinchMidY - worldY * nextScale,
      });
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
  const routeEtaSeconds = Math.max(1, Math.round(remainingDistanceMeters / 1.1));
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
                      <div
                        className="w-9 h-9 rounded-lg flex items-center justify-center font-bold text-xs shrink-0"
                        style={{
                          backgroundColor: `${lu.color}25`,
                          color: lu.color,
                          border: `1px solid ${lu.color}55`,
                        }}
                      >
                        {lu.name[0]?.toUpperCase() || 'U'}
                      </div>
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
                        <div className="font-semibold text-white text-sm truncate">
                          {peer.fullName}
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
    <div className="h-[100dvh] w-full bg-[#0B0F17] text-slate-100 flex flex-col lg:flex-row font-sans select-none overflow-hidden overflow-x-hidden">
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
              <span aria-hidden="true">·</span> {onlinePeersCount} peers
            </p>
          </div>
        </div>

        {/* Directory Search, Tabs & List */}
        <div className="flex-1 min-h-0 flex flex-col pt-4">{renderDirectoryList(false)}</div>

        {/* User Profile & Sign Out Footer */}
        <div className="pt-4 mt-3 border-t border-white/[0.08] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-sky-400/15 border border-sky-400/30 text-sky-300 font-bold text-xs flex items-center justify-center shrink-0">
              {(currentUser.name.trim()[0] || 'U').toUpperCase()}
            </div>
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
              F1 <span aria-hidden="true">·</span> {positioningMode === 'Simulation' ? 'Sim' : `${onlinePeersCount} peers`}
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
        className="flex-1 relative bg-[#0B0F17] overflow-hidden min-h-0"
      >
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

        {/* Mobile Floating Sensor & Online Pill Controls (Top of Map) */}
        <div className="lg:hidden flex items-start justify-between gap-2 absolute top-3 inset-x-3 z-20 pointer-events-none">
          <div className="flex flex-wrap items-center gap-1.5 pointer-events-auto">
            <button
              type="button"
              onClick={requestSensorAccess}
              className={`min-h-[44px] px-3 rounded-xl text-xs font-medium border backdrop-blur-md transition-colors flex items-center gap-1.5 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                motionSensorsActive
                  ? 'bg-[#111622]/92 text-emerald-300 border-emerald-500/35'
                  : 'bg-[#111622]/92 text-slate-200 border-white/[0.1]'
              }`}
            >
              <Smartphone className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>{motionSensorsActive ? 'Motion Active' : 'Sensors'}</span>
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
              onClick={requestSensorAccess}
              className={`min-h-[44px] flex items-center gap-2 px-3.5 rounded-xl text-xs font-medium border backdrop-blur-md transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                motionSensorsActive
                  ? 'bg-[#111622]/90 text-emerald-300 border-emerald-500/35'
                  : 'bg-[#111622]/90 hover:bg-[#171E2E] text-slate-200 border-white/[0.1]'
              }`}
              title="Enable anti-shake walking step detection & compass heading"
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

            {bleState === 'available' && (
              <button
                type="button"
                onClick={connectHardwareBle}
                className="min-h-[44px] flex items-center gap-1.5 px-3.5 rounded-xl text-xs font-medium bg-[#111622]/90 hover:bg-[#171E2E] text-slate-200 border border-white/[0.1] backdrop-blur-md transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                title="Scan physical BLE beacon hardware via Web Bluetooth"
              >
                <Bluetooth className="w-3.5 h-3.5 text-sky-400 shrink-0" aria-hidden="true" />
                <span>Pair BLE</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 pointer-events-auto">
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
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center font-bold text-xs text-white shrink-0"
                      style={{
                        backgroundColor: presenceProfile?.color || '#3B82F6',
                      }}
                    >
                      {(presenceProfile?.name || firstName)[0]?.toUpperCase() || 'Y'}
                    </div>
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
                          setTargetLiveUserId(isRouting ? null : lu.id);
                          setTargetPeerId(null);
                          setTargetRoomId(null);
                          setIsOnlineDropdownOpen(false);
                        }}
                        className={`w-full min-h-[48px] p-2.5 rounded-xl border text-left flex items-center justify-between gap-2 transition-colors ${
                          isRouting
                            ? 'bg-emerald-500/15 border-emerald-400/50'
                            : 'bg-[#0D121D] border-white/[0.08] hover:border-white/[0.2]'
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div
                            className="w-8 h-8 rounded-lg flex items-center justify-center font-bold text-xs text-slate-950 shrink-0"
                            style={{ backgroundColor: lu.color }}
                          >
                            {lu.name[0]?.toUpperCase() || 'U'}
                          </div>
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
                <div>
                  <h2 className="text-sm font-bold text-white">Join Floor Map</h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {deviceType === 'mobile'
                      ? 'Share your live indoor position with others on Floor 1.'
                      : 'Appear on the map now. Click any corridor spot to set your position.'}
                  </p>
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
                        : `~${routeEtaSeconds}s walk · ${userPose.stepCount} steps`}
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
          <div className="hidden lg:flex items-center gap-2.5 absolute bottom-3.5 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-xl bg-[#111622]/85 border border-white/[0.08] backdrop-blur-md text-[11px] text-slate-400 pointer-events-none">
            <span className="font-mono tabular-nums text-slate-200">
              HDG {String(userPose.heading).padStart(3, '0')}°
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">{userPose.stepCount} steps</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">
              {isSimulating ? `Kalman ±${kalmanError.toFixed(1)}m` : `${onlinePeersCount} peers`}
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

                  {bleState === 'available' || bleState === 'denied' ? (
                    <button
                      type="button"
                      onClick={connectHardwareBle}
                      className="min-h-[44px] px-3 rounded-xl text-xs font-medium bg-[#141B2B] hover:bg-[#1B2438] text-slate-200 border border-white/[0.1] flex items-center gap-1.5"
                    >
                      <Bluetooth className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
                      <span>BLE</span>
                    </button>
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
                        : `${remainingDistanceMeters.toFixed(1)}m · ~${routeEtaSeconds}s`
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
                      · ~{routeEtaSeconds}s · {userPose.stepCount} steps
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
              {onlinePeersCount} online
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
                <p className="text-xs text-slate-400 mt-0.5">
                  {onlinePeersCount} active people <span aria-hidden="true">·</span>{' '}
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
    </div>
  );
};
