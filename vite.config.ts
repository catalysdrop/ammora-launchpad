import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// Base path is "/" by default (Netlify / custom domain). For GitHub Pages
// project sites, build with VITE_BASE=/ammora-launchpad/
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? '/',
})
