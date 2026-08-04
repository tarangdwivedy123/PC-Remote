/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      /**
       * AMOLED-oriented palette. The phone sits on a desk with the screen on
       * for hours, so pure black is the default surface (unlit pixels draw no
       * power and cannot burn in) and every accent is desaturated well below
       * full brightness. Nothing here is a large light area on purpose.
       */
      /**
       * Every colour is a CSS variable so the whole palette can be swapped at
       * runtime. The values live in index.css: the dark set on :root, the light
       * set under .theme-light.
       *
       * Plain `var(...)` rather than Tailwind's `rgb(var(--x) / <alpha-value>)`
       * form, which would buy opacity modifiers at the cost of every colour
       * having to be stored as bare channel numbers. Nothing here uses an
       * opacity modifier on a themed colour.
       */
      colors: {
        ink: {
          950: 'var(--ink-950)',
          900: 'var(--ink-900)',
          800: 'var(--ink-800)',
          700: 'var(--ink-700)',
          600: 'var(--ink-600)',
          500: 'var(--ink-500)',
        },
        line: {
          DEFAULT: 'var(--line)',
          bright: 'var(--line-bright)',
        },
        fg: {
          DEFAULT: 'var(--fg)',
          dim: 'var(--fg-dim)',
          faint: 'var(--fg-faint)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          dim: 'var(--accent-dim)',
          bright: 'var(--accent-bright)',
        },
        warn: {
          DEFAULT: 'var(--warn)',
          bright: 'var(--warn-bright)',
        },
        danger: {
          DEFAULT: 'var(--danger)',
          bright: 'var(--danger-bright)',
        },
      },
      keyframes: {
        'spin-slow': {
          from: { transform: 'rotate(0deg)' },
          to: { transform: 'rotate(360deg)' },
        },
      },
      animation: {
        // Slower than Tailwind's default spin: this sits on an always-on AMOLED
        // panel, and a fast spinner is both distracting and needless repainting
        // on a weak GPU.
        'spin-slow': 'spin-slow 1.6s linear infinite',
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
        mono: ['"Roboto Mono"', 'Consolas', 'Menlo', 'monospace'],
      },
      spacing: {
        // Minimum comfortable touch target, referenced as h-touch / min-h-touch.
        touch: '48px',
        'touch-lg': '56px',
      },
      borderRadius: {
        card: '14px',
      },
      fontSize: {
        // Numeric readouts want a tight line-height so rows stay compact.
        stat: ['1.375rem', { lineHeight: '1.1' }],
        'stat-lg': ['1.75rem', { lineHeight: '1.05' }],
      },
    },
  },
  // Nothing here relies on :has(), container queries, or backdrop-filter.
  plugins: [],
};
