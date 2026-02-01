'use client';

import { useState, useEffect } from 'react';
import { X, Check, AlertCircle, Loader2 } from 'lucide-react';
import { fetch } from '@tauri-apps/plugin-http';
import { useChatStore } from '@/stores/chatStore';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const { settings, updateSettings } = useChatStore();
  const [localSettings, setLocalSettings] = useState(settings);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'success' | 'error'>('idle');

  useEffect(() => {
    setLocalSettings(settings);
  }, [settings, isOpen]);

  // Auto-test connection when modal opens
  useEffect(() => {
    if (isOpen) {
      testConnection(localSettings.ollamaUrl);
    }
  }, [isOpen]);

  const testConnection = async (url: string) => {
    setIsTestingConnection(true);
    setConnectionStatus('idle');

    try {
      const response = await fetch(`${url}/models`);
      if (response.ok) {
        setConnectionStatus('success');
      } else {
        setConnectionStatus('error');
      }
    } catch {
      setConnectionStatus('error');
    } finally {
      setIsTestingConnection(false);
    }
  };

  const handleTestConnection = () => {
    testConnection(localSettings.ollamaUrl);
  };

  const handleSave = () => {
    updateSettings(localSettings);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-800">Settings</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-4 space-y-6">
          {/* Ollama URL */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">
              Ollama URL
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={localSettings.ollamaUrl}
                onChange={(e) =>
                  setLocalSettings({ ...localSettings, ollamaUrl: e.target.value })
                }
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg
                           focus:outline-none focus:ring-2 focus:ring-[#FF6B35]/50 focus:border-[#FF6B35]
                           text-sm"
                placeholder="http://localhost:11434/v1"
              />
              <button
                onClick={handleTestConnection}
                disabled={isTestingConnection}
                className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200
                           rounded-lg transition-colors disabled:opacity-50
                           flex items-center gap-1.5"
              >
                {isTestingConnection ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : connectionStatus === 'success' ? (
                  <Check className="w-4 h-4 text-green-500" />
                ) : connectionStatus === 'error' ? (
                  <AlertCircle className="w-4 h-4 text-red-500" />
                ) : null}
                Test
              </button>
            </div>
            {connectionStatus === 'success' && (
              <p className="text-xs text-green-600">Connected successfully</p>
            )}
            {connectionStatus === 'error' && (
              <p className="text-xs text-red-600">Connection failed. Is Ollama running?</p>
            )}
          </div>

          {/* Model (read-only info) */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">
              Model
            </label>
            <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 font-mono">
              ministral-3:3b-instruct-2512-q4_K_M
            </div>
            <p className="text-xs text-gray-500">
              Pre-loaded at app startup, unloaded on exit
            </p>
          </div>

          {/* Language Selection */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">
              TTS Language
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() =>
                  setLocalSettings({ ...localSettings, selectedLang: 'en-us' })
                }
                className={`flex-1 px-4 py-2 rounded-lg border transition-colors text-sm font-medium ${
                  localSettings.selectedLang === 'en-us'
                    ? 'border-[#FF6B35] bg-[#FFF0EB] text-[#FF6B35]'
                    : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
              >
                English
              </button>
              <button
                type="button"
                onClick={() =>
                  setLocalSettings({ ...localSettings, selectedLang: 'fr-fr' })
                }
                className={`flex-1 px-4 py-2 rounded-lg border transition-colors text-sm font-medium ${
                  localSettings.selectedLang === 'fr-fr'
                    ? 'border-[#FF6B35] bg-[#FFF0EB] text-[#FF6B35]'
                    : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
              >
                Francais
              </button>
            </div>
            <p className="text-xs text-gray-500">
              Language for text-to-speech (requires Kokoro TTS sidecar)
            </p>
          </div>

          {/* Models Path */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">
              TTS Models Path
            </label>
            <input
              type="text"
              value={localSettings.modelsPath}
              onChange={(e) =>
                setLocalSettings({ ...localSettings, modelsPath: e.target.value })
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-lg
                         focus:outline-none focus:ring-2 focus:ring-[#FF6B35]/50 focus:border-[#FF6B35]
                         text-sm"
              placeholder="Path to TTS models directory"
            />
            <p className="text-xs text-gray-500">
              Directory containing kokoro-v1.0.onnx and voices-v1.0.bin
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100
                       rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 text-sm text-white bg-[#FF6B35] hover:bg-[#E55A2B]
                       rounded-lg transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
