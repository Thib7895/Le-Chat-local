import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { Message, ImageAttachment } from '@/lib/types';

/** Conversation metadata from database */
export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

/** Message format for database storage */
export interface DbMessage {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  timestamp: number;
  images: string | null; // JSON string of ImageAttachment[]
}

/** Event payload for title updates */
interface TitleUpdatePayload {
  id: string;
  title: string;
}

interface ConversationState {
  conversations: Conversation[];
  currentConversationId: string | null;
  sidebarOpen: boolean;
  isDbInitialized: boolean;

  // Actions
  initDatabase: () => Promise<void>;
  loadConversations: () => Promise<void>;
  createConversation: () => Promise<string>;
  selectConversation: (id: string) => Promise<Message[]>;
  deleteConversation: (id: string) => Promise<void>;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  updateTitle: (id: string, title: string) => void;
  setCurrentConversationId: (id: string | null) => void;

  // Persistence helpers
  saveMessage: (message: Message, conversationId: string) => Promise<void>;
  updateMessageContent: (messageId: string, content: string) => Promise<void>;
  generateTitle: (
    conversationId: string,
    userMessage: string,
    assistantMessage: string
  ) => Promise<void>;
}

// Module-level unsubscribe function for Tauri event listener
let unlistenTitleUpdate: UnlistenFn | null = null;

export const useConversationStore = create<ConversationState>((set, get) => ({
  conversations: [],
  currentConversationId: null,
  sidebarOpen: false,
  isDbInitialized: false,

  initDatabase: async () => {
    try {
      await invoke('db_init');
      set({ isDbInitialized: true });

      // Set up listener for title updates
      if (unlistenTitleUpdate) {
        unlistenTitleUpdate();
      }
      unlistenTitleUpdate = await listen<TitleUpdatePayload>(
        'conversation-title-updated',
        (event) => {
          const { id, title } = event.payload;
          get().updateTitle(id, title);
        }
      );

      // Load existing conversations
      await get().loadConversations();
    } catch (e) {
      console.error('Failed to initialize database:', e);
    }
  },

  loadConversations: async () => {
    try {
      const conversations = await invoke<Conversation[]>('list_conversations');
      set({ conversations });
    } catch (e) {
      console.error('Failed to load conversations:', e);
    }
  },

  createConversation: async () => {
    try {
      const conversation = await invoke<Conversation>('create_conversation');
      set((state) => ({
        conversations: [conversation, ...state.conversations],
        currentConversationId: conversation.id,
      }));
      return conversation.id;
    } catch (e) {
      console.error('Failed to create conversation:', e);
      throw e;
    }
  },

  selectConversation: async (id: string) => {
    try {
      const dbMessages = await invoke<DbMessage[]>('get_conversation_messages', {
        conversationId: id,
      });

      // Convert DbMessage to Message format
      const messages: Message[] = dbMessages.map((dbMsg) => ({
        id: dbMsg.id,
        role: dbMsg.role as 'user' | 'assistant' | 'system',
        content: dbMsg.content,
        timestamp: dbMsg.timestamp,
        images: dbMsg.images ? JSON.parse(dbMsg.images) as ImageAttachment[] : undefined,
      }));

      set({ currentConversationId: id });
      return messages;
    } catch (e) {
      console.error('Failed to select conversation:', e);
      throw e;
    }
  },

  deleteConversation: async (id: string) => {
    try {
      await invoke('delete_conversation', { conversationId: id });

      set((state) => {
        const newConversations = state.conversations.filter((c) => c.id !== id);
        const newCurrentId =
          state.currentConversationId === id
            ? newConversations[0]?.id || null
            : state.currentConversationId;

        return {
          conversations: newConversations,
          currentConversationId: newCurrentId,
        };
      });
    } catch (e) {
      console.error('Failed to delete conversation:', e);
      throw e;
    }
  },

  toggleSidebar: () => {
    set((state) => ({ sidebarOpen: !state.sidebarOpen }));
  },

  setSidebarOpen: (open: boolean) => {
    set({ sidebarOpen: open });
  },

  updateTitle: (id: string, title: string) => {
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, title } : c
      ),
    }));
  },

  setCurrentConversationId: (id: string | null) => {
    set({ currentConversationId: id });
  },

  saveMessage: async (message: Message, conversationId: string) => {
    try {
      const dbMessage: DbMessage = {
        id: message.id,
        conversationId,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        images: message.images ? JSON.stringify(message.images) : null,
      };

      await invoke('save_message', { message: dbMessage });
    } catch (e) {
      console.error('Failed to save message:', e);
    }
  },

  updateMessageContent: async (messageId: string, content: string) => {
    try {
      await invoke('update_message_content', { messageId, content });
    } catch (e) {
      console.error('Failed to update message content:', e);
    }
  },

  generateTitle: async (
    conversationId: string,
    userMessage: string,
    assistantMessage: string
  ) => {
    try {
      // This is a fire-and-forget call - the title will be updated via event
      invoke('generate_conversation_title', {
        conversationId,
        userMessage,
        assistantMessage,
      }).catch((e) => {
        console.warn('Failed to generate title:', e);
      });
    } catch (e) {
      console.warn('Failed to initiate title generation:', e);
    }
  },
}));
