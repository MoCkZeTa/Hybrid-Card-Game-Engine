import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// PRD 2: client talks to the backend purely over WebSocket; no REST proxy
// needed here. VITE_WS_URL (see .env.example) points at the backend server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
});
