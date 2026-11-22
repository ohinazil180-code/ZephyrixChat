import React, { useEffect, useRef, useState } from 'react';
import { ZegoUIKitPrebuilt } from '@zegocloud/zego-uikit-prebuilt';
import { Phone, PhoneIncoming, PhoneOff, Video, AlertCircle, X } from 'lucide-react';
import { ZIM } from 'zego-zim-web';
import { translations } from '../i18n/translations';
import { apiFetch } from '../lib/api';
import type {
  ActiveCallSession,
  IncomingCallInvite,
  Locale,
  UserProfile,
} from '../types/zephyrix';
import { Avatar } from './Avatar';

interface CallOverlayProps {
  locale: Locale;
  user: UserProfile;
  zegoConfigured: boolean;
  activeCall: ActiveCallSession | null;
  incomingCall: IncomingCallInvite | null;
  onAcceptIncoming: (invite: IncomingCallInvite) => void;
  onDeclineIncoming: (invite: IncomingCallInvite) => void;
  onEndCall: () => void;
}

export const CallOverlay: React.FC<CallOverlayProps> = ({
  locale,
  user,
  zegoConfigured,
  activeCall,
  incomingCall,
  onAcceptIncoming,
  onDeclineIncoming,
  onEndCall,
}) => {
  const t = translations[locale];
  const containerRef = useRef<HTMLDivElement | null>(null);
  const zpRef = useRef<ZegoUIKitPrebuilt | null>(null);
  const [callError, setCallError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeCall || !zegoConfigured || !containerRef.current) return;

    let cancelled = false;
    setCallError(null);

    const startRoom = async () => {
      try {
        const tokenResp = await apiFetch<{
          appID: number;
          token: string;
          userID: string;
          userName: string;
        }>('/api/v1/zego/token', { method: 'POST' });

        if (cancelled || !containerRef.current) return;

        const kitToken = ZegoUIKitPrebuilt.generateKitTokenForProduction(
          tokenResp.appID,
          tokenResp.token,
          activeCall.roomId,
          user.id,
          user.display_name
        );

        const zp = ZegoUIKitPrebuilt.create(kitToken);
        zpRef.current = zp;
        zp.addPlugins({ ZIM });

        zp.joinRoom({
          container: containerRef.current,
          scenario: {
            mode: activeCall.isGroup ? ZegoUIKitPrebuilt.GroupCall : ZegoUIKitPrebuilt.OneONoneCall,
          },
          showPreJoinView: false,
          turnOnMicrophoneWhenJoining: true,
          turnOnCameraWhenJoining: activeCall.callType !== 'audio',
          showMyCameraToggleButton: true,
          showMyMicrophoneToggleButton: true,
          showAudioVideoSettingsButton: true,
          showScreenSharingButton: true,
          showUserList: activeCall.isGroup,
          showRoomTimer: true,
          showLeavingView: false,
          showLeaveRoomConfirmDialog: false,
          onLeaveRoom: () => {
            onEndCall();
          },
        });
      } catch (err) {
        if (!cancelled) {
          setCallError(err instanceof Error ? err.message : 'Unable to start ZEGOCLOUD call room.');
        }
      }
    };

    void startRoom();

    return () => {
      cancelled = true;
      if (zpRef.current) {
        try {
          zpRef.current.destroy();
        } catch {
          // ignore cleanup errors
        }
        zpRef.current = null;
      }
    };
  }, [activeCall?.callId, activeCall?.roomId, zegoConfigured, user.id, user.display_name]);

  return (
    <>
      {/* Incoming Call Ringing Card */}
      {incomingCall && !activeCall && (
        <div className="fixed inset-x-4 bottom-6 sm:inset-auto sm:top-6 sm:right-6 z-50 w-auto sm:w-[360px] rounded-2xl border border-slate-200 dark:border-white/15 bg-white/95 dark:bg-[#121A2B]/95 backdrop-blur-xl shadow-2xl p-5 space-y-4">
          <div className="flex items-center gap-3.5">
            <Avatar name={incomingCall.caller.displayName} src={incomingCall.caller.avatarUrl} size="lg" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-indigo-600 dark:text-sky-400 flex items-center gap-1.5">
                <PhoneIncoming className="w-3.5 h-3.5" />
                <span>
                  {incomingCall.callType === 'group'
                    ? t.incomingGroupCall
                    : incomingCall.callType === 'audio'
                      ? t.incomingAudioCall
                      : t.incomingVideoCall}
                </span>
              </p>
              <p className="font-display text-base font-bold text-slate-900 dark:text-white truncate">
                {incomingCall.caller.displayName}
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                @{incomingCall.caller.username}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => onDeclineIncoming(incomingCall)}
              className="min-h-[44px] rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold flex items-center justify-center gap-2 transition-colors"
            >
              <PhoneOff className="w-4 h-4" />
              <span>{t.declineCall}</span>
            </button>
            <button
              type="button"
              onClick={() => onAcceptIncoming(incomingCall)}
              className="min-h-[44px] rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center justify-center gap-2 transition-colors"
            >
              {incomingCall.callType === 'audio' ? <Phone className="w-4 h-4" /> : <Video className="w-4 h-4" />}
              <span>{t.acceptCall}</span>
            </button>
          </div>
        </div>
      )}

      {/* Active ZEGOCLOUD Call Overlay */}
      {activeCall && (
        <div className="fixed inset-0 z-50 bg-[#0B101B] flex flex-col">
          <div className="px-4 py-3 flex items-center justify-between border-b border-white/10 bg-[#121A2B] text-white shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <span className="w-9 h-9 rounded-xl bg-indigo-600/20 text-sky-400 flex items-center justify-center shrink-0">
                {activeCall.callType === 'audio' ? <Phone className="w-4 h-4" /> : <Video className="w-4 h-4" />}
              </span>
              <div className="min-w-0">
                <p className="font-display text-sm font-semibold truncate">{activeCall.title}</p>
                <p className="text-xs text-slate-400">
                  {activeCall.isGroup ? t.groupCall : activeCall.callType === 'audio' ? t.audioCall : t.videoCall}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={onEndCall}
              className="min-h-[44px] px-4 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold flex items-center gap-2 shrink-0"
            >
              <PhoneOff className="w-4 h-4" />
              <span>{t.endCall}</span>
            </button>
          </div>

          {!zegoConfigured || callError ? (
            <div className="flex-1 flex items-center justify-center p-6">
              <div className="max-w-md w-full rounded-2xl border border-white/10 bg-[#121A2B] p-6 text-center space-y-4 text-white">
                <div className="w-12 h-12 rounded-2xl bg-amber-500/15 text-amber-400 flex items-center justify-center mx-auto">
                  <AlertCircle className="w-6 h-6" />
                </div>
                <h3 className="font-display text-lg font-bold">{t.zegoCallMissingTitle}</h3>
                <p className="text-sm text-slate-300 leading-relaxed">
                  {callError || t.zegoCallMissingDesc}
                </p>
                <button
                  type="button"
                  onClick={onEndCall}
                  className="min-h-[44px] px-5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold inline-flex items-center gap-2"
                >
                  <X className="w-4 h-4" />
                  <span>{t.close}</span>
                </button>
              </div>
            </div>
          ) : (
            <div ref={containerRef} className="flex-1 w-full h-full min-h-0" />
          )}
        </div>
      )}
    </>
  );
};
