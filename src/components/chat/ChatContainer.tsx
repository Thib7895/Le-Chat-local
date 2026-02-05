'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { FileUp } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { nanoid } from 'nanoid';
import { useChatStore } from '@/stores/chatStore';
import { useConversationStore } from '@/stores/conversationStore';
import { MistralLogo } from '@/components/icons';
import { Sidebar } from '@/components/layout';
import { Message } from './Message';
import { InputBar } from './InputBar';
import { ImageAttachment } from '@/lib/types';
import { convertFileToBase64, isImageFile, stripMarkdownForTTS, splitTextForTTS } from '@/lib/utils';

export function ChatContainer() {
  const { messages, isLoading, isGeneratingImage, sendMessage, generateImage, clearMessages, loadSettings, cancelGeneration, setMessages } = useChatStore();
  const {
    conversations,
    currentConversationId,
    sidebarOpen,
    initDatabase,
    selectConversation,
    deleteConversation,
    toggleSidebar,
    setSidebarOpen,
    setCurrentConversationId,
  } = useConversationStore();

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const hasMessages = messages.length > 0;

  // Get current conversation title
  const currentConversation = conversations.find((c) => c.id === currentConversationId);
  const currentTitle = currentConversation?.title || 'Le Chat Local';

  // --- Initialize database and load settings on mount ---
  useEffect(() => {
    loadSettings();
    initDatabase();
  }, [loadSettings, initDatabase]);

  // --- Drag & Drop State ---
  const [isDragging, setIsDragging] = useState(false);
  const [selectedImage, setSelectedImage] = useState<ImageAttachment | null>(null);
  const dragCounterRef = useRef(0);

  // --- Drag & Drop via window events (more reliable in Tauri) ---
  useEffect(() => {
    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current += 1;
      if (e.dataTransfer?.types.includes('Files')) {
        setIsDragging(true);
      }
    };

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
    };

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current -= 1;
      if (dragCounterRef.current <= 0) {
        dragCounterRef.current = 0;
        setIsDragging(false);
      }
    };

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDragging(false);

      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;

      const fileArray = Array.from(files);
      const imageFile = fileArray.find(isImageFile);

      if (!imageFile) {
        console.warn('No image file found in drop');
        return;
      }

      try {
        const base64 = await convertFileToBase64(imageFile);
        setSelectedImage({
          id: nanoid(),
          base64,
          name: imageFile.name,
          mimeType: imageFile.type,
        });
      } catch (error) {
        console.error('Failed to convert image to base64:', error);
      }
    };

    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('drop', handleDrop);

    return () => {
      window.removeEventListener('dragenter', handleDragEnter);
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('drop', handleDrop);
    };
  }, []);

  const handleClearImage = useCallback(() => {
    setSelectedImage(null);
  }, []);

  const handleGenerateImage = useCallback((prompt: string) => {
    void generateImage(prompt).catch(() => {
      // Absorb any unhandled rejections (abort errors, etc.)
    });
  }, [generateImage]);

  const handleStopGeneration = useCallback(() => {
    cancelGeneration();
  }, [cancelGeneration]);

  // --- TTS (must be declared before handlers that use stopSpeaking) ---
  const [isSpeaking, setIsSpeaking] = useState(false);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);

  const stopSpeaking = useCallback(() => {
    if (ttsAbortRef.current) ttsAbortRef.current.abort();
    if (currentAudioRef.current) currentAudioRef.current.pause();
    currentAudioRef.current = null;
    ttsAbortRef.current = null;
    setIsSpeaking(false);
  }, []);

  // --- Send Message ---
  const handleSend = (content: string, image?: ImageAttachment | null) => {
    void sendMessage(content, image || null).catch(() => {
      // Absorb any unhandled rejections (abort errors, etc.)
    });
    setSelectedImage(null);
  };

  const handleNewChat = useCallback(async () => {
    cancelGeneration();
    stopSpeaking();
    clearMessages();
    setSelectedImage(null);
    setCurrentConversationId(null);
  }, [cancelGeneration, stopSpeaking, clearMessages, setCurrentConversationId]);

  const handleSelectConversation = useCallback(async (id: string) => {
    try {
      cancelGeneration();
      stopSpeaking();
      const loadedMessages = await selectConversation(id);
      setMessages(loadedMessages);
    } catch (e) {
      console.error('Failed to load conversation:', e);
    }
  }, [cancelGeneration, stopSpeaking, selectConversation, setMessages]);

  const handleDeleteConversation = useCallback(async (id: string) => {
    try {
      const wasCurrentConversation = id === currentConversationId;
      await deleteConversation(id);
      if (wasCurrentConversation) {
        clearMessages();
      }
    } catch (e) {
      console.error('Failed to delete conversation:', e);
    }
  }, [currentConversationId, deleteConversation, clearMessages]);

  const handleSpeak = async (text: string) => {
    // If already speaking, stop
    if (isSpeaking) {
      stopSpeaking();
      return;
    }

    try {
      const { settings } = useChatStore.getState();

      if (!settings.modelsPath) {
        console.error('TTS: Models path not configured in settings');
        return;
      }

      // Strip markdown formatting for natural TTS reading
      const sanitizedText = stripMarkdownForTTS(text);
      if (!sanitizedText.trim()) {
        console.warn('TTS: No readable content after markdown sanitization');
        return;
      }

      // Split into chunks for progressive playback
      const chunks = splitTextForTTS(sanitizedText);
      console.log(`TTS: ${chunks.length} chunk(s)`, { lang: settings.selectedLang });

      const abortController = new AbortController();
      ttsAbortRef.current = abortController;
      setIsSpeaking(true);

      let nextAudioPromise: Promise<string | null> | null = null;

      for (let i = 0; i < chunks.length; i++) {
        if (abortController.signal.aborted) break;

        // Synthesize current chunk (use prefetched result if available)
        let audioBase64: string | null = null;
        try {
          audioBase64 = nextAudioPromise
            ? await nextAudioPromise
            : await invoke<string>('synthesize_speech', {
              text: chunks[i],
              lang: settings.selectedLang,
              modelsPath: settings.modelsPath,
            });
        } catch (synthError) {
          console.warn(`TTS: Chunk ${i + 1}/${chunks.length} synthesis failed, skipping`, synthError);
          nextAudioPromise = null;
          // Still try to prefetch next chunk
          if (i + 1 < chunks.length) {
            nextAudioPromise = invoke<string>('synthesize_speech', {
              text: chunks[i + 1],
              lang: settings.selectedLang,
              modelsPath: settings.modelsPath,
            }).catch(() => null);
          }
          continue;
        }

        if (abortController.signal.aborted) break;
        if (!audioBase64) { nextAudioPromise = null; continue; }

        // Prefetch next chunk while current one plays
        nextAudioPromise = (i + 1 < chunks.length)
          ? invoke<string>('synthesize_speech', {
            text: chunks[i + 1],
            lang: settings.selectedLang,
            modelsPath: settings.modelsPath,
          }).catch(() => null)
          : null;

        // Decode and play current chunk
        try {
          const audioData = Uint8Array.from(atob(audioBase64), c => c.charCodeAt(0));
          const blob = new Blob([audioData], { type: 'audio/wav' });
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          currentAudioRef.current = audio;

          // Wait for playback to finish before next chunk
          await new Promise<void>((resolve, reject) => {
            audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
            audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Playback error')); };

            const onAbort = () => { audio.pause(); URL.revokeObjectURL(url); resolve(); };
            abortController.signal.addEventListener('abort', onAbort, { once: true });

            audio.play().catch(reject);
          });
        } catch (playError) {
          console.warn(`TTS: Chunk ${i + 1}/${chunks.length} playback failed, skipping`, playError);
          continue;
        }
      }

    } catch (error) {
      if (!ttsAbortRef.current?.signal.aborted) {
        console.error('TTS Error:', error);
      }
    } finally {
      setIsSpeaking(false);
      ttsAbortRef.current = null;
      currentAudioRef.current = null;
    }
  };

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'row', background: '#FAFAFA' }}>
      {/* ===== SIDEBAR (always in DOM, width controlled by isOpen) ===== */}
      <Sidebar
        isOpen={sidebarOpen}
        conversations={conversations}
        currentId={currentConversationId}
        onSelect={handleSelectConversation}
        onDelete={handleDeleteConversation}
        onNewChat={handleNewChat}
        onToggle={toggleSidebar}
      />

      {/* ===== MAIN CONTENT AREA ===== */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          minWidth: 0,
          overflow: 'hidden',
          // Smooth transition in sync with sidebar
          transition: 'margin-left 240ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >


        {/* ===== DRAG & DROP OVERLAY ===== */}
        {isDragging && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 50,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(255, 255, 255, 0.85)',
              backdropFilter: 'blur(6px)',
              WebkitBackdropFilter: 'blur(6px)',
              pointerEvents: 'none',
            }}
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 16,
                padding: '48px 64px',
                borderRadius: 24,
                border: '2px dashed #FF6B35',
                background: 'rgba(255, 107, 53, 0.04)',
              }}
            >
              <FileUp
                style={{ width: 48, height: 48, color: '#FF6B35' }}
                strokeWidth={1.5}
              />
              <p style={{
                fontSize: 18,
                fontWeight: 500,
                color: '#1A1A1A',
                margin: 0,
              }}>
                Drop your files here...
              </p>
              <p style={{
                fontSize: 13,
                color: '#9B9B9B',
                margin: 0,
              }}>
                Supports images (PNG, JPG, GIF, WebP)
              </p>
            </div>
          </div>
        )}

        {/* Empty State - Logo + Input in center */}
        {!hasMessages && (
          <div style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 16px',
            paddingBottom: '12vh',
          }}>
            {/* Logo */}
            <div style={{
              marginBottom: 48,
            }}>
              <MistralLogo style={{ width: 96, height: 96 }} />
            </div>

            {/* Input Bar */}
            <div style={{ width: '100%', maxWidth: 750 }}>
              <InputBar
                onSend={handleSend}
                onNewChat={handleNewChat}
                onGenerateImage={handleGenerateImage}
                disabled={isGeneratingImage}
                isGenerating={isLoading && !isGeneratingImage}
                isGeneratingImage={isGeneratingImage}
                onStopGeneration={handleStopGeneration}
                selectedImage={selectedImage}
                onClearImage={handleClearImage}
              />
            </div>
          </div>
        )}

        {/* Chat State - Messages + InputBar at bottom */}
        {hasMessages && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Messages area - scrollable */}
            <div style={{ flex: 1, overflowY: 'auto' }}>
              <div style={{
                maxWidth: '48rem',
                margin: '0 auto',
                padding: '24px 16px',
              }}>
                {messages.map((message, index) => (
                  <Message
                    key={message.id}
                    message={message}
                    onSpeak={handleSpeak}
                    isSpeaking={isSpeaking}
                    isLast={message.role === 'assistant' && index === messages.length - 1}
                  />
                ))}
                <div ref={messagesEndRef} />
              </div>
            </div>

            {/* Input Bar - at bottom of content area (not fixed) */}
            <div style={{
              background: 'linear-gradient(to top, #FAFAFA 60%, transparent)',
              padding: '24px 16px',
            }}>
              <div style={{ maxWidth: 700, margin: '0 auto' }}>
                <InputBar
                  onSend={handleSend}
                  onNewChat={handleNewChat}
                  onGenerateImage={handleGenerateImage}
                  disabled={isGeneratingImage}
                  isGenerating={isLoading && !isGeneratingImage}
                  isGeneratingImage={isGeneratingImage}
                  onStopGeneration={handleStopGeneration}
                  selectedImage={selectedImage}
                  onClearImage={handleClearImage}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
