import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { RECORDINGS_DIR } from './scripts/lib/env.ts'
import { postsApi } from './scripts/vite-posts-api.ts'

export default defineConfig({
	plugins: [react(), postsApi()],
	server: {
		// /posts.html previews local renders straight from disk through /@fs/.
		fs: { allow: ['.', RECORDINGS_DIR] },
	},
	build: {
		// Only the radio ships; posts.html is a dev-server tool.
		rollupOptions: { input: 'index.html' },
	},
})
