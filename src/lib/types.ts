export interface ImageAttachment {
  id: string;
  base64: string;       // data:image/...;base64,... format
  name: string;
  mimeType: string;
}

export interface ImageGenState {
  status: 'refining' | 'generating' | 'done' | 'error';
  refinedPrompt?: string;
  generatedImage?: string;  // base64 PNG raw (no data: prefix)
  error?: string;
  startTime?: number;       // Date.now() for live timer
}

/** Persisted image generation result (stored in database) */
export interface PersistedImageGen {
  refinedPrompt: string;
  generatedImage: string;  // base64 PNG raw (no data: prefix)
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  images?: ImageAttachment[];
  timestamp: number;
  isStreaming?: boolean;
  isSearching?: boolean;
  imageGen?: ImageGenState;
}

export interface ChatSession {
  id: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

export interface Settings {
  ollamaUrl: string;
  selectedVoice: string;
  modelsPath: string;
  selectedModel: string;
  selectedLang: string;
  // LLM parameters for native Ollama API
  temperature: number;
  numCtx: number;
  numPredict: number;
  keepAlive: string;
}

export interface VoiceInfo {
  id: string;
  name: string;
  language: string;
}
