// Dev-server-only API behind /posts.html. Reads and writes the same files as
// scripts/schedule.ts and runs it for the real work, so the UI and the terminal
// can't drift apart. `apply: 'serve'` keeps all of this out of `vite build`.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Plugin } from 'vite'
import { dueAtFor, isRecord, isSchedule, validateSchedule } from './lib/batches.ts'
import { buildCaption, resolveItem } from './lib/caption.ts'
import { buildCatalog, findVideo } from './lib/catalog.ts'
import { HANDLES_FILE, RECORDINGS_DIR, ROOT_DIR, SCHEDULE_FILE, SCHEDULER } from './lib/env.ts'
import { postVideo, runningPid } from './lib/runner.ts'
import { loadHandles, loadSchedule, mtimeOf, saveHandles, saveSchedule, validateHandles } from './lib/store.ts'
import { fetchTracks } from './lib/tracks.ts'
import { SERVICES, isService } from './lib/types.ts'
import type { BatchItem, Handles, RunEvent, Schedule } from './lib/types.ts'

const BASE = '/__posts'

function send(res: ServerResponse, status: number, body: unknown): void {
	res.statusCode = status
	res.setHeader('Content-Type', 'application/json')
	res.setHeader('Cache-Control', 'no-store')
	res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let data = ''
		req.on('data', (chunk: Buffer) => {
			data += chunk.toString()
		})
		req.on('end', () => {
			try {
				resolve(data ? JSON.parse(data) : {})
			} catch {
				reject(new Error('body is not JSON'))
			}
		})
		req.on('error', reject)
	})
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function isHandles(value: unknown): value is Handles {
	return validateHandles(value) === null
}

/**
 * The runner owns upload and post results; a UI save made from an older copy
 * must never wipe them, so those fields always come from disk.
 */
function keepRunnerFields(incoming: Schedule, current: Schedule): Schedule {
	const onDisk = new Map<string, BatchItem>()
	for (const batch of current.batches) for (const item of batch.items) onDisk.set(item.file, item)
	return {
		...incoming,
		batches: incoming.batches.map((batch) => ({
			...batch,
			items: batch.items.map((item) => {
				const saved = onDisk.get(item.file)
				return saved ? { ...item, posts: saved.posts, r2Key: saved.r2Key, url: saved.url, error: saved.error } : item
			}),
		})),
	}
}

