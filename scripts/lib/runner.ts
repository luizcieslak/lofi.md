import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addDays, dueAtFor, emptyItem, isRecord, newBatch, nextBatch, nextWindowStart, postedServices, usedFiles } from './batches.ts'
import { buildCaption, resolveItem } from './caption.ts'
import { buildCatalog, findVideo } from './catalog.ts'
import { POST_VIDEO, ROOT_DIR, SCRIPTS_DIR, today } from './env.ts'
import { existsRemote, publicUrl, r2KeyFor, uploadToR2 } from './r2.ts'
import { absolutePath, defaultGroup, findGroup } from './recordings.ts'
import { loadHandles, loadSchedule, saveSchedule } from './store.ts'
import { SERVICES, isService } from './types.ts'
import type { Batch, PostRecord, RunEvent, Schedule, Service } from './types.ts'

export interface RunOptions {
	/** "next" or a batch id. */
	batch: string
	dryRun: boolean
	draft: boolean
	only: Service[]
	/** How many videos to fill an empty batch with; defaults to settings.batchSize. */
	limit: number | null
	/** Recordings folder to fill an empty batch from; defaults to the newest. */
	folder: string | null
}

const LOCK_FILE = join(SCRIPTS_DIR, '.schedule.lock')
// Buffer rejects a dueAt in the past; leave room for the run itself.
const MIN_LEAD_MS = 10 * 60 * 1000

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

/** One run at a time across the CLI and the dev server. */
export function runningPid(): number | null {
	if (!existsSync(LOCK_FILE)) return null
	const pid = Number(readFileSync(LOCK_FILE, 'utf8').trim())
	return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : null
}

function acquireLock(): void {
	const pid = runningPid()
	if (pid !== null) throw new Error(`another run is in progress (pid ${pid})`)
	writeFileSync(LOCK_FILE, String(process.pid))
}

function releaseLock(): void {
	if (existsSync(LOCK_FILE) && readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) unlinkSync(LOCK_FILE)
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

export interface ScriptResult {
	code: number
	posts: (PostRecord & { service: Service })[]
	payloads: { service: Service; payload: unknown }[]
	tail: string[]
}

/** post-video.sh for one item; --report json lines come back on stdout. */
export function postVideo(args: string[], onLog: (line: string) => void): Promise<ScriptResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(POST_VIDEO, [...args, '--report', 'json'], { cwd: ROOT_DIR, env: process.env })
		const result: ScriptResult = { code: 0, posts: [], payloads: [], tail: [] }
		let stdout = ''
		const handleLine = (line: string) => {
			if (!line.trim()) return
			let parsed: unknown
			try {
				parsed = JSON.parse(line)
			} catch {
				onLog(line)
				return
			}
			if (!isRecord(parsed) || typeof parsed.service !== 'string' || !isService(parsed.service)) return
			const service = parsed.service
			if ('payload' in parsed) {
				result.payloads.push({ service, payload: parsed.payload })
			} else if (typeof parsed.id === 'string') {
				result.posts.push({
					service,
					id: parsed.id,
					status: typeof parsed.status === 'string' ? parsed.status : 'unknown',
					dueAt: typeof parsed.dueAt === 'string' ? parsed.dueAt : null,
					channelId: typeof parsed.channelId === 'string' ? parsed.channelId : null,
				})
			}
		}
		child.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString()
			const lines = stdout.split('\n')
			stdout = lines.pop() ?? ''
			lines.forEach(handleLine)
		})
		child.stderr.on('data', (chunk: Buffer) => {
			for (const line of chunk.toString().split('\n')) {
				if (!line.trim()) continue
				result.tail = [...result.tail, line].slice(-6)
				onLog(line)
			}
		})
		child.on('error', reject)
		child.on('close', (code) => {
			handleLine(stdout)
			result.code = code ?? 1
			resolve(result)
		})
	})
}

async function resolveBatch(schedule: Schedule, options: RunOptions, emit: (e: RunEvent) => void): Promise<Batch> {
	let batch: Batch | null =
		options.batch === 'next' ? nextBatch(schedule) : (schedule.batches.find((b) => b.id === options.batch) ?? null)
	if (!batch && options.batch !== 'next') throw new Error(`no batch "${options.batch}" in schedule.json`)
	if (!batch) {
		batch = newBatch(schedule, nextWindowStart(schedule, today(schedule.settings.timeZone)))
		schedule.batches.push(batch)
		emit({ type: 'log', index: null, line: `No open batch; created ${batch.id}.` })
	}
	if (batch.status === 'scheduled') throw new Error(`batch ${batch.id} is already scheduled`)

	if (batch.items.length === 0) {
		// Same rule as the old --latest: next unused videos from the newest folder.
		const catalog = await buildCatalog(schedule)
		const group = options.folder ? findGroup(catalog.groups, options.folder) : defaultGroup(catalog.groups)
		if (!group) throw new Error(options.folder ? `no recordings folder "${options.folder}"` : 'no recordings found')
		const used = usedFiles(schedule)
		const limit = options.limit ?? schedule.settings.batchSize
		const picked = group.videos.filter((video) => !used.has(video.file)).slice(0, limit)
		if (picked.length === 0) throw new Error(`every video in ${group.label} is already in a batch`)
		batch.items = picked.map((video) => emptyItem(video.file))
		emit({
			type: 'log',
			index: null,
			line: `Filled ${batch.id} with ${picked.length} video(s) from ${group.label}${picked.length < limit ? ` (only ${picked.length} unused)` : ''}.`,
		})
	}
	return batch
}

