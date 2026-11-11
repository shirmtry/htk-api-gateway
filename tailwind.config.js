/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0b1220',
        panel: '#111b2e',
        line: '#24344f',
        accent: '#38bdf8',
      },
    },
  },
  plugins: [],
};
