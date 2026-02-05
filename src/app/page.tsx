'use client';

import { ChatContainer } from '@/components/chat/ChatContainer';
import { useTauriErrorHandler } from '@/hooks/useTauriErrorHandler';

export default function Home() {
  // Suppress known Tauri abort-related errors in dev mode
  useTauriErrorHandler();

  return (
    <main className="h-screen overflow-hidden">
      <ChatContainer />
    </main>
  );
}
