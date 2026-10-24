import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
export const ROOT_DIR = dirname(SCRIPTS_DIR)

/** Load .env into process.env without overriding variables already set. */
export function loadEnv(): void {
	const file = join(ROOT_DIR, '.env')
	if (!existsSync(file)) return
	for (const raw of readFileSync(file, 'utf8').split('\n')) {
		const line = raw.trim()
		if (!line || line.startsWith('#')) continue
		const eq = line.indexOf('=')
		if (eq < 1) continue
		const key = line.slice(0, eq).trim()
		let value = line.slice(eq + 1).trim()
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1)
		}
		if (process.env[key] === undefined) process.env[key] = value
	}
}

loadEnv()

export const RECORDINGS_DIR = process.env.RECORDINGS_DIR || '/home/luiz/oss/lofi-radio/recordings'
export const RADIO_API_URL = (process.env.VITE_RADIO_API_URL || 'https://radio-api.cieslak.dev').replace(/\/+$/, '')

export const R2_BUCKET = 'album-covers'
export const R2_PREFIX = 'lofi.md'
export const R2_PUBLIC_URL = 'https://cdn.cieslak.dev'

export const SCHEDULE_FILE = join(SCRIPTS_DIR, 'schedule.json')
export const HANDLES_FILE = join(SCRIPTS_DIR, 'instagram-handles.json')
export const POST_VIDEO = join(SCRIPTS_DIR, 'post-video.sh')
export const SCHEDULER = join(SCRIPTS_DIR, 'schedule.ts')

/** Today as YYYY-MM-DD in the given zone. */
export function today(timeZone?: string): string {
	return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
		new Date(),
	)
}
