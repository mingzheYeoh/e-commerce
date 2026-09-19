/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts}'],
  theme: {
    screens: { xs: '420px', sm: '640px', md: '768px', lg: '1024px', xl: '1280px', '2xl': '1536px' },
    extend: {
      colors: {
        void: '#050505',
        'surface-1': '#0D0D0E',
        'surface-2': '#161618',
        'border-hairline': 'rgba(255, 255, 255, 0.08)',
        'accent-cyan': '#00F0FF',
        'accent-amber': '#FF5500',
        'accent-neon': '#39FF14',
        'text-primary': '#F5F5F7',
        'text-secondary': '#8E8E93',
        'text-muted': '#48484A',
      },
      fontFamily: {
        display: ['Syne', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      backgroundImage: {
        'dot-matrix': 'radial-gradient(rgba(255,255,255,0.09) 1px, transparent 1px)',
        scanlines: 'linear-gradient(rgba(18,16,16,0) 50%, rgba(0,0,0,0.25) 50%)',
      },
      backgroundSize: {
        'dot-16': '16px 16px',
        'scan-4': '100% 4px',
      },
      keyframes: {
        marquee: { from: { transform: 'translateX(0)' }, to: { transform: 'translateX(-50%)' } },
        flicker: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.4' } },
      },
      animation: {
        marquee: 'marquee 45s linear infinite',
        flicker: 'flicker 2.5s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
