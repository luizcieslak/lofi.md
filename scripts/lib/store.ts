import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DEFAULT_SETTINGS, batchStatus, emptyItem, isRecord, isSchedule, validateSchedule } from './batches.ts'
import { HANDLES_FILE, RECORDINGS_DIR, SCHEDULE_FILE, SCRIPTS_DIR } from './env.ts'
import { publicUrl } from './r2.ts'
import { absolutePath, locateByName, slugOf } from './recordings.ts'
import type { Batch, BatchItem, Handles, Schedule } from './types.ts'

const LEGACY_QUEUE = join(SCRIPTS_DIR, 'post-queue.json')
const LEGACY_POSTED = join(SCRIPTS_DIR, 'posted-videos.json')

function writeAtomic(file: string, data: unknown): void {
	const tmp = `${file}.${process.pid}.tmp`
	writeFileSync(tmp, `${JSON.stringify(data, null, '\t')}\n`)
	renameSync(tmp, file)
}

function readJson(file: string): unknown {
	return JSON.parse(readFileSync(file, 'utf8'))
}

export function mtimeOf(file: string): number {
	return existsSync(file) ? statSync(file).mtimeMs : 0
}

// --- schedule ----------------------------------------------------------------

function str(value: unknown): string | null {
	return typeof value === 'string' ? value : null
}

/** Fill anything a hand edit left out, and re-derive every batch's status. Returns a copy. */
function normalize(schedule: Schedule): Schedule {
	return {
		...schedule,
		settings: { ...DEFAULT_SETTINGS, ...schedule.settings },
		batches: schedule.batches.map((batch): Batch => {
			const items = batch.items.map((item): BatchItem => ({ ...emptyItem(item.file), ...item, posts: item.posts ?? {} }))
			const next: Batch = { ...batch, note: batch.note ?? '', items }
			return { ...next, status: batchStatus(next) }
		}),
	}
}

/**
 * posted-videos.json + post-queue.json (the old --latest flow) become one imported
 * batch, so those videos count as used. Runs once; the old files are removed.
 */
function migrateLegacy(): Schedule | null {
	if (!existsSync(LEGACY_POSTED)) return null
	const posted = readJson(LEGACY_POSTED)
	const queue = existsSync(LEGACY_QUEUE) ? readJson(LEGACY_QUEUE) : []
	if (!Array.isArray(posted) || !Array.isArray(queue)) return null

	const extras = queue.filter(isRecord).map((entry) => ({ video: str(entry.video) ?? '', extra: str(entry.extra) ?? '' }))
	const items: BatchItem[] = []
	let start: string | null = null
	for (const entry of posted) {
		if (!isRecord(entry)) continue
		const key = str(entry.key)
		if (!key) continue
		const queuedAt = str(entry.queuedAt)
		if (queuedAt && (!start || queuedAt < start)) start = queuedAt.slice(0, 10)
		// lofi.md/<folder>/<file> → backup/<folder>/<file> locally, if it's still there.
		const [, folder = '', name = basename(key)] = key.split('/')
		const file = existsSync(join(RECORDINGS_DIR, 'backup', folder, name)) ? `backup/${folder}/${name}` : `${folder}/${name}`
		const slug = slugOf(name)
		const extra = extras.find((e) => e.video && (slug === e.video || slug.endsWith(`-${e.video}`)))?.extra ?? ''
		items.push({ ...emptyItem(file), extra, r2Key: key, url: publicUrl(key) })
	}
	const startDate = start ?? '2026-10-09'
	return {
		version: 1,
		settings: { ...DEFAULT_SETTINGS, timeZone: process.env.BUFFER_TIMEZONE || DEFAULT_SETTINGS.timeZone },
		batches: [
			{
				id: startDate,
				start: startDate,
				status: 'scheduled',
				note: 'Queued by the old --latest flow (addToQueue), before post ids were recorded.',
				imported: true,
				items,
			},
		],
	}
}

/**
 * Videos get archived (root → backup/<date>/) after they're batched. Point any
 * item whose file moved at its new path, so captions, previews and uploads keep
 * finding it. Returns the paths it changed.
 */
function relink(schedule: Schedule): { from: string; to: string }[] {
	const moved: { from: string; to: string }[] = []
	const missing = schedule.batches.flatMap((b) => b.items).filter((item) => !existsSync(absolutePath(item.file)))
	if (missing.length === 0) return moved
	const byName = locateByName()
	const taken = new Set(schedule.batches.flatMap((b) => b.items.map((item) => item.file)))
	for (const item of missing) {
		const to = byName.get(basename(item.file))
		// Leave it if the new path is already batched: that's a second copy, not a move.
		if (!to || to === item.file || taken.has(to)) continue
		moved.push({ from: item.file, to })
		taken.delete(item.file)
		taken.add(to)
		item.file = to
	}
	return moved
}

export function loadSchedule(): Schedule {
	if (!existsSync(SCHEDULE_FILE)) {
		const migrated = migrateLegacy()
		const fresh: Schedule = migrated ?? {
			version: 1,
			settings: { ...DEFAULT_SETTINGS, timeZone: process.env.BUFFER_TIMEZONE || DEFAULT_SETTINGS.timeZone },
			batches: [],
		}
		saveSchedule(fresh)
		if (migrated) {
			unlinkSync(LEGACY_POSTED)
			if (existsSync(LEGACY_QUEUE)) unlinkSync(LEGACY_QUEUE)
		}
		return fresh
	}
	const data = readJson(SCHEDULE_FILE)
	if (!isSchedule(data)) throw new Error(`${SCHEDULE_FILE}: ${validateSchedule(data)}`)
	const moved = relink(data)
	if (moved.length > 0) {
		for (const { from, to } of moved) console.error(`schedule.json: ${from} moved to ${to}`)
		return saveSchedule(data)
	}
	return normalize(data)
}

export function saveSchedule(schedule: Schedule): Schedule {
	// A page loaded before a move still sends the old paths.
	relink(schedule)
	const error = validateSchedule(schedule)
	if (error) throw new Error(`refusing to save schedule.json: ${error}`)
	const normalized = normalize(schedule)
	writeAtomic(SCHEDULE_FILE, normalized)
	return normalized
}

// --- handles -----------------------------------------------------------------

export function validateHandles(value: unknown): string | null {
	if (!isRecord(value)) return 'not an object'
	for (const [artist, handles] of Object.entries(value)) {
		if (artist !== artist.toLowerCase()) return `artist keys are lowercase: "${artist}"`
		if (!Array.isArray(handles) || !handles.every((h) => typeof h === 'string')) return `${artist}: handles must be strings`
	}
	return null
}

function isHandles(value: unknown): value is Handles {
	return validateHandles(value) === null
}

export function loadHandles(): Handles {
	if (!existsSync(HANDLES_FILE)) return {}
	const data = readJson(HANDLES_FILE)
	if (!isHandles(data)) throw new Error(`${HANDLES_FILE}: ${validateHandles(data)}`)
	return data
}

export function saveHandles(handles: Handles): void {
	const error = validateHandles(handles)
	if (error) throw new Error(`refusing to save instagram-handles.json: ${error}`)
	const sorted: Handles = {}
	for (const artist of Object.keys(handles).sort()) {
		const list = handles[artist].map((h) => h.trim()).filter(Boolean)
		if (list.length > 0) sorted[artist] = list
	}
	writeAtomic(HANDLES_FILE, sorted)
}
