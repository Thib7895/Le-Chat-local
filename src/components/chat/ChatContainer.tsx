'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Settings, FileUp } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { nanoid } from 'nanoid';
import { useChatStore } from '@/stores/chatStore';
import { MistralLogo } from '@/components/icons';
import { Message } from './Message';
import { InputBar } from './InputBar';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { ImageAttachment } from '@/lib/types';
import { convertFileToBase64, isImageFile, stripMarkdownForTTS, splitTextForTTS } from '@/lib/utils';

export function ChatContainer() {
  const { messages, isLoading, isGeneratingImage, sendMessage, generateImage, clearMessages } = useChatStore();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const hasMessages = messages.length > 0;

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
    generateImage(prompt);
  }, [generateImage]);


  // --- Send Message ---
  const handleSend = (content: string, image?: ImageAttachment | null) => {
    sendMessage(content, image || null);
    setSelectedImage(null);
  };

  const handleNewChat = () => {
    stopSpeaking();
    clearMessages();
    setSelectedImage(null);
  };

  // --- TTS ---
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
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#FAFAFA' }}>
      {/* Settings button */}
      <button
        onClick={() => setIsSettingsOpen(true)}
        style={{
          position: 'fixed',
          top: 16,
          right: 16,
          zIndex: 20,
          padding: 10,
          borderRadius: 12,
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
        }}
        aria-label="Settings"
      >
        <Settings style={{ width: 20, height: 20, color: '#9CA3AF' }} />
      </button>

      {/* ===== DRAG & DROP OVERLAY ===== */}
      {isDragging && (
        <div
          style={{
            position: 'fixed',
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

      {/* Empty State - Logo higher, input bar below */}
      {!hasMessages && (
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '0 16px',
        }}>
          {/* Logo - pushed to ~38% from top */}
          <div style={{
            flex: 1.2,
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
            paddingBottom: 40,
          }}>
            <MistralLogo style={{ width: 72, height: 72 }} />
          </div>

          {/* Input Bar - in lower portion */}
          <div style={{
            flex: 1,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            width: '100%',
            paddingTop: 8,
          }}>
            <div style={{ width: '100%', maxWidth: 700 }}>
              <InputBar
                onSend={handleSend}
                onNewChat={handleNewChat}
                onGenerateImage={handleGenerateImage}
                disabled={isLoading}
                isGeneratingImage={isGeneratingImage}
                selectedImage={selectedImage}
                onClearImage={handleClearImage}
              />
            </div>
          </div>
        </div>
      )}

      {/* Chat State - Messages + Fixed Input */}
      {hasMessages && (
        <>
          {/* Messages area - scrollable */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <div style={{
              maxWidth: '48rem',
              margin: '0 auto',
              padding: '24px 16px 128px 16px',
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

          {/* Input Bar - Fixed at bottom */}
          <div style={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            background: 'linear-gradient(to top, #FAFAFA 60%, transparent)',
            padding: '24px 16px',
          }}>
            <div style={{ maxWidth: 700, margin: '0 auto' }}>
              <InputBar
                onSend={handleSend}
                onNewChat={handleNewChat}
                onGenerateImage={handleGenerateImage}
                disabled={isLoading}
                isGeneratingImage={isGeneratingImage}
                selectedImage={selectedImage}
                onClearImage={handleClearImage}
              />
            </div>
          </div>
        </>
      )}

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />
    </div>
  );
}
