'use client';

import { useState, useRef, useCallback, useEffect, KeyboardEvent, ChangeEvent } from 'react';
import { Mic, X, Loader2, Square, ImageIcon } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { CatHeadIcon, PlusIcon, SendArrowIcon } from '@/components/icons';
import { ImageAttachment } from '@/lib/types';
import { useChatStore } from '@/stores/chatStore';

interface InputBarProps {
  onSend: (message: string, image?: ImageAttachment | null) => void;
  onNewChat?: () => void;
  onGenerateImage?: (prompt: string) => void;
  disabled?: boolean;
  isGeneratingImage?: boolean;
  selectedImage?: ImageAttachment | null;
  onClearImage?: () => void;
  onMicResult?: (text: string) => void;
}

export function InputBar({ onSend, onNewChat, onGenerateImage, disabled = false, isGeneratingImage = false, selectedImage, onClearImage, onMicResult }: InputBarProps) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // --- Recording State ---
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number>(0);
  const [audioLevels, setAudioLevels] = useState<number[]>(new Array(24).fill(0));

  // Determine if we should show the send arrow instead of mic
  const hasContent = input.trim().length > 0 || !!selectedImage;

  const handleSubmit = useCallback(() => {
    if ((!input.trim() && !selectedImage) || disabled) return;

    const message = input.trim();
    setInput('');

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    onSend(message, selectedImage);
  }, [input, disabled, onSend, selectedImage]);

  const handleImageGenerate = useCallback(() => {
    if (!input.trim() || disabled || isGeneratingImage) return;
    const prompt = input.trim();
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    onGenerateImage?.(prompt);
  }, [input, disabled, isGeneratingImage, onGenerateImage]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);

    const textarea = e.target;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
  };

  // --- Recording Logic ---
  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus',
      });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = async () => {
        // Collect audio data
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm;codecs=opus' });
        audioChunksRef.current = [];

        // Stop all tracks
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;

        // Stop visualization
        if (animFrameRef.current) {
          cancelAnimationFrame(animFrameRef.current);
          animFrameRef.current = 0;
        }
        if (audioCtxRef.current) {
          audioCtxRef.current.close();
          audioCtxRef.current = null;
        }
        analyserRef.current = null;
        setAudioLevels(new Array(24).fill(0));

        // Convert to base64 and transcribe
        setIsTranscribing(true);
        try {
          const arrayBuffer = await audioBlob.arrayBuffer();
          const base64 = btoa(
            new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
          );

          const { settings } = useChatStore.getState();
          // Map settings lang to whisper lang code
          const lang = settings.selectedLang === 'fr-fr' ? 'fr' : settings.selectedLang === 'en-us' ? 'en' : undefined;

          const result = await invoke<{ text: string; language: string }>('stt_transcribe', {
            audioBase64: base64,
            lang,
          });

          if (result.text && result.text.trim()) {
            // Put transcribed text into the input field
            if (onMicResult) {
              onMicResult(result.text.trim());
            } else {
              setInput((prev) => (prev ? prev + ' ' + result.text.trim() : result.text.trim()));
            }
          }
        } catch (error) {
          console.error('STT transcription failed:', error);
        } finally {
          setIsTranscribing(false);
        }
      };

      // Setup Web Audio API for visualization
      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.7;
      source.connect(analyser);
      analyserRef.current = analyser;

      // Start animation loop
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const updateLevels = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);

        // Map frequency bins to 24 LED segments
        const binCount = dataArray.length;
        const levels: number[] = [];
        for (let i = 0; i < 24; i++) {
          const binIndex = Math.floor((i / 24) * binCount);
          levels.push(dataArray[binIndex] / 255);
        }
        setAudioLevels(levels);
        animFrameRef.current = requestAnimationFrame(updateLevels);
      };
      animFrameRef.current = requestAnimationFrame(updateLevels);

      // Start recording
      mediaRecorder.start(100); // Collect data every 100ms
      setIsRecording(true);
    } catch (error) {
      console.error('Failed to start recording:', error);
    }
  }, [onMicResult]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  }, []);

  const handleMicClick = useCallback(() => {
    if (isTranscribing) return;
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isRecording, isTranscribing, startRecording, stopRecording]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (audioCtxRef.current) audioCtxRef.current.close();
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Helper to get LED segment color based on level
  const getLedColor = (level: number): string => {
    if (level < 0.4) return '#22C55E'; // green
    if (level < 0.7) return '#EAB308'; // yellow
    return '#EF4444'; // red
  };

  return (
    <div style={{ width: '100%' }}>
      {/* Main input container */}
      <div
        style={{
          position: 'relative',
          background: '#FFFFFF',
          borderRadius: 24,
          border: isRecording ? '1px solid #EF4444' : '1px solid rgba(229, 231, 235, 0.6)',
          overflow: 'hidden',
          boxShadow: '0 2px 16px rgba(0, 0, 0, 0.06), 0 0px 4px rgba(0, 0, 0, 0.03)',
          transition: 'border-color 0.2s',
        }}
      >
        {/* Image preview - large thumbnail like official Mistral */}
        {selectedImage && !isRecording && (
          <>
            <div style={{
              padding: '16px 20px 0 20px',
            }}>
              <div style={{ position: 'relative', display: 'inline-block' }}>
                <img
                  src={selectedImage.base64}
                  alt={selectedImage.name}
                  style={{
                    maxWidth: 200,
                    maxHeight: 120,
                    borderRadius: 12,
                    objectFit: 'cover',
                    display: 'block',
                    border: '1px solid #E5E7EB',
                  }}
                />
                <button
                  type="button"
                  onClick={onClearImage}
                  style={{
                    position: 'absolute',
                    top: -8,
                    right: -8,
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    background: '#1A1A1A',
                    border: '2px solid #FFFFFF',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                  }}
                  aria-label="Remove image"
                >
                  <X style={{ width: 12, height: 12, color: 'white' }} />
                </button>
              </div>
            </div>
            {/* Separator line - dotted like official */}
            <div style={{
              margin: '12px 20px 0 20px',
              borderTop: '1px dashed #E5E7EB',
            }} />
          </>
        )}

        {/* Text input OR LED Visualizer */}
        {isRecording ? (
          // LED Audio Visualizer
          <div style={{
            padding: '20px 20px 8px 20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 3,
            height: 56,
          }}>
            {audioLevels.map((level, i) => (
              <div
                key={i}
                style={{
                  width: 4,
                  height: Math.max(4, level * 40),
                  borderRadius: 2,
                  background: getLedColor(level),
                  transition: 'height 0.05s ease-out',
                  opacity: level > 0.05 ? 1 : 0.3,
                }}
              />
            ))}
          </div>
        ) : (
          // Normal text input
          <div style={{ padding: '16px 20px 8px 20px' }}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              placeholder="Ask Le Chat"
              rows={1}
              disabled={disabled || isTranscribing}
              style={{
                width: '100%',
                resize: 'none',
                border: 'none',
                background: 'transparent',
                color: '#1F2937',
                fontSize: 15,
                lineHeight: 1.6,
                outline: 'none',
                maxHeight: 150,
                opacity: disabled || isTranscribing ? 0.5 : 1,
                fontFamily: 'inherit',
              }}
            />
          </div>
        )}

        {/* Bottom row: Action buttons */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 14px 14px 14px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Cat head button - orange square */}
            <button
              type="button"
              style={{
                flexShrink: 0,
                width: 40,
                height: 40,
                borderRadius: 12,
                background: '#FF6B35',
                border: 'none',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              aria-label="Menu"
            >
              <CatHeadIcon style={{ width: 20, height: 14, color: 'white' }} />
            </button>

            {/* Plus button */}
            <button
              type="button"
              onClick={onNewChat}
              style={{
                flexShrink: 0,
                width: 40,
                height: 40,
                borderRadius: 12,
                background: 'transparent',
                border: '1px solid #E5E7EB',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              aria-label="New chat"
            >
              <PlusIcon style={{ width: 16, height: 16, color: '#6B7280' }} />
            </button>

            {/* Image generation button */}
            <button
              type="button"
              onClick={handleImageGenerate}
              disabled={!input.trim() || disabled || isGeneratingImage}
              title={input.trim() ? 'Generate image from prompt' : 'Type a prompt first'}
              style={{
                flexShrink: 0,
                width: 40,
                height: 40,
                borderRadius: 12,
                background: 'transparent',
                border: '1px solid #E5E7EB',
                cursor: (!input.trim() || disabled || isGeneratingImage) ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: (!input.trim() || disabled || isGeneratingImage) ? 0.4 : 1,
                transition: 'opacity 0.15s',
              }}
              aria-label="Generate image"
            >
              {isGeneratingImage ? (
                <Loader2 style={{ width: 16, height: 16, color: '#6B7280', animation: 'spin 1s linear infinite' }} />
              ) : (
                <ImageIcon style={{ width: 16, height: 16, color: '#6B7280' }} />
              )}
            </button>
          </div>

          {/* Right side buttons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Recording state: show stop button */}
            {isRecording && (
              <button
                type="button"
                onClick={handleMicClick}
                style={{
                  flexShrink: 0,
                  width: 40,
                  height: 40,
                  borderRadius: '50%',
                  background: '#EF4444',
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  animation: 'pulse-red 1.5s ease-in-out infinite',
                }}
                aria-label="Stop recording"
              >
                <Square style={{ width: 14, height: 14, color: 'white', fill: 'white' }} />
              </button>
            )}

            {/* Transcribing state: show spinner */}
            {isTranscribing && (
              <button
                type="button"
                disabled
                style={{
                  flexShrink: 0,
                  width: 40,
                  height: 40,
                  borderRadius: '50%',
                  background: '#6B7280',
                  border: 'none',
                  cursor: 'not-allowed',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                aria-label="Transcribing"
              >
                <Loader2 style={{ width: 18, height: 18, color: 'white', animation: 'spin 1s linear infinite' }} />
              </button>
            )}

            {/* Normal state: mic + send */}
            {!isRecording && !isTranscribing && (
              <>
                {!hasContent && (
                  <button
                    type="button"
                    onClick={handleMicClick}
                    disabled={disabled}
                    style={{
                      flexShrink: 0,
                      width: 40,
                      height: 40,
                      borderRadius: '50%',
                      background: '#1A1A1A',
                      border: 'none',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      opacity: disabled ? 0.5 : 1,
                    }}
                    aria-label="Voice input"
                  >
                    <Mic style={{ width: 18, height: 18, color: 'white' }} />
                  </button>
                )}

                {hasContent && (
                  <>
                    <button
                      type="button"
                      onClick={handleMicClick}
                      disabled={disabled}
                      style={{
                        flexShrink: 0,
                        width: 40,
                        height: 40,
                        borderRadius: '50%',
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: disabled ? 0.3 : 0.5,
                      }}
                      aria-label="Voice input"
                    >
                      <Mic style={{ width: 18, height: 18, color: '#1A1A1A' }} />
                    </button>
                    <button
                      type="button"
                      onClick={handleSubmit}
                      disabled={disabled}
                      style={{
                        flexShrink: 0,
                        width: 40,
                        height: 40,
                        borderRadius: '50%',
                        background: '#1A1A1A',
                        border: 'none',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: disabled ? 0.5 : 1,
                      }}
                      aria-label="Send message"
                    >
                      <SendArrowIcon style={{ width: 16, height: 16, color: 'white' }} />
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* CSS Animation for recording pulse */}
      <style>{`
        @keyframes pulse-red {
          0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4); }
          50% { box-shadow: 0 0 0 8px rgba(239, 68, 68, 0); }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
