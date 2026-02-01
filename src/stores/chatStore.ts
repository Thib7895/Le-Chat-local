import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { fetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';
import { Message, ImageAttachment } from '@/lib/types';
import { DEFAULT_SETTINGS } from '@/lib/constants';

const IMAGE_REFINE_SYSTEM_PROMPT = `You are a Stable Diffusion prompt engineer. The user will give you a description of an image they want to generate. Your job is to rewrite it as an optimized Stable Diffusion prompt.

Rules:
- Output ONLY the prompt, nothing else. No explanations, no preamble.
- Write in English regardless of input language.
- Use comma-separated descriptive tags and phrases.
- Include quality boosters: "masterpiece, best quality, highly detailed"
- Include relevant style tags (photorealistic, cinematic lighting, etc.)
- Include relevant technical tags (8k, sharp focus, depth of field, etc.)
- Keep it under 200 words.
- Do NOT include negative prompt.`;

const AGENT_SYSTEM_PROMPT = `Tu es Le Chat, un assistant IA intelligent intégré dans une application locale.
Tu disposes d'outils puissants pour interagir avec le monde réel.

TES DIRECTIVES ABSOLUES :
1.  PROACTIVITÉ : Ne demande JAMAIS la permission d'utiliser un outil. Si une question nécessite une info externe ou un calcul, utilise l'outil IMMÉDIATEMENT. Ne dis pas "Je peux chercher...", cherche !
2.  HONNÊTETÉ : N'invente jamais de faits, d'adresses, de prix ou de données météo. Si tu n'as pas l'info dans ton contexte immédiat, utilise SEARCH_WEB.
3.  RÉPONSES COURTES : Quand tu lances une commande, n'écris rien d'autre. Juste la commande.

TES OUTILS DISPONIBLES (Syntaxe stricte) :

### 1. RECHERCHE WEB (Pour l'actualité, météo, lieux, faits récents)
Commande : SEARCH_WEB: [ta requête courte]
- Exemple :
  User: "Il fait beau à Dublin ?"
  Toi: SEARCH_WEB: météo dublin aujourd'hui
---
GESTION DU CONTEXTE :
Si tu reçois un message commençant par "CONTEXTE WEB:", cela signifie que l'outil a fonctionné. Utilise ces informations pour formuler ta réponse finale à l'utilisateur de manière naturelle.`;

/** Regex to detect SEARCH_WEB: [query] in LLM output */
const SEARCH_WEB_REGEX = /SEARCH_WEB:\s*\[?(.+?)\]?\s*$/;

/** Stop sequences to prevent hallucinated search results after SEARCH_WEB command */
const SEARCH_STOP_SEQUENCES = [
  'CONTEXTE WEB:',
  'CONTEXTE WEB',
  '\nUser:',
  'Observation:',
];

interface ChatState {
  messages: Message[];
  isLoading: boolean;
  isGeneratingImage: boolean;
  settings: {
    ollamaUrl: string;
    selectedLang: string;
    modelsPath: string;
    selectedModel: string;
  };

  // Actions
  sendMessage: (content: string, image?: ImageAttachment | null) => Promise<void>;
  generateImage: (prompt: string) => Promise<void>;
  clearMessages: () => void;
  updateSettings: (settings: Partial<ChatState['settings']>) => void;
}

/**
 * Format a message for the OpenAI API.
 * If the message has images, use the Vision API format with content array.
 * Otherwise, use the simple string content format.
 */
function formatMessageForApi(msg: Message) {
  if (msg.images && msg.images.length > 0) {
    // OpenAI Vision API format
    const contentParts: Array<
      | { type: 'image_url'; image_url: { url: string } }
      | { type: 'text'; text: string }
    > = [];

    // Add images first
    for (const img of msg.images) {
      contentParts.push({
        type: 'image_url',
        image_url: { url: img.base64 },
      });
    }

    // Add text content if present
    if (msg.content) {
      contentParts.push({
        type: 'text',
        text: msg.content,
      });
    }

    return {
      role: msg.role,
      content: contentParts,
    };
  }

  // Simple text-only format
  return {
    role: msg.role,
    content: msg.content,
  };
}

/**
 * Stream an LLM response via SSE and update the assistant message in real-time.
 * Returns the fully accumulated content string when done.
 */
async function streamLlmResponse(
  ollamaUrl: string,
  apiMessages: Array<{ role: string; content: unknown }>,
  assistantMessageId: string,
  set: (fn: (state: ChatState) => Partial<ChatState>) => void,
  stop?: string[]
): Promise<string> {
  const response = await fetch(`${ollamaUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'ministral-3:3b-instruct-2512-q4_K_M',
      messages: apiMessages,
      stream: true,
      max_tokens: 2048,
      temperature: 0.7,
      ...(stop ? { stop } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let accumulatedContent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n');

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);

        if (data === '[DONE]') {
          continue;
        }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;

          if (delta) {
            accumulatedContent += delta;

            // Update the assistant message with accumulated content
            set((state) => ({
              messages: state.messages.map((m) =>
                m.id === assistantMessageId
                  ? { ...m, content: accumulatedContent }
                  : m
              ),
            }));
          }
        } catch {
          // Ignore parse errors for incomplete chunks
        }
      }
    }
  }

  return accumulatedContent;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isLoading: false,
  isGeneratingImage: false,
  settings: {
    ollamaUrl: DEFAULT_SETTINGS.ollamaUrl,
    selectedLang: DEFAULT_SETTINGS.selectedLang,
    modelsPath: DEFAULT_SETTINGS.modelsPath,
    selectedModel: DEFAULT_SETTINGS.selectedModel,
  },

  sendMessage: async (content: string, image?: ImageAttachment | null) => {
    const { settings, messages } = get();

    // Add user message
    const userMessage: Message = {
      id: nanoid(),
      role: 'user',
      content,
      timestamp: Date.now(),
      ...(image ? { images: [image] } : {}),
    };

    // Add placeholder for assistant message
    const assistantMessage: Message = {
      id: nanoid(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };

    set({
      isLoading: true,
      messages: [...messages, userMessage, assistantMessage],
    });

    try {
      // Build API messages WITH agent system prompt + dynamic date prepended
      const now = new Date();
      const dateStr = now.toLocaleDateString('fr-FR', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      const systemMsg = {
        role: 'system',
        content: `DATE ACTUELLE : ${dateStr}\n\n${AGENT_SYSTEM_PROMPT}`,
      };
      const apiMessages = [
        systemMsg,
        ...[...messages, userMessage].map(formatMessageForApi),
      ];

      // First LLM call — with stop sequences to prevent hallucinated results
      const accumulatedContent = await streamLlmResponse(
        settings.ollamaUrl,
        apiMessages,
        assistantMessage.id,
        set,
        SEARCH_STOP_SEQUENCES
      );

      // Check if the LLM output a SEARCH_WEB command
      const searchMatch = accumulatedContent.trim().match(SEARCH_WEB_REGEX);

      if (searchMatch) {
        const query = searchMatch[1].trim();
        console.log(`Agentic: Detected SEARCH_WEB command, query: "${query}"`);

        // Show "searching" state — clear the raw command text
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === assistantMessage.id
              ? { ...m, content: '', isSearching: true }
              : m
          ),
        }));

        // Call Rust backend for DuckDuckGo scraping
        let searchResults = '';
        try {
          searchResults = await invoke<string>('search_web', { query });
        } catch (e) {
          console.warn('Agentic: search_web invoke failed:', e);
        }

        // Build augmented messages with web context injected
        const webContext = searchResults
          ? `CONTEXTE WEB:\n${searchResults}`
          : `CONTEXTE WEB:\nAucun résultat trouvé pour "${query}". Réponds avec tes connaissances.`;

        const augmentedMessages = [
          systemMsg,
          ...[...messages, userMessage].map(formatMessageForApi),
          { role: 'system', content: webContext },
        ];

        // Clear content and searching flag before second LLM call
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === assistantMessage.id
              ? { ...m, content: '', isSearching: false }
              : m
          ),
        }));

        // Second LLM call with web context — streams the real answer
        await streamLlmResponse(
          settings.ollamaUrl,
          augmentedMessages,
          assistantMessage.id,
          set
        );
      }

      // Mark streaming as complete
      set((state) => ({
        isLoading: false,
        messages: state.messages.map((m) =>
          m.id === assistantMessage.id ? { ...m, isStreaming: false } : m
        ),
      }));
    } catch (error) {
      console.error('Failed to send message:', error);

      // Update assistant message with error
      set((state) => ({
        isLoading: false,
        messages: state.messages.map((m) =>
          m.id === assistantMessage.id
            ? {
                ...m,
                content: `Error: ${error instanceof Error ? error.message : 'Failed to get response'}`,
                isStreaming: false,
                isSearching: false,
              }
            : m
        ),
      }));
    }
  },

  generateImage: async (prompt: string) => {
    const { settings, messages } = get();

    // Create user message with original prompt
    const userMessage: Message = {
      id: nanoid(),
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    };

    // Create assistant placeholder for image generation
    const assistantMessage: Message = {
      id: nanoid(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      imageGen: {
        status: 'refining',
      },
    };

    set({
      isGeneratingImage: true,
      isLoading: true,
      messages: [...messages, userMessage, assistantMessage],
    });

    const updateAssistant = (updates: Partial<Message>) => {
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === assistantMessage.id ? { ...m, ...updates } : m
        ),
      }));
    };

    try {
      // --- Phase 1: Refine prompt via LLM (LLM is still loaded) ---
      const refineMessages = [
        { role: 'system', content: IMAGE_REFINE_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ];

      const response = await fetch(`${settings.ollamaUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'ministral-3:3b-instruct-2512-q4_K_M',
          messages: refineMessages,
          stream: false, // Short response, no streaming needed
          max_tokens: 512,
          temperature: 0.7,
        }),
      });

      if (!response.ok) {
        throw new Error(`LLM refinement failed: ${response.status}`);
      }

      const data = await response.json();
      const refinedPrompt: string =
        data.choices?.[0]?.message?.content?.trim() || prompt;

      // Update message: show refined prompt, transition to generating state
      const genStartTime = Date.now();
      updateAssistant({
        content: refinedPrompt,
        imageGen: {
          status: 'generating',
          refinedPrompt,
          startTime: genStartTime,
        },
      });

      // --- Phase 2: Call Rust backend for VRAM swap + SD generation ---
      const base64Image = await invoke<string>('generate_image', {
        prompt: refinedPrompt,
      });

      // --- Phase 3: Done -- display image ---
      updateAssistant({
        imageGen: {
          status: 'done',
          refinedPrompt,
          generatedImage: base64Image,
          startTime: genStartTime,
        },
      });
    } catch (error) {
      console.error('Image generation failed:', error);
      const errMsg =
        error instanceof Error ? error.message : 'Image generation failed';

      updateAssistant({
        imageGen: {
          ...((get().messages.find((m) => m.id === assistantMessage.id))?.imageGen || {}),
          status: 'error',
          error: errMsg,
        },
      });
    } finally {
      set({ isGeneratingImage: false, isLoading: false });
    }
  },

  clearMessages: () => {
    set({ messages: [] });
  },

  updateSettings: (newSettings) => {
    set((state) => ({
      settings: { ...state.settings, ...newSettings },
    }));
  },
}));