function bufferProfile(): 'repo' | 'env' | 'global' {
	if (process.env.BUFFER_API_KEY) return 'env'
	return existsSync(join(ROOT_DIR, '.buffer', 'config.json')) ? 'repo' : 'global'
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? '/', 'http://localhost')
	const route = `${req.method} ${url.pathname.slice(BASE.length)}`

	switch (route) {
		case 'GET /config':
			return send(res, 200, {
				recordingsDir: RECORDINGS_DIR,
				bufferProfile: bufferProfile(),
				channels: {
					youtube: process.env.BUFFER_YOUTUBE_CHANNEL_ID || null,
					tiktok: process.env.BUFFER_TIKTOK_CHANNEL_ID || null,
					instagram: process.env.BUFFER_INSTAGRAM_CHANNEL_ID || null,
				},
				running: runningPid() !== null,
			})

		case 'GET /videos':
			return send(res, 200, await buildCatalog(loadSchedule()))

		case 'GET /tracks':
			return send(res, 200, { tracks: await fetchTracks(url.searchParams.has('refresh')) })

		case 'GET /schedule':
			return send(res, 200, { schedule: loadSchedule(), mtime: mtimeOf(SCHEDULE_FILE) })

		case 'PUT /schedule': {
			const body = await readBody(req)
			if (!isRecord(body)) return send(res, 400, { error: 'expected { schedule, mtime }' })
			if (runningPid() !== null) return send(res, 409, { error: 'a run is in progress; save when it finishes' })
			if (body.mtime !== mtimeOf(SCHEDULE_FILE))
				return send(res, 409, { error: 'schedule.json changed on disk since you loaded it; reload first' })
			if (!isSchedule(body.schedule)) return send(res, 400, { error: validateSchedule(body.schedule) })
			const saved = saveSchedule(keepRunnerFields(body.schedule, loadSchedule()))
			return send(res, 200, { schedule: saved, mtime: mtimeOf(SCHEDULE_FILE) })
		}

		case 'GET /handles':
			return send(res, 200, { handles: loadHandles(), mtime: mtimeOf(HANDLES_FILE) })

		case 'PUT /handles': {
			const body = await readBody(req)
			if (!isRecord(body)) return send(res, 400, { error: 'expected { handles, mtime }' })
			if (body.mtime !== mtimeOf(HANDLES_FILE))
				return send(res, 409, { error: 'instagram-handles.json changed on disk since you loaded it; reload first' })
			if (!isHandles(body.handles)) return send(res, 400, { error: validateHandles(body.handles) })
			saveHandles(body.handles)
			return send(res, 200, { handles: loadHandles(), mtime: mtimeOf(HANDLES_FILE) })
		}

		case 'POST /preview': {
			// The exact payloads post-video.sh would send, from its own --dry-run.
			const body = await readBody(req)
			if (!isRecord(body) || typeof body.batchId !== 'string' || typeof body.index !== 'number')
				return send(res, 400, { error: 'expected { batchId, index }' })
			const schedule = loadSchedule()
			const batch = schedule.batches.find((b) => b.id === body.batchId)
			const item = batch?.items[body.index]
			if (!batch || !item) return send(res, 404, { error: 'no such item; save first' })
			const video = findVideo(await buildCatalog(schedule), item.file)
			const resolved = resolveItem(item, video?.slug ?? item.file, video?.track ?? null)
			const caption = buildCaption(resolved, item.extra, loadHandles())
			const placeholder = item.url ?? 'https://cdn.cieslak.dev/lofi.md/preview.mp4'
			const log: string[] = []
			const result = await postVideo(
				[
					'--video', placeholder,
					'--description', caption.description,
					'--title', caption.credit,
					'--due-at', dueAtFor(batch, body.index, schedule.settings),
					'--dry-run',
				],
				(line) => log.push(line),
			)
			return send(res, result.code === 0 ? 200 : 422, { payloads: result.payloads, log })
		}

		case 'POST /run': {
			const body = await readBody(req)
			if (!isRecord(body) || typeof body.batchId !== 'string') return send(res, 400, { error: 'expected { batchId }' })
			if (runningPid() !== null) return send(res, 409, { error: 'a run is already in progress' })
			const args = [SCHEDULER, 'run', body.batchId, '--json']
			if (body.dryRun === true) args.push('--dry-run')
			if (body.draft === true) args.push('--draft')
			if (Array.isArray(body.only)) {
				const only = body.only.filter((s): s is string => typeof s === 'string' && isService(s))
				if (only.length > 0 && only.length < SERVICES.length) args.push('--only', only.join(','))
			}

			res.statusCode = 200
			res.setHeader('Content-Type', 'application/x-ndjson')
			res.setHeader('Cache-Control', 'no-store')
			res.setHeader('X-Accel-Buffering', 'no')
			const write = (event: RunEvent) => res.write(`${JSON.stringify(event)}\n`)

			// Not killed if the tab closes: half a batch posted is worse than a finished one.
			const child = spawn(process.execPath, args, { cwd: ROOT_DIR, env: process.env })
			let pending = ''
			child.stdout.on('data', (chunk: Buffer) => {
				pending += chunk.toString()
				const lines = pending.split('\n')
				pending = lines.pop() ?? ''
				for (const line of lines) if (line.trim()) res.write(`${line}\n`)
			})
			child.stderr.on('data', (chunk: Buffer) => {
				for (const line of chunk.toString().split('\n')) if (line.trim()) write({ type: 'log', index: null, line })
			})
			child.on('error', (error) => write({ type: 'error', message: error.message }))
			child.on('close', () => {
				if (pending.trim()) res.write(`${pending}\n`)
				res.end()
			})
			return
		}

		default:
			return send(res, 404, { error: `no route ${route}` })
	}
}

export function postsApi(): Plugin {
	return {
		name: 'lofi-posts-api',
		apply: 'serve',
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				if (!req.url?.startsWith(BASE)) return next()
				handle(req, res).catch((error: unknown) => send(res, 500, { error: message(error) }))
			})
		},
	}
}
