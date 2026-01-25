import { defineConfig } from 'vite'

export default defineConfig({
    base: '/AppDate/',
    build: {
        chunkSizeWarningLimit: 1000,
    }
})
