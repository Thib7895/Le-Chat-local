'use client';

import { useState, useLayoutEffect, useEffect } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { ChevronDown, MessageSquare, MoreVertical } from 'lucide-react';
import { CatHeadIcon, SidebarIcon } from '@/components/icons';
import { COLORS } from '@/lib/constants';
import { Conversation } from '@/stores/conversationStore';

interface SidebarProps {
  isOpen: boolean;
  conversations: Conversation[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onNewChat: () => void;
  onToggle: () => void;
}

/** Format timestamp to relative date string */
function formatRelativeDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

  if (date >= today) {
    return "Aujourd'hui";
  } else if (date >= yesterday) {
    return 'Hier';
  } else {
    return date.toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'short',
    });
  }
}

/** Clean markdown formatting from text */
function cleanMarkdown(text: string): string {
  return text
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/_/g, '')
    .trim();
}

// --- CONSTANTS ---
const EXPANDED_W = 260;
const COLLAPSED_W = 56;
const GHOST_START_X = (EXPANDED_W - COLLAPSED_W) / 2; // 102px

// Easing
const EASE_SMOOTH = [0.16, 1, 0.3, 1] as const;

// Transition Definitions
const CONTENT_EXIT = { duration: 0.2, ease: EASE_SMOOTH }; // Fade out text
const GHOST_ENTER = { duration: 0.16, ease: EASE_SMOOTH }; // Ghost appears
const WIDTH_SHRINK = { duration: 0.24, ease: EASE_SMOOTH, delay: 0.1 }; // Shrink starts later (Total 0.34s)
const GHOST_SLIDE = { duration: 0.24, ease: EASE_SMOOTH, delay: 0.1 };  // Slide starts later (Total 0.34s)
// Finish icon swap slightly BEFORE total end (0.34s) to avoid frame jitter
const ICON_SWAP_OUT = { duration: 0.12, ease: 'easeOut' as const, delay: 0.15 }; // Ends at 0.32s
const ICON_SWAP_IN = { duration: 0.12, ease: 'easeIn' as const, delay: 0.15 };   // Ends at 0.32s
const RAIL_ENTER = { duration: 0 };     // Instant appearance (seamless swap)

type SidebarState = 'open' | 'closing' | 'collapsed' | 'opening';

