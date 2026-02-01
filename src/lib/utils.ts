/**
 * Convert a File object to a base64 data URL string.
 * Returns a string like "data:image/png;base64,iVBORw0KGgo..."
 */
export function convertFileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/**
 * Check if a file is an image based on its MIME type.
 */
export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

/**
 * Strip markdown formatting from text for natural TTS reading.
 * Removes code blocks, inline code, headers, bold/italic markers,
 * link syntax, emojis, and normalizes whitespace.
 */
export function stripMarkdownForTTS(text: string): string {
  let cleaned = text;

  // 1. Remove fenced code blocks (```...```) entirely
  cleaned = cleaned.replace(/```[\s\S]*?```/g, '');

  // 2. Remove inline code backticks, keep content
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');

  // 3. Remove headers (##, ###, etc.) — keep text
  cleaned = cleaned.replace(/^#{1,6}\s+/gm, '');

  // 4. Remove images ![alt](url)
  cleaned = cleaned.replace(/!\[([^\]]*)\]\([^)]+\)/g, '');

  // 5. Replace links [text](url) → keep text
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // 6. Remove bold **text** and __text__
  cleaned = cleaned.replace(/\*\*(.+?)\*\*/g, '$1');
  cleaned = cleaned.replace(/__(.+?)__/g, '$1');

  // 7. Remove italic *text* and _text_ (single markers)
  cleaned = cleaned.replace(/\*(.+?)\*/g, '$1');
  cleaned = cleaned.replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1');

  // 8. Remove blockquote markers
  cleaned = cleaned.replace(/^>\s+/gm, '');

  // 9. Remove horizontal rules
  cleaned = cleaned.replace(/^[-*_]{3,}\s*$/gm, '');

  // 10. Remove list markers (-, *, 1.) but keep text
  cleaned = cleaned.replace(/^[\t ]*[-*+]\s+/gm, '');
  cleaned = cleaned.replace(/^[\t ]*\d+\.\s+/gm, '');

  // 11. Strip emojis (Unicode emoji ranges)
  cleaned = cleaned.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{231A}-\u{231B}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{25AA}-\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2934}-\u{2935}\u{2B05}-\u{2B07}\u{2B1B}-\u{2B1C}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}\u{200D}\u{FE0F}]/gu, '');

  // 12. Normalize whitespace: collapse multiple spaces and newlines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  cleaned = cleaned.replace(/[ \t]+/g, ' ');
  cleaned = cleaned.trim();

  return cleaned;
}

/**
 * Split text into chunks for progressive TTS playback.
 * Uses 3-level splitting: paragraphs → sentences → commas/spaces.
 * Max ~150 chars per chunk to stay well under Kokoro's 510-phoneme limit.
 */
export function splitTextForTTS(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= 100) return [trimmed];

  // Level 1: Split at newlines (paragraphs / list items)
  const paragraphs = trimmed.split(/\n+/).filter(p => p.trim());

  const chunks: string[] = [];

  for (const para of paragraphs) {
    const p = para.trim();
    if (!p) continue;

    // Short paragraph → merge with previous chunk if possible
    if (p.length <= 150) {
      const last = chunks.length > 0 ? chunks[chunks.length - 1] : '';
      if (last && (last + ' ' + p).length <= 150) {
        chunks[chunks.length - 1] = last + ' ' + p;
      } else {
        chunks.push(p);
      }
      continue;
    }

    // Level 2: Split paragraph at sentence endings (. ! ? ; :)
    const sentences = p.match(/[^.!?;:]*[.!?;:]+[\s)"]*/g);
    let current = '';

    if (sentences && sentences.length > 0) {
      const captured = sentences.join('');
      const remainder = p.slice(captured.length).trim();

      for (const sentence of sentences) {
        const s = sentence.trim();
        if (!s) continue;

        if ((current + ' ' + s).length > 150 && current.length >= 40) {
          chunks.push(current.trim());
          current = s;
        } else {
          current = current ? current + ' ' + s : s;
        }
      }
      if (remainder) {
        current = current ? current + ' ' + remainder : remainder;
      }
      if (current.trim()) chunks.push(current.trim());
    } else {
      // Level 3: No sentence punctuation → split at commas
      const parts = p.split(/,\s*/);
      current = '';

      for (const part of parts) {
        if ((current + ', ' + part).length > 150 && current.length >= 40) {
          chunks.push(current.trim());
          current = part;
        } else {
          current = current ? current + ', ' + part : part;
        }
      }
      if (current.trim()) chunks.push(current.trim());
    }
  }

  // Safety net: re-split any chunk still over 200 chars at word boundaries
  const safeChunks: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= 200) {
      safeChunks.push(chunk);
    } else {
      const words = chunk.split(/\s+/);
      let current = '';
      for (const word of words) {
        if ((current + ' ' + word).length > 150 && current) {
          safeChunks.push(current.trim());
          current = word;
        } else {
          current = current ? current + ' ' + word : word;
        }
      }
      if (current.trim()) safeChunks.push(current.trim());
    }
  }

  return safeChunks.length > 0 ? safeChunks : [trimmed];
}
