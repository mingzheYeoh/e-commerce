/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts}', './console/**/*.{vue,ts,html}'],
  theme: {
    screens: { xs: '420px', sm: '640px', md: '768px', lg: '1024px', xl: '1280px', '2xl': '1536px' },
    extend: {
      colors: {
        // Dark retail palette. Derived from the iOS system colours, which is
        // where the "premium consumer electronics" look most people recognise
        // actually comes from — restrained, high-contrast, one accent.
        void: '#0B0B0D',
        'surface-1': '#141416',
        'surface-2': '#1C1C1F',
        'border-hairline': 'rgba(255, 255, 255, 0.10)',
        'border-strong': 'rgba(255, 255, 255, 0.18)',
        accent: '#0A84FF',
        'accent-hover': '#409CFF',
        'accent-green': '#30D158',
        'accent-amber': '#FF9F0A',
        // iOS system red. Already named by the storefront's error and declined
        // states, which rendered uncoloured until it was defined.
        'accent-red': '#FF453A',
        'text-primary': '#F5F5F7',
        'text-secondary': '#A1A1A6',
        'text-muted': '#6E6E73',
      },
      fontFamily: {
        // Manrope for headings: geometric and confident without the display
        // eccentricity that read as "cyber". Inter carries everything else.
        display: ['Manrope', 'Inter', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '0.5rem',
        card: '0.75rem',
      },
      keyframes: {
        marquee: { from: { transform: 'translateX(0)' }, to: { transform: 'translateX(-50%)' } },
      },
      animation: {
        marquee: 'marquee 60s linear infinite',
      },
    },
  },
  plugins: [],
}
