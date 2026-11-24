import type { SocketMessage } from '@insforge/sdk';
import { insforge } from '../lib/insforge';
import type { LivePresenceUser, PresenceDeviceType } from '../types/simulator';

export const LIVE_USERS_CHANNEL = 'live-indoor-users';
const PROFILE_STORAGE_KEY = 'indoornav_presence_profile_v1';
const TAB_ID_STORAGE_KEY = 'indoornav_presence_tab_id_v1';
const THROTTLE_MS = 300;
const HEARTBEAT_MS = 7000;
const STALE_TIMEOUT_MS = 22000;

export const PRESENCE_AVATAR_COLORS = [
  '#10B981', // Emerald
  '#EC4899', // Pink
  '#F59E0B', // Amber
  '#A855F7', // Violet
  '#22D3EE', // Cyan
  '#FB7185', // Rose
  '#84CC16', // Lime
  '#F97316', // Orange
] as const;

export interface SavedPresenceProfile {
  name: string;
  color: string;
}

export function detectDeviceType(): PresenceDeviceType {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return 'laptop';
  }
  const ua = navigator.userAgent || '';
  const isMobileUa = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const isTouchCompact = navigator.maxTouchPoints > 1 && window.innerWidth < 1024;
  return isMobileUa || isTouchCompact ? 'mobile' : 'laptop';
}

export function getSavedPresenceProfile(): SavedPresenceProfile | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedPresenceProfile>;
    if (typeof parsed.name === 'string' && parsed.name.trim().length > 0) {
      return {
        name: parsed.name.trim(),
        color:
          typeof parsed.color === 'string' && parsed.color.startsWith('#')
            ? parsed.color
            : pickAvatarColor(parsed.name.trim()),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function savePresenceProfile(profile: SavedPresenceProfile): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Ignore storage quota / privacy mode failures
  }
}

