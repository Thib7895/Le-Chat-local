export const COLORS = {
  background: '#F9F9F9',
  surface: '#FFFFFF',
  border: '#E5E5E5',

  text: {
    primary: '#1A1A1A',
    secondary: '#6B6B6B',
    muted: '#9B9B9B',
  },

  accent: {
    orange: '#FF6B35',
    orangeHover: '#E55A2B',
    orangeLight: '#FFF0EB',
  },

  message: {
    user: '#F0F0F0',
    assistant: '#FFFFFF',
  },
} as const;

export const DEFAULT_SETTINGS = {
  ollamaUrl: 'http://localhost:11434/v1',
  selectedLang: 'en-us',
  modelsPath: 'D:\\Le Chat\\assets\\models',
  selectedModel: 'ministral-3:3b-instruct-2512-q4_K_M',
} as const;

export const SHADOWS = {
  sm: '0 1px 2px rgba(0, 0, 0, 0.05)',
  md: '0 4px 6px rgba(0, 0, 0, 0.07)',
  lg: '0 10px 15px rgba(0, 0, 0, 0.1)',
  inputBar: '0 -4px 20px rgba(0, 0, 0, 0.08)',
} as const;