export async function runBatch(options: RunOptions, emit: (e: RunEvent) => void): Promise<boolean> {
	acquireLock()
	try {
		return await run(options, emit)
	} catch (error) {
		emit({ type: 'error', message: errorMessage(error) })
		return false
	} finally {
		releaseLock()
	}
}

async function run(options: RunOptions, emit: (e: RunEvent) => void): Promise<boolean> {
	const schedule = loadSchedule()
	const batch = await resolveBatch(schedule, options, emit)
	const handles = loadHandles()
	const catalog = await buildCatalog(schedule)
	const services = options.only.length > 0 ? options.only : [...SERVICES]
	const { settings } = schedule
	const persist = () => {
		if (!options.dryRun) saveSchedule(schedule)
	}
	persist()

	// Every dueAt has to be in the future before anything is posted.
	const late = batch.items
		.map((item, index) => ({ item, index, dueAt: dueAtFor(batch, index, settings) }))
		.filter(({ item, dueAt }) => postedServices(item).length < services.length && Date.parse(dueAt) < Date.now() + MIN_LEAD_MS)
	if (late.length > 0) {
		const message = `${late.length} post(s) would be due in the past (first: day ${late[0].index + 1}, ${late[0].dueAt}). Move ${batch.id}'s start to ${addDays(today(settings.timeZone), 1)} or later.`
		if (!options.dryRun) throw new Error(message)
		emit({ type: 'log', index: null, line: `warning: ${message}` })
	}

	emit({ type: 'start', batchId: batch.id, count: batch.items.length, dryRun: options.dryRun, draft: options.draft, services })

	let posted = 0
	let failed = 0
	let skipped = 0
	const uploadDay = today(settings.timeZone)

	for (const [index, item] of batch.items.entries()) {
		const video = findVideo(catalog, item.file)
		const resolved = resolveItem(item, video?.slug ?? item.file, video?.track ?? null)
		const caption = buildCaption(resolved, item.extra, handles)
		const dueAt = dueAtFor(batch, index, settings)
		emit({ type: 'item', index, file: item.file, title: caption.credit, dueAt })

		const pending = services.filter((service) => !item.posts[service])
		if (pending.length === 0) {
			skipped++
			emit({ type: 'item-done', index, ok: true, skipped: true, error: null })
			continue
		}

		try {
			const key = item.r2Key ?? r2KeyFor(item.file, uploadDay)
			const url = item.url ?? publicUrl(key)
			if (options.dryRun) {
				emit({ type: 'upload', index, key, url, state: 'skipped' })
			} else if (await existsRemote(url)) {
				emit({ type: 'upload', index, key, url, state: 'exists' })
			} else {
				const absPath = absolutePath(item.file)
				if (!existsSync(absPath)) throw new Error(`${item.file} is not in the recordings folder anymore`)
				emit({ type: 'upload', index, key, url, state: 'uploading' })
				await uploadToR2(absPath, key, (line) => emit({ type: 'log', index, line }))
				emit({ type: 'upload', index, key, url, state: 'uploaded' })
			}
			if (!options.dryRun) {
				item.r2Key = key
				item.url = url
			}

			const args = ['--video', url, '--description', caption.description, '--title', caption.credit, '--due-at', dueAt]
			args.push('--only', pending.join(','))
			if (options.draft) args.push('--draft')
			if (options.dryRun) args.push('--dry-run')
			const result = await postVideo(args, (line) => emit({ type: 'log', index, line }))

			for (const { service, payload } of result.payloads) emit({ type: 'payload', index, service, payload })
			for (const { service, ...record } of result.posts) {
				emit({ type: 'post', index, service, draft: options.draft, ...record })
				// Drafts still need approving in Buffer, so only real posts count as done.
				if (!options.draft) item.posts[service] = record
			}

			if (result.code !== 0) {
				const error = result.tail.filter((line) => /error|failed/i.test(line)).join('\n') || result.tail.join('\n')
				item.error = error || `post-video.sh exited ${result.code}`
				failed++
				emit({ type: 'item-done', index, ok: false, skipped: false, error: item.error })
			} else {
				item.error = null
				posted++
				emit({ type: 'item-done', index, ok: true, skipped: false, error: null })
			}
		} catch (error) {
			item.error = errorMessage(error)
			failed++
			emit({ type: 'item-done', index, ok: false, skipped: false, error: item.error })
		}
		// Save after every item: a crash mid-batch must not forget posts that landed.
		persist()
	}

	emit({ type: 'done', ok: failed === 0, posted, failed, skipped })
	return failed === 0
}
