import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    // Baked in at build time; shown in the footer as "last updated".
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
});
