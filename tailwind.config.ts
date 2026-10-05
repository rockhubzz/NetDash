import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        graphite: {
          950: '#0d0f12',
          900: '#14171b',
          800: '#1c2026',
          700: '#262b33',
          600: '#343b45',
        },
        signal: {
          DEFAULT: '#e8a33d',
          dim: '#8a6323',
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
