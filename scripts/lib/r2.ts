import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { R2_BUCKET, R2_PREFIX, R2_PUBLIC_URL, ROOT_DIR } from './env.ts'

/**
 * lofi.md/<folder>/<file>, mirroring the local folder. Renders still at the
 * recordings root have no folder yet, so they go under the upload day.
 */
export function r2KeyFor(file: string, uploadDay: string): string {
	const folder = dirname(file)
	const name = basename(file)
	const remoteFolder = folder === '.' ? uploadDay : basename(folder)
	return `${R2_PREFIX}/${remoteFolder}/${name}`
}

export function publicUrl(key: string): string {
	return `${R2_PUBLIC_URL}/${key.split('/').map(encodeURIComponent).join('/')}`
}

/** A HEAD on the public CDN: no credentials needed, and it's what Buffer will fetch. */
export async function existsRemote(url: string): Promise<boolean> {
	try {
		const response = await fetch(url, { method: 'HEAD' })
		return response.ok
	} catch {
		return false
	}
}

function wranglerBin(): string {
	const local = join(ROOT_DIR, 'node_modules', '.bin', 'wrangler')
	return existsSync(local) ? local : 'wrangler'
}

/** wrangler r2 object put, streaming its output line by line. */
export function uploadToR2(absPath: string, key: string, onLine: (line: string) => void): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			wranglerBin(),
			['r2', 'object', 'put', `${R2_BUCKET}/${key}`, '--file', absPath, '--remote', '--content-type', 'video/mp4'],
			{ cwd: ROOT_DIR, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } },
		)
		const forward = (chunk: Buffer) => {
			for (const line of chunk.toString().split('\n')) if (line.trim()) onLine(line)
		}
		child.stdout.on('data', forward)
		child.stderr.on('data', forward)
		child.on('error', reject)
		child.on('close', (code) => {
			if (code === 0) resolve()
			else reject(new Error(`wrangler r2 object put exited ${code}; run 'npx wrangler login' or set CLOUDFLARE_API_TOKEN`))
		})
	})
}
