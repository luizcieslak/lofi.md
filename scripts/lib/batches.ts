// Pure batch and date logic, shared by the scheduler and the posts UI.

import { SERVICES } from './types.ts'
import type { Batch, BatchItem, BatchStatus, Schedule, ScheduleSettings, Service } from './types.ts'

export const DEFAULT_SETTINGS: ScheduleSettings = {
	timeZone: 'America/Sao_Paulo',
	windowDays: 10,
	batchSize: 10,
	// The last video posted before light/dark alternation was light.
	themeBefore: 'light',
}

/** YYYY-MM-DD + n days, calendar arithmetic only. */
export function addDays(date: string, days: number): string {
	const [y, m, d] = date.split('-').map(Number)
	return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

export function windowEnd(batch: Pick<Batch, 'start'>, settings: ScheduleSettings): string {
	return addDays(batch.start, settings.windowDays - 1)
}

export function emptyItem(file: string): BatchItem {
	return { file, extra: '', title: null, artist: null, r2Key: null, url: null, posts: {}, error: null }
}

export function postedServices(item: BatchItem): Service[] {
	return SERVICES.filter((service) => item.posts[service])
}

/** Derived, never hand-set: scheduled once every item is on every network. */
export function batchStatus(batch: Pick<Batch, 'items' | 'imported'>): BatchStatus {
	// Queued by the old --latest flow: posted, but without post ids to show.
	if (batch.imported) return 'scheduled'
	const counts = batch.items.map((item) => postedServices(item).length)
	if (counts.length > 0 && counts.every((n) => n === SERVICES.length)) return 'scheduled'
	if (counts.some((n) => n > 0)) return 'partial'
	return 'draft'
}

export function sortBatches(batches: Batch[]): Batch[] {
	return [...batches].sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id))
}

/** The first batch, by start date, that still has something to schedule. */
export function nextBatch(schedule: Schedule): Batch | null {
	return sortBatches(schedule.batches).find((batch) => batch.status !== 'scheduled') ?? null
}

/** Every file already placed in a batch → that batch's id. */
export function usedFiles(schedule: Schedule): Map<string, string> {
	const used = new Map<string, string>()
	for (const batch of schedule.batches) for (const item of batch.items) used.set(item.file, batch.id)
	return used
}

/**
 * The window after the last batch, or tomorrow if the schedule is empty or behind.
 */
export function nextWindowStart(schedule: Schedule, on: string): string {
	const earliest = addDays(on, 1)
	const last = sortBatches(schedule.batches).at(-1)
	if (!last) return earliest
	const after = addDays(last.start, schedule.settings.windowDays)
	return after < earliest ? earliest : after
}

export function newBatch(schedule: Schedule, start: string): Batch {
	const taken = new Set(schedule.batches.map((b) => b.id))
	let id = start
	for (let n = 2; taken.has(id); n++) id = `${start}-${n}`
	return { id, start, status: 'draft', note: '', items: [] }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Shape check for anything that writes schedule.json (the UI's PUT, mostly). */
export function validateSchedule(value: unknown): string | null {
	if (!isRecord(value)) return 'not an object'
	if (value.version !== 1) return 'version must be 1'
	const settings = value.settings
	if (!isRecord(settings)) return 'settings must be an object'
	if (typeof settings.timeZone !== 'string') return 'settings.timeZone must be a string'
	if (settings.themeBefore !== undefined && settings.themeBefore !== 'light' && settings.themeBefore !== 'dark')
		return 'settings.themeBefore must be light or dark'
	if (!Array.isArray(value.batches)) return 'batches must be an array'
	const ids = new Set<string>()
	const files = new Set<string>()
	for (const batch of value.batches) {
		if (!isRecord(batch) || typeof batch.id !== 'string' || ids.has(batch.id)) return 'duplicate or missing batch id'
		ids.add(batch.id)
		if (typeof batch.start !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(batch.start))
			return `batch ${batch.id}: start must be YYYY-MM-DD`
		if (!Array.isArray(batch.items)) return `batch ${batch.id}: items must be an array`
		for (const item of batch.items) {
			if (!isRecord(item) || typeof item.file !== 'string') return `batch ${batch.id}: item without file`
			if (files.has(item.file)) return `${item.file} is in more than one batch`
			files.add(item.file)
		}
	}
	return null
}

export function isSchedule(value: unknown): value is Schedule {
	return validateSchedule(value) === null
}
