'use client';

import { useEffect } from 'react';

/**
 * Hook to suppress known Tauri abort-related errors in dev mode.
 * These errors occur when HTTP requests are cancelled (e.g., user clicks Stop)
 * and the Tauri HTTP plugin throws "resource id invalid" errors.
 *
 * This hook should be called once at the app root level.
 */
export function useTauriErrorHandler() {
  useEffect(() => {
    const handler = (event: PromiseRejectionEvent) => {
      const reason = String(event.reason).toLowerCase();
      // Ignore known Tauri abort-related errors
      if (
        reason.includes('resource id') ||
        reason.includes('cancelled') ||
        reason.includes('canceled') ||
        reason.includes('aborted')
      ) {
        event.preventDefault(); // Suppress the error overlay in dev
      }
    };

    window.addEventListener('unhandledrejection', handler);
    return () => window.removeEventListener('unhandledrejection', handler);
  }, []);
}
