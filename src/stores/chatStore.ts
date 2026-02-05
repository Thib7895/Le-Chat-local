import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { fetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';
import { Message, ImageAttachment } from '@/lib/types';
import { DEFAULT_SETTINGS } from '@/lib/constants';
import { useConversationStore } from './conversationStore';

// Module-level abort controller for cancelling ongoing LLM streams
let currentAbortController: AbortController | null = null;

// Module-level session ID for cancelling Rust backend search
let currentSearchSessionId: string | null = null;

// Current phase of the pipeline for smart cancellation
type PipelinePhase = 'idle' | 'stream1' | 'query_expansion' | 'backend_search' | 'stream2';
let currentPhase: PipelinePhase = 'idle';

// Soft cancel flag for non-HTTP phases (query_expansion, backend_search)
let stopRequested = false;

// Unique request ID to track the current request and avoid race conditions
let currentRequestId: string | null = null;
let sessionTurnIndex = 0;
let lastStream1PromptTokens: number | null = null;

/**
 * Check if a request is still the active one.
 * Returns false if another request has started or if stop was requested.
 */
function isRequestStale(requestId: string): boolean {
  return currentRequestId !== requestId || stopRequested;
}

/**
 * Safely abort an AbortController, ignoring Tauri-specific errors
 * when HTTP resources have already been released.
 */
function safeAbort(controller: AbortController | null): void {
  if (!controller) return;
  try {
    controller.abort();
  } catch (e) {
    // Ignore Tauri HTTP plugin errors when resources are already closed
    const errStr = String(e).toLowerCase();
    if (
      errStr.includes('resource id') ||
      errStr.includes('invalid') ||
      errStr.includes('cancelled') ||
      errStr.includes('canceled') ||
      errStr.includes('aborted')
    ) {
      return;
    }
    console.warn('safeAbort: Unexpected error:', e);
  }
}

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

/** Query expansion prompt for RAG v2 */
const QUERY_EXPANSION_PROMPT = `Tu es un expert en recherche web. L'utilisateur a posé une question et tu dois générer 3 requêtes de recherche optimisées.

RÈGLES STRICTES :
- Réponds UNIQUEMENT avec un JSON valide, rien d'autre
- Format exact : {"queries": ["requête 1", "requête 2", "requête 3"]}
- Chaque requête doit être courte (3-6 mots)
- Inclus des variantes : synonymes, reformulations, mots-clés spécifiques
- Si la question concerne l'actualité, inclus l'année courante dans au moins une requête

Exemple :
Question: "Quel temps fait-il à Paris ?"
{"queries": ["météo Paris aujourd'hui", "prévisions météo Paris", "température Paris maintenant"]}`;

/** RAG grounding prompt template */
const RAG_GROUNDING_PROMPT = (dateTime: string, sources: string) => `DATE ET HEURE : ${dateTime}

PREUVES WEB VÉRIFIÉES :
${sources}

INSTRUCTIONS STRICTES :
1. Utilise UNIQUEMENT les informations des sources ci-dessus pour répondre
2. Cite tes sources avec [1], [2], etc. à chaque affirmation
3. Si l'information n'est pas dans les sources, dis clairement "Je n'ai pas trouvé cette information"
4. Ne fais AUCUNE supposition ou extrapolation au-delà des sources
5. Réponds de manière concise et factuelle`;

/** Response type from search_web_v2 */
interface SearchEvidencePack {
  sources: Array<{
    id: number;
    title: string;
    url: string;
    domain: string;
    snippet: string;
    content_preview: string;
    score: number;
  }>;
  context_summary: string;
  query_used: string[];
  total_results_found: number;
  total_pages_fetched: number;
  processing_time_ms: number;
}

/** Rust settings format (snake_case) for invoke calls */
interface RustSettings {
  ollama_url: string;
  selected_voice: string;
  models_path: string;
  selected_model: string;
  selected_lang: string;
  temperature: number;
  num_ctx: number;
  num_predict: number;
  keep_alive: string;
}

interface ChatState {
  messages: Message[];
  isLoading: boolean;
  isGeneratingImage: boolean;
  settings: {
    ollamaUrl: string;
    selectedLang: string;
    modelsPath: string;
    selectedModel: string;
    selectedVoice: string;
    // LLM parameters for native Ollama API
    temperature: number;
    numCtx: number;
    numPredict: number;
    keepAlive: string;
  };

  // Actions
  loadSettings: () => Promise<void>;
  sendMessage: (content: string, image?: ImageAttachment | null) => Promise<void>;
  generateImage: (prompt: string) => Promise<void>;
  clearMessages: () => void;
  cancelGeneration: () => void;
  setMessages: (messages: Message[]) => void;
}

interface OllamaDoneChunk {
  done?: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

interface StreamLlmResult {
  content: string;
  doneChunk: OllamaDoneChunk | null;
}

function formatMs(ms: number | null): string {
  if (ms === null || Number.isNaN(ms)) return 'n/a';
  return `${ms.toFixed(0)}ms`;
}

function nsToMs(ns?: number): number | null {
  if (typeof ns !== 'number') return null;
  return ns / 1_000_000;
}

function logOllamaMetrics(
  label: string,
  settings: ChatState['settings'],
  doneChunk: OllamaDoneChunk | null,
  wallMs: number,
  firstTokenMs: number | null
) {
  const promptTokens = doneChunk?.prompt_eval_count ?? 0;
  const generatedTokens = doneChunk?.eval_count ?? 0;
  const promptMs = nsToMs(doneChunk?.prompt_eval_duration);
  const evalMs = nsToMs(doneChunk?.eval_duration);
  const totalMs = nsToMs(doneChunk?.total_duration) ?? wallMs;
  const loadMs = nsToMs(doneChunk?.load_duration);
  const tokPerSec =
    evalMs && evalMs > 0 ? generatedTokens / (evalMs / 1000) : 0;
  const ctxPct =
    settings.numCtx > 0 ? (promptTokens / settings.numCtx) * 100 : 0;
  const combinedTokens = promptTokens + generatedTokens;
  const combinedPct =
    settings.numCtx > 0 ? (combinedTokens / settings.numCtx) * 100 : 0;
  const combinedLeft = settings.numCtx > 0 ? Math.max(0, settings.numCtx - combinedTokens) : 0;
  const ctxNearLimit =
    settings.numCtx > 0 && promptTokens >= Math.floor(settings.numCtx * 0.95);
  const hitGenerationLimit = generatedTokens >= settings.numPredict;
  const contextOverflowSuspected =
    doneChunk?.done_reason === 'length' && ctxNearLimit;

  console.log(
    `[LLM:${label}] model=${settings.selectedModel} done=${doneChunk?.done_reason ?? 'unknown'} ` +
      `prompt=${promptTokens}/${settings.numCtx} (${ctxPct.toFixed(1)}%) gen=${generatedTokens} ` +
      `combined=${combinedTokens}/${settings.numCtx} (${combinedPct.toFixed(1)}%) combined_left=${combinedLeft} ` +
      `tps=${tokPerSec.toFixed(2)} ttft=${formatMs(firstTokenMs)} prompt_t=${formatMs(promptMs)} ` +
      `eval_t=${formatMs(evalMs)} load_t=${formatMs(loadMs)} total_t=${formatMs(totalMs)} ` +
      `ctx_near_limit=${ctxNearLimit} gen_limit_hit=${hitGenerationLimit} ` +
      `ctx_overflow_suspected=${contextOverflowSuspected}`
  );
}

function logSessionContext(
  requestId: string,
  settings: ChatState['settings'],
  stream1PromptTokens: number,
  stream1GeneratedTokens: number
) {
  sessionTurnIndex += 1;
  const previous = lastStream1PromptTokens;
  const delta = previous === null ? 0 : stream1PromptTokens - previous;
  const remaining = Math.max(0, settings.numCtx - stream1PromptTokens);
  const trimmed = previous !== null && stream1PromptTokens < previous;
  const ctxPct =
    settings.numCtx > 0 ? (stream1PromptTokens / settings.numCtx) * 100 : 0;
  const combined = stream1PromptTokens + stream1GeneratedTokens;
  const combinedPct =
    settings.numCtx > 0 ? (combined / settings.numCtx) * 100 : 0;
  const combinedLeft = Math.max(0, settings.numCtx - combined);

  console.log(
    `[SESSION:${requestId}] turn=${sessionTurnIndex} ctx_base=${stream1PromptTokens}/${settings.numCtx} ` +
      `(${ctxPct.toFixed(1)}%) base_left=${remaining} base_delta=${delta >= 0 ? `+${delta}` : `${delta}`} ` +
      `combined=${combined}/${settings.numCtx} (${combinedPct.toFixed(1)}%) combined_left=${combinedLeft} trimmed=${trimmed}`
  );

  lastStream1PromptTokens = stream1PromptTokens;
}

/**
 * Format a message for the native Ollama API.
 * If the message has images, use Ollama's native format with separate images array.
 * Otherwise, use the simple string content format.
 */
function formatMessageForApi(msg: Message) {
  if (msg.images && msg.images.length > 0) {
    // Ollama native format: content is string, images is separate base64 array
    // Extract raw base64 data without the "data:image/...;base64," prefix
    const images = msg.images.map((img) => {
      const base64Match = img.base64.match(/^data:image\/[^;]+;base64,(.+)$/);
      return base64Match ? base64Match[1] : img.base64;
    });

    return {
      role: msg.role,
      content: msg.content || '',
      images,
    };
  }

  // Simple text-only format
  return {
    role: msg.role,
    content: msg.content,
  };
}

/**
 * Stream an LLM response via native Ollama API and update the assistant message in real-time.
 * Uses POST /api/chat with newline-delimited JSON streaming.
 * Returns the fully accumulated content string when done.
 */
async function streamLlmResponse(
  settings: ChatState['settings'],
  apiMessages: Array<{ role: string; content: unknown }>,
  assistantMessageId: string,
  set: (fn: (state: ChatState) => Partial<ChatState>) => void,
  telemetryLabel: string,
  stop?: string[],
  signal?: AbortSignal
): Promise<StreamLlmResult> {
  const streamStart = Date.now();
  const response = await fetch(`${settings.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.selectedModel,
      messages: apiMessages,
      stream: true,
      options: {
        temperature: settings.temperature,
        num_ctx: settings.numCtx,
        num_predict: settings.numPredict,
      },
      keep_alive: settings.keepAlive,
      ...(stop ? { stop } : {}),
    }),
    signal,
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
  let buffer = '';
  let streamFinished = false; // Flag for clean exit after parsed.done
  let firstTokenAt: number | null = null;
  let doneChunk: OllamaDoneChunk | null = null;

  while (true) {
    // Check for abort signal or stream finished before reading
    if (signal?.aborted || streamFinished) {
      // Don't call reader.cancel() - resource already freed by abort
      break;
    }

    try {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete JSON lines (newline-delimited)
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const parsed = JSON.parse(line);

          // Native Ollama format: { message: { content: "token" }, done: false }
          const delta = parsed.message?.content;

          if (delta) {
            accumulatedContent += delta;
            if (firstTokenAt === null) {
              firstTokenAt = Date.now();
            }

            // Update the assistant message with accumulated content
            set((state) => ({
              messages: state.messages.map((m) =>
                m.id === assistantMessageId
                  ? { ...m, content: accumulatedContent }
                  : m
              ),
            }));
          }

          // Check if stream is done
          if (parsed.done === true) {
            doneChunk = parsed as OllamaDoneChunk;
            streamFinished = true; // Mark as finished to exit while loop
            break; // Exit for loop
          }
        } catch {
          // Ignore parse errors for incomplete chunks
        }
      }
    } catch (readError) {
      // If error is related to cancellation, exit silently
      const errStr = String(readError).toLowerCase();
      if (
        errStr.includes('resource id') ||
        errStr.includes('cancelled') ||
        errStr.includes('canceled') ||
        errStr.includes('aborted')
      ) {
        break;
      }
      // Otherwise, rethrow
      throw readError;
    }
  }

  const wallMs = Date.now() - streamStart;
  const firstTokenMs = firstTokenAt ? firstTokenAt - streamStart : null;
  logOllamaMetrics(telemetryLabel, settings, doneChunk, wallMs, firstTokenMs);

  return { content: accumulatedContent, doneChunk };
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
    selectedVoice: DEFAULT_SETTINGS.selectedVoice,
    temperature: DEFAULT_SETTINGS.temperature,
    numCtx: DEFAULT_SETTINGS.numCtx,
    numPredict: DEFAULT_SETTINGS.numPredict,
    keepAlive: DEFAULT_SETTINGS.keepAlive,
  },

  loadSettings: async () => {
    try {
      const saved = await invoke<RustSettings>('get_settings');
      set({
        settings: {
          ollamaUrl: saved.ollama_url || DEFAULT_SETTINGS.ollamaUrl,
          selectedVoice: saved.selected_voice || DEFAULT_SETTINGS.selectedVoice,
          modelsPath: saved.models_path || DEFAULT_SETTINGS.modelsPath,
          selectedModel: saved.selected_model || DEFAULT_SETTINGS.selectedModel,
          selectedLang: saved.selected_lang || DEFAULT_SETTINGS.selectedLang,
          temperature: saved.temperature ?? DEFAULT_SETTINGS.temperature,
          numCtx: saved.num_ctx ?? DEFAULT_SETTINGS.numCtx,
          numPredict: saved.num_predict ?? DEFAULT_SETTINGS.numPredict,
          keepAlive: saved.keep_alive || DEFAULT_SETTINGS.keepAlive,
        },
      });
      console.log('Settings: Loaded from backend');
    } catch (e) {
      console.warn('Settings: Failed to load from backend, using defaults:', e);
    }
  },

  sendMessage: async (content: string, image?: ImageAttachment | null) => {
    // Cancel any existing generation before starting a new one
    safeAbort(currentAbortController);
    stopRequested = false;  // Reset soft cancel flag
    currentPhase = 'idle';

    // Generate unique request ID to track this request and avoid race conditions
    const requestId = nanoid();
    currentRequestId = requestId;

    const abortController = new AbortController();
    currentAbortController = abortController;

    const { settings, messages } = get();

    // Get conversation store for persistence
    const convStore = useConversationStore.getState();
    const isFirstMessage = messages.length === 0;
    let conversationId = convStore.currentConversationId;

    // Create new conversation if this is the first message
    if (isFirstMessage && !conversationId) {
      try {
        conversationId = await convStore.createConversation();
      } catch (e) {
        console.warn('Failed to create conversation:', e);
      }
    }

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

    // Save user message to database
    if (conversationId) {
      convStore.saveMessage(userMessage, conversationId).catch((e) => {
        console.warn('Failed to save user message:', e);
      });
    }

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
      currentPhase = 'stream1';
      const stream1 = await streamLlmResponse(
        settings,
        apiMessages,
        assistantMessage.id,
        set,
        `${requestId}:stream1`,
        SEARCH_STOP_SEQUENCES,
        abortController.signal
      );
      const accumulatedContent = stream1.content;
      if (typeof stream1.doneChunk?.prompt_eval_count === 'number') {
        logSessionContext(
          requestId,
          settings,
          stream1.doneChunk.prompt_eval_count,
          stream1.doneChunk.eval_count ?? 0
        );
      }

      // Check if this request is still active after stream1
      if (isRequestStale(requestId)) {
        return;
      }

      // Check if the LLM output a SEARCH_WEB command
      const searchMatch = accumulatedContent.trim().match(SEARCH_WEB_REGEX);

      if (searchMatch) {
        // Check if aborted before starting RAG pipeline
        if (abortController.signal.aborted) {
          return;
        }

        const userQuery = searchMatch[1].trim();
        console.log(`Agentic: Detected SEARCH_WEB command, query: "${userQuery}"`);

        // Show "searching" state — clear the raw command text
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === assistantMessage.id
              ? { ...m, content: '', isSearching: true }
              : m
          ),
        }));

        // ========== RAG V2 PIPELINE ==========
        // Enter query_expansion phase - clear HTTP controller NOW to prevent abort errors
        // During this phase, we use soft cancel (stopRequested) instead of HTTP abort
        currentPhase = 'query_expansion';
        currentAbortController = null;

        // Step A: Query Expansion via LLM
        let searchQueries: string[] = [userQuery];
        try {
          // Check if request is still active before query expansion
          if (isRequestStale(requestId)) {
            return;
          }

          console.log('RAG: Expanding queries...');
          const expansionResponse = await fetch(`${settings.ollamaUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: settings.selectedModel,
              messages: [
                { role: 'system', content: QUERY_EXPANSION_PROMPT },
                { role: 'user', content: `Année actuelle: ${new Date().getFullYear()}\n\nQuestion: ${userQuery}` },
              ],
              stream: false,
              options: { temperature: 0.3, num_predict: 200 },
            }),
            // No signal here - using soft cancel instead to avoid "resource id invalid"
          });

          if (expansionResponse.ok) {
            const data = await expansionResponse.json();
            const jsonStr = data.message?.content?.trim() || '';
            logOllamaMetrics(
              `${requestId}:query_expansion`,
              settings,
              data as OllamaDoneChunk,
              0,
              null
            );
            try {
              // Extract JSON from response (handle markdown code blocks)
              const jsonMatch = jsonStr.match(/\{[\s\S]*"queries"[\s\S]*\}/);
              if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (Array.isArray(parsed.queries) && parsed.queries.length > 0) {
                  const cleaned = parsed.queries
                    .map((q: unknown) => (typeof q === 'string' ? q.trim() : ''))
                    .filter((q: string) => q.length > 0)
                    .slice(0, 3);
                  searchQueries = cleaned.length > 0 ? cleaned : [userQuery];
                  console.log('RAG: Expanded queries:', searchQueries);
                }
              }
            } catch {
              console.warn('RAG: Failed to parse query expansion, using original');
            }
          }
        } catch (e) {
          // If request is stale, exit gracefully
          if (isRequestStale(requestId)) {
            return;
          }
          console.warn('RAG: Query expansion failed:', e);
        }

        // Check if request is still active after query expansion
        if (isRequestStale(requestId)) {
          return;
        }

        // Final guardrail: never call backend with empty queries
        searchQueries = searchQueries
          .map((q) => q.trim())
          .filter((q) => q.length > 0)
          .slice(0, 3);
        if (searchQueries.length === 0) {
          searchQueries = [userQuery];
        }

        // Step B: Call Rust RAG pipeline (search_web_v2)
        let evidencePack: SearchEvidencePack | null = null;
        currentPhase = 'backend_search';

        // Generate unique session ID for this search (allows backend cancellation)
        currentSearchSessionId = nanoid();
        const searchSessionId = currentSearchSessionId;

        try {
          console.log('RAG: Calling search_web_v2 with queries:', searchQueries);
          evidencePack = await invoke<SearchEvidencePack>('search_web_v2', {
            queries: searchQueries,
            sessionId: searchSessionId,
          });
          console.log(
            `RAG: Got ${evidencePack.sources.length} sources in ${evidencePack.processing_time_ms}ms`
          );
        } catch (e) {
          // If request is stale, exit gracefully
          if (isRequestStale(requestId)) {
            return;
          }
          // Check if this was a cancellation from backend
          const errorStr = String(e);
          if (errorStr.toLowerCase().includes('cancelled')) {
            return;
          }
          console.warn('RAG: search_web_v2 invoke failed:', e);
        } finally {
          // Clear the session ID if it's still ours
          if (currentSearchSessionId === searchSessionId) {
            currentSearchSessionId = null;
          }
        }

        // Check if request is still active after search
        if (isRequestStale(requestId)) {
          return;
        }

        // Build grounding context
        const searchTime = new Date();
        const searchTimeStr = searchTime.toLocaleString('fr-FR', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });

        let webContext: string;
        if (evidencePack && evidencePack.sources.length > 0) {
          // Format sources for LLM grounding (includes URL for traceability)
          const sourcesText = evidencePack.sources
            .map(
              (s) =>
                `[${s.id}] ${s.title}\nURL: ${s.url}\n${s.content_preview || s.snippet}`
            )
            .join('\n\n');
          webContext = RAG_GROUNDING_PROMPT(searchTimeStr, sourcesText);
        } else {
          webContext = `DATE: ${searchTimeStr}\n\nAucun résultat trouvé pour "${userQuery}". Réponds avec tes connaissances générales, mais précise que tu n'as pas pu vérifier l'information via une recherche web.`;
        }

        const augmentedMessages = [
          { role: 'system', content: webContext },
          ...[...messages, userMessage].map(formatMessageForApi),
        ];

        // Clear content and searching flag before final LLM call
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === assistantMessage.id
              ? { ...m, content: '', isSearching: false }
              : m
          ),
        }));

        // Create a NEW AbortController for the final stream
        // Enter stream2 phase where HTTP abort is safe again
        currentPhase = 'stream2';
        const finalAbortController = new AbortController();
        currentAbortController = finalAbortController;

        // Final LLM call with grounded context — streams the real answer
        const stream2 = await streamLlmResponse(
          settings,
          augmentedMessages,
          assistantMessage.id,
          set,
          `${requestId}:stream2`,
          undefined,
          finalAbortController.signal
        );
        if (
          typeof stream1.doneChunk?.prompt_eval_count === 'number' &&
          typeof stream2.doneChunk?.prompt_eval_count === 'number'
        ) {
          const baseCtx = stream1.doneChunk.prompt_eval_count;
          const withRagCtx = stream2.doneChunk.prompt_eval_count;
          const ragOverhead = stream2.doneChunk.prompt_eval_count - stream1.doneChunk.prompt_eval_count;
          const withRagPct =
            settings.numCtx > 0 ? (withRagCtx / settings.numCtx) * 100 : 0;
          const withRagCombined = withRagCtx + (stream2.doneChunk.eval_count ?? 0);
          const withRagCombinedPct =
            settings.numCtx > 0 ? (withRagCombined / settings.numCtx) * 100 : 0;
          const withRagCombinedLeft = Math.max(0, settings.numCtx - withRagCombined);
          const withRagLeft = Math.max(0, settings.numCtx - withRagCtx);
          console.log(
            `[SESSION:${requestId}] ctx_with_rag=${withRagCtx}/${settings.numCtx} (${withRagPct.toFixed(1)}%) ` +
              `with_rag_left=${withRagLeft} combined_with_rag=${withRagCombined}/${settings.numCtx} ` +
              `(${withRagCombinedPct.toFixed(1)}%) combined_with_rag_left=${withRagCombinedLeft} ` +
              `rag_overhead=${ragOverhead >= 0 ? `+${ragOverhead}` : `${ragOverhead}`} base_ctx=${baseCtx}/${settings.numCtx}`
          );
        }

        // Check if request is still active after stream2
        if (isRequestStale(requestId)) {
          return;
        }
      }

      // Mark streaming as complete (only if this request is still active)
      if (!isRequestStale(requestId)) {
        // Get final assistant message content from state
        const finalState = get();
        const finalAssistantMsg = finalState.messages.find((m) => m.id === assistantMessage.id);
        const finalContent = finalAssistantMsg?.content || '';

        set((state) => ({
          isLoading: false,
          messages: state.messages.map((m) =>
            m.id === assistantMessage.id ? { ...m, isStreaming: false } : m
          ),
        }));

        // Save assistant message to database
        if (conversationId && finalContent) {
          const msgToSave: Message = {
            ...assistantMessage,
            content: finalContent,
            isStreaming: false,
          };
          convStore.saveMessage(msgToSave, conversationId).catch((e) => {
            console.warn('Failed to save assistant message:', e);
          });

          // Generate title after first exchange
          if (isFirstMessage) {
            convStore.generateTitle(conversationId, userMessage.content, finalContent);
          }
        }
      }
    } catch (error) {
      // Check if this was an intentional abort (user cancelled)
      // Note: Tauri HTTP plugin throws "Request cancelled" instead of standard AbortError
      // The error may be a string, Error object, or custom Tauri error
      const errorStr = String(error);
      const errorMessage = error instanceof Error ? error.message : errorStr;
      const errorName = error instanceof Error ? error.name : '';

      const isAbortError =
        errorName === 'AbortError' ||
        errorMessage.toLowerCase().includes('cancelled') ||
        errorMessage.toLowerCase().includes('canceled') ||
        errorMessage.toLowerCase().includes('aborted') ||
        errorMessage.toLowerCase().includes('resource id') ||
        errorStr.toLowerCase().includes('cancelled') ||
        errorStr.toLowerCase().includes('canceled') ||
        errorStr.toLowerCase().includes('resource id');

      if (isAbortError) {
        // Graceful abort - keep partial content, don't show error
        // Only update UI if this request is still active
        if (!isRequestStale(requestId)) {
          set((state) => ({
            isLoading: false,
            messages: state.messages.map((m) =>
              m.id === assistantMessage.id
                ? { ...m, isStreaming: false, isSearching: false }
                : m
            ),
          }));
        }
        return;
      }

      // Only show error if this request is still active
      if (isRequestStale(requestId)) {
        return;
      }

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
    } finally {
      // Clean up only if this request is still the current one (avoid race conditions)
      if (currentRequestId === requestId) {
        currentPhase = 'idle';
        currentAbortController = null;
        currentRequestId = null;
      }
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

      const response = await fetch(`${settings.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: settings.selectedModel,
          messages: refineMessages,
          stream: false,
          options: {
            temperature: settings.temperature,
            num_predict: 512,
          },
          keep_alive: settings.keepAlive,
        }),
      });

      if (!response.ok) {
        throw new Error(`LLM refinement failed: ${response.status}`);
      }

      const data = await response.json();
      // Native Ollama format: { message: { content: "..." } }
      const refinedPrompt: string =
        data.message?.content?.trim() || prompt;

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
        model: settings.selectedModel,
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
    sessionTurnIndex = 0;
    lastStream1PromptTokens = null;
    set({ messages: [] });
  },

  cancelGeneration: () => {
    // Set soft cancel flag for non-HTTP phases (query_expansion, backend_search)
    stopRequested = true;

    // Cancel the backend search if running
    if (currentSearchSessionId) {
      const sessionId = currentSearchSessionId;
      currentSearchSessionId = null;
      invoke('cancel_search', { sessionId }).catch(() => {
        // Ignore errors - search may have already completed
      });
    }

    // Only abort HTTP if we're in a stream phase (not query_expansion/backend_search)
    // During query_expansion/backend_search, the soft cancel flag will stop the pipeline
    if (currentPhase === 'stream1' || currentPhase === 'stream2') {
      const controllerToAbort = currentAbortController;
      currentAbortController = null;
      safeAbort(controllerToAbort);
    } else {
      // For query_expansion/backend_search, just clear the reference (no abort)
      currentAbortController = null;
    }

    // Reset phase
    currentPhase = 'idle';

    // Mark any streaming message as complete (keep partial content)
    set((state) => ({
      isLoading: false,
      messages: state.messages.map((m) =>
        m.isStreaming ? { ...m, isStreaming: false, isSearching: false } : m
      ),
    }));
  },

  setMessages: (messages: Message[]) => {
    sessionTurnIndex = 0;
    lastStream1PromptTokens = null;
    set({ messages });
  },
}));
