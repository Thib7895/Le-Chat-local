import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

interface SdForgeState {
  isReady: boolean;
  isLoading: boolean;
  error: string | null;
  initListener: () => Promise<void>;
  cleanup: () => void;
}

let unlistenReady: UnlistenFn | null = null;
let unlistenError: UnlistenFn | null = null;

export const useSdForgeStore = create<SdForgeState>((set) => ({
  isReady: false,
  isLoading: true,
  error: null,

  initListener: async () => {
    // Check initial status
    try {
      const ready = await invoke<boolean>('is_sd_forge_ready');
      set({ isReady: ready, isLoading: !ready });
    } catch (e) {
      console.error('SD Forge status check failed:', e);
    }

    // Listen for ready event
    unlistenReady = await listen('sd-forge-ready', () => {
      console.log('SD Forge: Ready');
      set({ isReady: true, isLoading: false, error: null });
    });

    // Listen for error event
    unlistenError = await listen<string>('sd-forge-error', (event) => {
      console.error('SD Forge error:', event.payload);
      set({ isReady: false, isLoading: false, error: event.payload });
    });
  },

  cleanup: () => {
    unlistenReady?.();
    unlistenError?.();
    unlistenReady = null;
    unlistenError = null;
  },
}));