export function getOrCreateTabSessionId(): string {
  const fallback = `usr_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
  if (typeof window === 'undefined') return fallback;
  try {
    const existing = window.sessionStorage.getItem(TAB_ID_STORAGE_KEY);
    if (existing && existing.length > 4) return existing;
    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `usr_${crypto.randomUUID().slice(0, 12)}`
        : fallback;
    window.sessionStorage.setItem(TAB_ID_STORAGE_KEY, id);
    return id;
  } catch {
    return fallback;
  }
}

export function pickAvatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return PRESENCE_AVATAR_COLORS[hash % PRESENCE_AVATAR_COLORS.length];
}

interface PresenceStateMessage extends SocketMessage {
  id?: string;
  presenceId?: string;
  name?: string;
  color?: string;
  avatarUrl?: string;
  x?: number;
  y?: number;
  device?: PresenceDeviceType;
  lastSeen?: number;
}

interface PresenceLeavePayload extends SocketMessage {
  id?: string;
}

interface JoinLeaveSystemMessage extends SocketMessage {
  member?: {
    presenceId?: string;
  };
}

export type PresenceConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface PresenceClientOptions {
  localUser: LivePresenceUser;
  onUsersChange: (users: LivePresenceUser[]) => void;
  onStatusChange?: (status: PresenceConnectionStatus) => void;
}

export class LiveFloorPresenceClient {
  private localUser: LivePresenceUser;
  private onUsersChange: (users: LivePresenceUser[]) => void;
  private onStatusChange?: (status: PresenceConnectionStatus) => void;

  private remoteUsers = new Map<string, LivePresenceUser>();
  private isJoined = false;
  private lastPublishAt = 0;
  private trailingTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private pruneTimer: number | null = null;

  private handleUserStateBound: (msg: PresenceStateMessage) => void;
  private handleUserLeaveBound: (msg: PresenceLeavePayload) => void;
  private handlePresenceJoinBound: (msg: JoinLeaveSystemMessage) => void;
  private handlePresenceLeaveBound: (msg: JoinLeaveSystemMessage) => void;
  private handlePresenceSyncBound: () => void;
  private handleDisconnectBound: () => void;
  private handleBeforeUnloadBound: () => void;

  constructor(options: PresenceClientOptions) {
    this.localUser = { ...options.localUser };
    this.onUsersChange = options.onUsersChange;
    this.onStatusChange = options.onStatusChange;

    this.handleUserStateBound = (msg) => this.onUserStateMessage(msg);
    this.handleUserLeaveBound = (msg) => this.onUserLeaveMessage(msg);
    this.handlePresenceJoinBound = () => this.onPresenceJoinEvent();
    this.handlePresenceLeaveBound = (msg) => this.onPresenceLeaveEvent(msg);
    this.handlePresenceSyncBound = () => {
      void this.publishCurrentState(true);
    };
    this.handleDisconnectBound = () => {
      this.onStatusChange?.('connecting');
    };
    this.handleBeforeUnloadBound = () => {
      if (this.isJoined && insforge.realtime.isConnected) {
        void insforge.realtime
          .publish(LIVE_USERS_CHANNEL, 'user:leave', { id: this.localUser.id })
          .catch(() => undefined);
      }
    };
  }

  async start(): Promise<void> {
    if (this.isJoined) return;
    this.isJoined = true;
    this.onStatusChange?.('connecting');

    insforge.realtime.on<PresenceStateMessage>('user:state', this.handleUserStateBound);
    insforge.realtime.on<PresenceLeavePayload>('user:leave', this.handleUserLeaveBound);
    insforge.realtime.on<JoinLeaveSystemMessage>('presence:join', this.handlePresenceJoinBound);
    insforge.realtime.on<JoinLeaveSystemMessage>('presence:leave', this.handlePresenceLeaveBound);
    insforge.realtime.on('presence:sync', this.handlePresenceSyncBound);
    insforge.realtime.on('disconnect', this.handleDisconnectBound);
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.handleBeforeUnloadBound);
    }

    try {
      await insforge.realtime.connect();
      const sub = await insforge.realtime.subscribe(LIVE_USERS_CHANNEL);
      if (!this.isJoined) return;

      if (!sub.ok) {
        this.onStatusChange?.('error');
        return;
      }

      this.onStatusChange?.('connected');
      await this.publishCurrentState(true);

      this.heartbeatTimer = window.setInterval(() => {
        void this.publishCurrentState(true);
      }, HEARTBEAT_MS);

      this.pruneTimer = window.setInterval(() => {
        this.pruneStaleUsers();
      }, 5000);
    } catch {
      if (this.isJoined) {
        this.onStatusChange?.('error');
      }
    }
  }

  updateLocalState(
    patch: Partial<Pick<LivePresenceUser, 'x' | 'y' | 'name' | 'color' | 'avatarUrl' | 'device'>>
  ): void {
    this.localUser = {
      ...this.localUser,
      ...patch,
      lastSeen: Date.now(),
    };
    this.scheduleThrottledPublish();
  }

  async stop(): Promise<void> {
    if (!this.isJoined) return;
    this.isJoined = false;

    if (this.trailingTimer !== null) {
      window.clearTimeout(this.trailingTimer);
      this.trailingTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pruneTimer !== null) {
      window.clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }

    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.handleBeforeUnloadBound);
    }

    if (insforge.realtime.isConnected) {
      await insforge.realtime
        .publish(LIVE_USERS_CHANNEL, 'user:leave', { id: this.localUser.id })
        .catch(() => undefined);
    }

    insforge.realtime.off('user:state', this.handleUserStateBound);
    insforge.realtime.off('user:leave', this.handleUserLeaveBound);
    insforge.realtime.off('presence:join', this.handlePresenceJoinBound);
    insforge.realtime.off('presence:leave', this.handlePresenceLeaveBound);
    insforge.realtime.off('presence:sync', this.handlePresenceSyncBound);
    insforge.realtime.off('disconnect', this.handleDisconnectBound);
    insforge.realtime.unsubscribe(LIVE_USERS_CHANNEL);

    this.remoteUsers.clear();
    this.onUsersChange([]);
    this.onStatusChange?.('disconnected');
  }

  private scheduleThrottledPublish(): void {
    if (!this.isJoined) return;
    const now = Date.now();
    const elapsed = now - this.lastPublishAt;

    if (elapsed >= THROTTLE_MS) {
      if (this.trailingTimer !== null) {
        window.clearTimeout(this.trailingTimer);
        this.trailingTimer = null;
      }
      void this.publishCurrentState(false);
    } else if (this.trailingTimer === null) {
      this.trailingTimer = window.setTimeout(() => {
        this.trailingTimer = null;
        void this.publishCurrentState(false);
      }, THROTTLE_MS - elapsed);
    }
  }

  private async publishCurrentState(force: boolean): Promise<void> {
    if (!this.isJoined || !insforge.realtime.isConnected) return;
    if (!force && Date.now() - this.lastPublishAt < THROTTLE_MS - 15) return;

    this.lastPublishAt = Date.now();
    const payload: LivePresenceUser = {
      ...this.localUser,
      presenceId: insforge.realtime.socketId ?? this.localUser.id,
      x: Number(this.localUser.x.toFixed(2)),
      y: Number(this.localUser.y.toFixed(2)),
      lastSeen: Date.now(),
    };

    try {
      await insforge.realtime.publish(LIVE_USERS_CHANNEL, 'user:state', payload);
    } catch {
      // Transient reconnects will re-sync on presence:sync / next heartbeat
    }
  }

  private onUserStateMessage(msg: PresenceStateMessage): void {
    if (!msg || typeof msg.id !== 'string' || msg.id === this.localUser.id) return;
    if (typeof msg.x !== 'number' || typeof msg.y !== 'number') return;

    const existing = this.remoteUsers.get(msg.id);
    const metaSender = typeof msg.meta?.senderId === 'string' ? msg.meta.senderId : undefined;
    const resolvedPresenceId = msg.presenceId ?? metaSender ?? existing?.presenceId;
    const updated: LivePresenceUser & { authPresenceId?: string } = {
      id: msg.id,
      presenceId: resolvedPresenceId,
      authPresenceId: metaSender ?? (existing as (LivePresenceUser & { authPresenceId?: string }) | undefined)?.authPresenceId,
      name: typeof msg.name === 'string' && msg.name.trim() ? msg.name.trim() : 'Visitor',
      color: typeof msg.color === 'string' ? msg.color : '#10B981',
      avatarUrl:
        typeof msg.avatarUrl === 'string' && /^https?:\/\//i.test(msg.avatarUrl.trim())
          ? msg.avatarUrl.trim()
          : existing?.avatarUrl,
      x: msg.x,
      y: msg.y,
      device: msg.device === 'mobile' ? 'mobile' : 'laptop',
      lastSeen: Date.now(),
    };

    this.remoteUsers.set(updated.id, updated);
    this.emitUsers();
  }

  private onUserLeaveMessage(msg: PresenceLeavePayload): void {
    if (!msg || typeof msg.id !== 'string') return;
    if (this.remoteUsers.delete(msg.id)) {
      this.emitUsers();
    }
  }

  private onPresenceJoinEvent(): void {
    if (!this.isJoined) return;
    window.setTimeout(() => {
      void this.publishCurrentState(true);
    }, 100);
  }

  private onPresenceLeaveEvent(msg: JoinLeaveSystemMessage): void {
    const leftPresenceId = msg?.member?.presenceId;
    if (!leftPresenceId) return;

    let changed = false;
    for (const [id, user] of this.remoteUsers.entries()) {
      const authId = (user as LivePresenceUser & { authPresenceId?: string }).authPresenceId;
      if (user.presenceId === leftPresenceId || authId === leftPresenceId) {
        this.remoteUsers.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.emitUsers();
    }
  }

  private pruneStaleUsers(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, user] of this.remoteUsers.entries()) {
      if (now - user.lastSeen > STALE_TIMEOUT_MS) {
        this.remoteUsers.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.emitUsers();
    }
  }

  private emitUsers(): void {
    const sorted = [...this.remoteUsers.values()].sort((a, b) => a.name.localeCompare(b.name));
    this.onUsersChange(sorted);
  }
}
