export type Locale = 'en' | 'bn';
export type ThemeMode = 'dark' | 'light';
export type ChatType = 'direct' | 'group' | 'channel' | 'saved' | 'ai';

export interface SystemConfig {
  zegoConfigured: boolean;
  nodeEnv: 'development' | 'production';
}

export interface UserProfile {
  id: string;
  email: string;
  username: string;
  display_name: string;
  phone: string;
  country: string;
  avatar_url: string | null;
  bio: string;
  verified_flag: boolean;
  developer_badge: boolean;
  preferred_locale: string;
  is_admin?: boolean;
}

export interface PeerUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio?: string;
  phone?: string;
  country?: string;
  verified: boolean;
  developerBadge?: boolean;
  isBot?: boolean;
  online: boolean;
  lastSeenAt: string;
}

export interface ChatMember extends PeerUser {
  role: 'owner' | 'admin' | 'member';
  joinedAt: string;
}

export interface MessageAttachment {
  id?: string;
  storageKey?: string;
  url: string;
  originalName: string;
  mimeType: string;
  kind: 'image' | 'video' | 'voice' | 'document';
  sizeBytes: number;
  durationMs: number;
  checksum?: string;
}

export interface ReactionUser {
  id: string;
  displayName: string;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  reactedByMe: boolean;
  users?: ReactionUser[];
}

export interface MessageReplyPreview {
  id: string;
  senderName: string;
  body: string;
  deletedAt: string | null;
  attachmentName?: string | null;
  attachmentKind?: 'image' | 'video' | 'voice' | 'document' | null;
}

export interface PendingDirectReply {
  chatId: string;
  quoteText: string;
  senderName: string;
  previewBody: string;
}

export interface ChatMessage {
  id: string;
  clientId?: string | null;
  chatId: string;
  senderId: string;
  senderName: string;
  senderUsername: string | null;
  senderAvatar: string | null;
  senderVerified: boolean;
  senderDeveloperBadge?: boolean;
  isBot?: boolean;
  replyToId?: string | null;
  replyTo?: MessageReplyPreview | null;
  forwardedFrom?: string | null;
  quoteText?: string | null;
  body: string;
  isPinned?: boolean;
  isSilent?: boolean;
  editedAt?: string | null;
  deletedAt: string | null;
  createdAt: string;
  attachments: MessageAttachment[];
  reactions?: MessageReaction[];
  status: 'sending' | 'queued' | 'sent' | 'delivered' | 'read';
}

export interface ChatSummary {
  id: string;
  type: ChatType;
  title: string;
  description?: string;
  avatarUrl?: string | null;
  inviteCode?: string | null;
  zegoRoomId: string;
  myRole: 'owner' | 'admin' | 'member';
  memberCount: number;
  pinnedAt?: string | null;
  archivedAt?: string | null;
  mutedUntil?: string | null;
  createdAt: string;
  peer: PeerUser | null;
  isBlockedByMe: boolean;
  hasBlockedMe: boolean;
  unreadCount: number;
  lastMessage: ChatMessage | null;
  assignedBotId?: string | null;
  assignedBotName?: string | null;
  isBotVerified?: boolean;
}

export interface BotConfig {
  id: string;
  name: string;
  handle: string;
  avatar_url?: string | null;
  description: string;
  provider: 'gemini' | 'custom' | 'openai';
  model: string;
  api_endpoint: string;
  api_key?: string;
  system_instruction: string;
  is_verified: boolean;
  assigned_chat_id?: string | null;
  assigned_chat_title?: string | null;
  created_at: string;
}

export interface SessionInfo {
  id: string;
  device_label: string;
  user_agent: string;
  country_code: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  isCurrent: boolean;
}

export interface OfflineDraftItem {
  clientId: string;
  chatId: string;
  peerId?: string;
  body: string;
  createdAt: string;
}

export interface ActiveCallSession {
  callId: string;
  chatId: string;
  roomId: string;
  title: string;
  callType: 'audio' | 'video' | 'group';
  isGroup: boolean;
}

export interface IncomingCallInvite {
  callId: string;
  chatId: string;
  roomId: string;
  callType: 'audio' | 'video' | 'group';
  caller: {
    id: string;
    displayName: string;
    username: string;
    avatarUrl: string | null;
  };
}
