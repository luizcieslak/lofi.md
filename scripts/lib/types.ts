// Shapes shared by the scheduler CLI, the dev API and the posts UI.

export type Service = 'youtube' | 'tiktok' | 'instagram'
export const SERVICES: readonly Service[] = ['youtube', 'tiktok', 'instagram']

export function isService(value: string): value is Service {
	return value === 'youtube' || value === 'tiktok' || value === 'instagram'
}

export interface PostRecord {
	id: string
	status: string
	dueAt: string | null
	channelId: string | null
}

export interface BatchItem {
	/** Path relative to the recordings dir, e.g. "backup/2026-10-09T19-18-00/x.mp4". */
	file: string
	/** Free text appended under the credit line. */
	extra: string
	/** Overrides for when the radio API has no match (or gets it wrong). */
	title: string | null
	artist: string | null
	r2Key: string | null
	url: string | null
	posts: Partial<Record<Service, PostRecord>>
	error: string | null
}

export type BatchStatus = 'draft' | 'partial' | 'scheduled'

export interface Batch {
	id: string
	/** YYYY-MM-DD: the first post goes out this day, one per day after it. */
	start: string
	status: BatchStatus
	note: string
	/** Migrated from posted-videos.json; queued before post ids were recorded. */
	imported?: boolean
	items: BatchItem[]
}

export type Theme = 'light' | 'dark'

export interface ScheduleSettings {
	timeZone: string
	windowDays: number
	batchSize: number
	/** Theme of the last post before the alternation started; the next one is the other. */
	themeBefore: Theme
}

export interface Schedule {
	version: 1
	settings: ScheduleSettings
	batches: Batch[]
}

/** Artist, lowercase → Instagram handles. */
export type Handles = Record<string, string[]>

export interface Track {
	id: string
	path?: string
	title: string
	artist: string
	album?: string
	albumArtUrl?: string
	durationMs?: number
}

export interface Video {
	file: string
	name: string
	slug: string
	theme: Theme
	size: number
	mtimeMs: number
}

export interface VideoGroup {
	/** "" for the recordings root, otherwise "backup/<folder>". */
	id: string
	label: string
	/** YYYY-MM-DD; the recordings root counts as today. */
	date: string
	videos: Video[]
}

export interface TrackMatch {
	id: string
	title: string
	artist: string
	album: string | null
	albumArtUrl: string | null
}

/** NDJSON events `schedule.ts run --json` writes to stdout. */
export type RunEvent =
	| { type: 'start'; batchId: string; count: number; dryRun: boolean; draft: boolean; services: Service[] }
	| { type: 'item'; index: number; file: string; title: string; dueAt: string }
	| { type: 'upload'; index: number; key: string; url: string; state: 'exists' | 'uploading' | 'uploaded' | 'skipped' }
	| { type: 'log'; index: number | null; line: string }
	| { type: 'payload'; index: number; service: Service; payload: unknown }
	| ({ type: 'post'; index: number; service: Service; draft: boolean } & PostRecord)
	| { type: 'item-done'; index: number; ok: boolean; skipped: boolean; error: string | null }
	| { type: 'done'; ok: boolean; posted: number; failed: number; skipped: number }
	| { type: 'error'; message: string }