export function Sidebar({
  isOpen,
  conversations,
  currentId,
  onSelect,
  onDelete,
  onNewChat,
  onToggle,
}: SidebarProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [expandedNewChatHovered, setExpandedNewChatHovered] = useState(false);
  const [collapsedNewChatHovered, setCollapsedNewChatHovered] = useState(false);
  const [toggleHovered, setToggleHovered] = useState(false);
  const [logoHovered, setLogoHovered] = useState(false);

  // Internal state
  const [state, setState] = useState<SidebarState>(isOpen ? 'open' : 'collapsed');
  const shouldReduceMotion = useReducedMotion();

  // --- EFFECT: Handle external isOpen changes (Guard for re-opening) ---
  useEffect(() => {
    if (isOpen) {
      // If parent opens and we are collapsed or closing, switch to opening
      if (state === 'collapsed' || state === 'closing') {
        setState(shouldReduceMotion ? 'open' : 'opening');
      }
    } else {
      // If parent closes, we trigger closing via handleClose usually, 
      // but if we are 'open' here it means external close event
      if (state === 'open' || state === 'opening') {
        // Rely on handleClose mostly, but sync if needed
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, shouldReduceMotion]);

  // --- HANDLERS ---
  const handleClose = () => {
    if (shouldReduceMotion) {
      setState('collapsed');
      onToggle();
    } else {
      setState('closing');
      // Note: onToggle() will be called at end of animation to sync width
    }
  };

  const handleOpenLocal = () => {
    onToggle(); // Set width true immediately for layout
    setState(shouldReduceMotion ? 'open' : 'opening');
  };

  const handleNewChatClick = () => {
    if (!isOpen) {
      handleOpenLocal();
    }
    onNewChat();
  };

  useLayoutEffect(() => {
    // Reset hover states on toggle
    setExpandedNewChatHovered(false);
    setCollapsedNewChatHovered(false);
    setLogoHovered(false);
    setToggleHovered(false);
  }, [state]);

  // --- VISIBILITY LOGIC ---
  const showContent = state === 'open' || state === 'opening';
  const showGhost = state === 'closing';
  const showRail = state === 'collapsed';

  // Current Width for animation
  const targetWidth = (state === 'closing' || state === 'collapsed') ? COLLAPSED_W : EXPANDED_W;
  const widthTransition = (state === 'closing') ? WIDTH_SHRINK : { duration: 0.24, ease: EASE_SMOOTH };

  return (
    <motion.div
      initial={false}
      animate={{ width: targetWidth, minWidth: targetWidth }}
      transition={shouldReduceMotion ? { duration: 0 } : widthTransition}
      style={{
        height: '100%',
        backgroundColor: '#F9F9F9',
        borderRight: '1px solid #E5E7EB',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        zIndex: 50,
        willChange: 'width'
      }}
      onAnimationComplete={(definition) => {
        // Trigger end of closing
        if (state === 'closing' && (definition as any).width === COLLAPSED_W) {
          onToggle(); // Notify parent
          setState('collapsed');
        }
        // End of opening
        if (state === 'opening' && (definition as any).width === EXPANDED_W) {
          setState('open');
        }
      }}
    >
      {/* LAYER 1: EXPANDED CONTENT */}
      <AnimatePresence>
        {showContent && (
          <motion.div
            key="content"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -6 }} // Starts immediately on 'closing'
            transition={shouldReduceMotion ? { duration: 0 } : CONTENT_EXIT}
            style={{
              position: 'absolute',
              top: 0, left: 0,
              width: EXPANDED_W,
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {/* Header */}
            <div style={{
              padding: '12px 12px 12px 20px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{
                  width: 32, height: 32, borderRadius: 8, backgroundColor: '#FF6B35',
                  display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}>
                  <CatHeadIcon style={{ width: 18, height: 13, color: 'white' }} />
                </div>
                <ChevronDown size={16} color="#6B6B6B" />
              </div>
              <button
                onClick={handleClose}
                onMouseEnter={() => setToggleHovered(true)}
                onMouseLeave={() => setToggleHovered(false)}
                style={{
                  width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  borderRadius: 8, border: 'none', cursor: 'pointer',
                  backgroundColor: toggleHovered ? '#E5E5E5' : 'transparent',
                  color: '#6B6B6B',
                }}
              >
                <SidebarIcon style={{ width: 20, height: 20 }} />
              </button>
            </div>

            {/* New Chat Button */}
            <div style={{ padding: '4px 8px' }}>
              <button
                onClick={onNewChat}
                onMouseEnter={() => setExpandedNewChatHovered(true)}
                onMouseLeave={() => setExpandedNewChatHovered(false)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
                  width: '100%', borderRadius: 8, border: 'none', cursor: 'pointer',
                  backgroundColor: expandedNewChatHovered ? '#EBEBEB' : 'transparent',
                  boxShadow: expandedNewChatHovered ? 'inset 3px 0 0 0 #FF6B35' : 'none',
                  color: '#1A1A1A', fontSize: 14,
                }}
              >
                <MessageSquare size={20} color={expandedNewChatHovered ? '#FF6B35' : '#6B7280'} />
                New Chat
              </button>
            </div>

            {/* List */}
            <div style={{ padding: '12px 16px 8px 20px', fontSize: 12, fontWeight: 500, color: '#6B6B6B' }}>
              Chats
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px' }}>
              {conversations.map((conv) => (
                <div key={conv.id}
                  onClick={() => onSelect(conv.id)}
                  style={{
                    padding: '10px 12px', margin: '2px 0', borderRadius: 8, cursor: 'pointer',
                    backgroundColor: conv.id === currentId ? '#EBEBEB' : 'transparent',
                    boxShadow: conv.id === currentId ? 'inset 3px 0 0 0 #FF6B35' : 'none',
                  }}
                >
                  <div style={{ fontSize: 14, color: COLORS.text.primary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {cleanMarkdown(conv.title)}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* LAYER 2: GHOST OVERLAY (Moving Icons) */}
      <AnimatePresence>
        {showGhost && (
          <motion.div
            key="ghost"
            initial={{ opacity: 0, x: GHOST_START_X }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0 }}
            transition={{
              opacity: shouldReduceMotion ? { duration: 0 } : GHOST_ENTER,
              x: shouldReduceMotion ? { duration: 0 } : GHOST_SLIDE, // Slide delay allows center pause before moving
            }}
            style={{
              position: 'absolute',
              top: 0, left: 0, // Stable anchor left: 0
              width: COLLAPSED_W, // Fixed width 56px
              height: '100%',
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              paddingTop: 12, gap: 8,
              pointerEvents: 'none'
            }}
          >
            {/* 1. TOP ICON (Swap: Rectangle -> Chat) */}
            <div style={{ position: 'relative', width: 32, height: 32 }}>

              {/* A. Close Icon (Rectangle) - Starts visible, fades out */}
              <motion.div
                initial={{ opacity: 1 }}
                animate={{ opacity: 0 }}
                transition={shouldReduceMotion ? { duration: 0 } : ICON_SWAP_OUT}
                style={{
                  position: 'absolute', inset: 0,
                  borderRadius: 8, backgroundColor: 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}
              >
                <SidebarIcon style={{ width: 22, height: 22, color: '#6B6B6B' }} />
              </motion.div>

              {/* B. Cat Head (Chat) - Starts invisible, fades in */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={shouldReduceMotion ? { duration: 0 } : ICON_SWAP_IN}
                style={{
                  position: 'absolute', inset: 0,
                  borderRadius: 8, backgroundColor: '#FF6B35',
                  display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}
              >
                <CatHeadIcon style={{ width: 18, height: 13, color: 'white' }} />
              </motion.div>
            </div>

            {/* 2. NEW CHAT ICON (Stable) */}
            <div style={{
              width: 32, height: 32, borderRadius: 8, backgroundColor: '#F0F0F0',
              display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}>
              <MessageSquare size={16} color="#6B7280" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* LAYER 3: FINAL COLLAPSED RAIL */}
      <AnimatePresence>
        {showRail && (
          <motion.div
            key="rail"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={shouldReduceMotion ? { duration: 0 } : RAIL_ENTER} // Crossfade with Ghost exit
            style={{
              position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              paddingTop: 12, gap: 8
            }}
          >
            <button
              onClick={handleOpenLocal}
              onMouseEnter={() => setLogoHovered(true)}
              onMouseLeave={() => setLogoHovered(false)}
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                backgroundColor: logoHovered ? '#E5E5E5' : '#FF6B35',
                border: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              {logoHovered ? (
                <SidebarIcon style={{ width: 18, height: 18, color: '#6B7280' }} />
              ) : (
                <CatHeadIcon style={{ width: 18, height: 13, color: 'white' }} />
              )}
            </button>

            <button
              onClick={handleNewChatClick}
              onMouseEnter={() => setCollapsedNewChatHovered(true)}
              onMouseLeave={() => setCollapsedNewChatHovered(false)}
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                border: 'none',
                backgroundColor: collapsedNewChatHovered ? '#E5E5E5' : '#F0F0F0',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              <MessageSquare size={16} color="#6B7280" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

    </motion.div>
  );
}
