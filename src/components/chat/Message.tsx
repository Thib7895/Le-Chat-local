'use client';

import { useState, useEffect } from 'react';
import { Volume2, Copy, Check, ThumbsUp, ThumbsDown, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Message as MessageType } from '@/lib/types';
import { CatHeadIcon } from '@/components/icons';

interface MessageProps {
  message: MessageType;
  onSpeak?: (text: string) => void;
  isSpeaking?: boolean;
  isLast?: boolean;
}

export function Message({ message, onSpeak, isSpeaking, isLast = false }: MessageProps) {
  const [copied, setCopied] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  const isUser = message.role === 'user';
  const isStreaming = message.isStreaming;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSpeak = () => {
    if (onSpeak && message.content) {
      onSpeak(message.content);
    }
  };

  // User message
  if (isUser) {
    return (
      <div style={{
        display: 'flex',
        justifyContent: 'flex-end',
        marginBottom: 32,
      }}>
        <div style={{
          maxWidth: '85%',
          background: '#F3F4F6',
          color: '#1F2937',
          padding: '14px 20px',
          borderRadius: '20px',
          borderBottomRightRadius: 8,
        }}>
          {/* Image attachments */}
          {message.images && message.images.length > 0 && (
            <div style={{ marginBottom: message.content ? 10 : 0 }}>
              {message.images.map((img) => (
                <img
                  key={img.id}
                  src={img.base64}
                  alt={img.name}
                  style={{
                    maxWidth: 300,
                    maxHeight: 200,
                    borderRadius: 12,
                    objectFit: 'cover',
                    display: 'block',
                  }}
                />
              ))}
            </div>
          )}
          {message.content && (
            <p style={{
              fontSize: 15,
              lineHeight: 1.7,
              whiteSpace: 'pre-wrap',
              margin: 0,
            }}>
              {message.content}
            </p>
          )}
        </div>
      </div>
    );
  }

  // AI message
  const showButtons = !isStreaming && message.content && (isLast || isHovered);

  return (
    <div
      style={{ marginBottom: 32 }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 14,
      }}>
        {/* Mistral icon */}
        <div style={{
          flexShrink: 0,
          width: 28,
          height: 28,
          borderRadius: 8,
          background: '#FF6B35',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 2,
        }}>
          <CatHeadIcon style={{ width: 16, height: 12, color: 'white' }} />
        </div>

        {/* Message content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Image Generation Content */}
          {message.imageGen && (
            <div style={{ marginBottom: message.content && !message.imageGen ? 12 : 0 }}>
              {/* Refined prompt in italic gray */}
              {message.imageGen.refinedPrompt && (
                <p style={{
                  fontSize: 13,
                  color: '#9CA3AF',
                  fontStyle: 'italic',
                  margin: '0 0 8px 0',
                  lineHeight: 1.6,
                }}>
                  {message.imageGen.refinedPrompt}
                </p>
              )}

              {/* Refining state */}
              {message.imageGen.status === 'refining' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0' }}>
                  <Loader2 style={{ width: 16, height: 16, color: '#FF6B35', animation: 'spin 1s linear infinite' }} />
                  <span style={{ color: '#9CA3AF', fontSize: 13 }}>Refining prompt...</span>
                </div>
              )}

              {/* Generating state with live timer */}
              {message.imageGen.status === 'generating' && message.imageGen.startTime && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0' }}>
                  <Loader2 style={{ width: 16, height: 16, color: '#FF6B35', animation: 'spin 1s linear infinite' }} />
                  <GenerationTimer startTime={message.imageGen.startTime} />
                </div>
              )}

              {/* Done state: show generated image */}
              {message.imageGen.status === 'done' && message.imageGen.generatedImage && (
                <img
                  src={`data:image/png;base64,${message.imageGen.generatedImage}`}
                  alt="Generated image"
                  style={{
                    maxWidth: 512,
                    maxHeight: 512,
                    borderRadius: 12,
                    display: 'block',
                    marginTop: 8,
                  }}
                />
              )}

              {/* Error state */}
              {message.imageGen.status === 'error' && (
                <div style={{
                  padding: '10px 14px',
                  borderRadius: 8,
                  background: '#FEF2F2',
                  border: '1px solid #FECACA',
                  color: '#DC2626',
                  fontSize: 13,
                  marginTop: 8,
                }}>
                  Image generation failed: {message.imageGen.error || 'Unknown error'}
                </div>
              )}
            </div>
          )}

          {/* Web search indicator */}
          {message.isSearching && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 0',
            }}>
              <Loader2 style={{ width: 16, height: 16, color: '#FF6B35', animation: 'spin 1s linear infinite' }} />
              <span style={{ color: '#9CA3AF', fontSize: 14 }}>Recherche en cours…</span>
            </div>
          )}

          {/* Normal text content (only when NOT an imageGen message) */}
          {!message.imageGen && (
          <div style={{
            fontSize: 15,
            lineHeight: 1.8,
            color: '#1F2937',
          }}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                p: ({ children }) => (
                  <p style={{ margin: '0 0 12px 0', lineHeight: 1.8 }}>{children}</p>
                ),
                strong: ({ children }) => (
                  <strong style={{ fontWeight: 600 }}>{children}</strong>
                ),
                em: ({ children }) => (
                  <em>{children}</em>
                ),
                h1: ({ children }) => (
                  <h1 style={{ fontSize: 22, fontWeight: 700, margin: '20px 0 10px 0', lineHeight: 1.4 }}>{children}</h1>
                ),
                h2: ({ children }) => (
                  <h2 style={{ fontSize: 19, fontWeight: 700, margin: '18px 0 8px 0', lineHeight: 1.4 }}>{children}</h2>
                ),
                h3: ({ children }) => (
                  <h3 style={{ fontSize: 17, fontWeight: 600, margin: '16px 0 6px 0', lineHeight: 1.4 }}>{children}</h3>
                ),
                ul: ({ children }) => (
                  <ul style={{ margin: '8px 0 12px 0', paddingLeft: 24, listStyleType: 'disc' }}>{children}</ul>
                ),
                ol: ({ children }) => (
                  <ol style={{ margin: '8px 0 12px 0', paddingLeft: 24, listStyleType: 'decimal' }}>{children}</ol>
                ),
                li: ({ children }) => (
                  <li style={{ marginBottom: 4, lineHeight: 1.7 }}>{children}</li>
                ),
                code: ({ children, className }) => {
                  const isBlock = className?.includes('language-');
                  if (isBlock) {
                    return (
                      <code style={{
                        display: 'block',
                        background: '#F3F4F6',
                        padding: 12,
                        borderRadius: 8,
                        fontSize: 13,
                        fontFamily: "'Fira Code', 'Consolas', monospace",
                        overflowX: 'auto',
                        lineHeight: 1.6,
                      }}>
                        {children}
                      </code>
                    );
                  }
                  return (
                    <code style={{
                      background: '#F3F4F6',
                      padding: '2px 6px',
                      borderRadius: 4,
                      fontSize: 13,
                      fontFamily: "'Fira Code', 'Consolas', monospace",
                    }}>
                      {children}
                    </code>
                  );
                },
                pre: ({ children }) => (
                  <pre style={{
                    margin: '12px 0',
                    background: '#F3F4F6',
                    borderRadius: 8,
                    overflow: 'auto',
                  }}>
                    {children}
                  </pre>
                ),
                blockquote: ({ children }) => (
                  <blockquote style={{
                    borderLeft: '3px solid #FF6B35',
                    paddingLeft: 16,
                    margin: '12px 0',
                    color: '#4B5563',
                  }}>
                    {children}
                  </blockquote>
                ),
                a: ({ children, href }) => (
                  <a href={href} target="_blank" rel="noopener noreferrer" style={{
                    color: '#FF6B35',
                    textDecoration: 'underline',
                  }}>
                    {children}
                  </a>
                ),
              }}
            >
              {message.content}
            </ReactMarkdown>
            {isStreaming && (
              <span style={{
                display: 'inline-block',
                width: 2,
                height: 20,
                marginLeft: 2,
                background: '#9CA3AF',
                verticalAlign: 'middle',
                animation: 'pulse 1s ease-in-out infinite',
              }} />
            )}
          </div>
          )}

          {/* Action buttons */}
          {!isStreaming && message.content && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              marginTop: 8,
              opacity: showButtons ? 1 : 0,
              pointerEvents: showButtons ? 'auto' : 'none',
              transition: 'opacity 150ms ease',
            }}>
              <ActionButton
                onClick={handleSpeak}
                disabled={isSpeaking}
                label="Read aloud"
              >
                <Volume2 style={{ width: 16, height: 16, color: '#9CA3AF' }} />
              </ActionButton>

              <ActionButton label="Like">
                <ThumbsUp style={{ width: 16, height: 16, color: '#9CA3AF' }} />
              </ActionButton>

              <ActionButton label="Dislike">
                <ThumbsDown style={{ width: 16, height: 16, color: '#9CA3AF' }} />
              </ActionButton>

              <ActionButton onClick={handleCopy} label="Copy">
                {copied ? (
                  <Check style={{ width: 16, height: 16, color: '#22C55E' }} />
                ) : (
                  <Copy style={{ width: 16, height: 16, color: '#9CA3AF' }} />
                )}
              </ActionButton>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GenerationTimer({ startTime }: { startTime: number }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  return (
    <span style={{ color: '#9CA3AF', fontSize: 13 }}>
      Generating... {elapsed}s
    </span>
  );
}

function ActionButton({
  children,
  onClick,
  disabled,
  label,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  label: string;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: 6,
        borderRadius: 8,
        border: 'none',
        background: hovered ? '#F3F4F6' : 'transparent',
        cursor: disabled ? 'default' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.5 : 1,
        transition: 'background 150ms ease',
      }}
    >
      {children}
    </button>
  );
}
