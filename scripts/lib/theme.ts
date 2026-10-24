// Light/dark alternation. Pure, so the posts UI uses the same rules as the runner.
//
// Renders are named <slug>-<uuid>-<theme>-<width>x<height>.mp4 (see lofi-radio's
// recordingFilename). "default" and older names without a theme are light.

import { sortBatches } from './batches.ts'
import type { Batch, Schedule, Theme } from './types.ts'

export type { Theme }

export function themeOf(file: string): Theme {
	return /-dark(-\d+x\d+)?\.[^./]+$/.test(file) ? 'dark' : 'light'
}

export function otherTheme(theme: Theme): Theme {
	return theme === 'light' ? 'dark' : 'light'
}

export interface ThemeSlot {
	batchId: string
	index: number
	file: string
	theme: Theme
	expected: Theme
}

/**
 * Batches that take part in the alternation, in posting order. Imported batches
 * predate the feature; settings.themeBefore is the theme of the last post they made.
 */
function themedBatches(schedule: Schedule): Batch[] {
	return sortBatches(schedule.batches).filter((batch) => !batch.imported)
}

/** Expected theme at a position in the sequence (0 = first post after themeBefore). */
function expectedAt(schedule: Schedule, position: number): Theme {
	const first = otherTheme(schedule.settings.themeBefore)
	return position % 2 === 0 ? first : otherTheme(first)
}

/** Every placed video with its own theme and the one its position requires. */
export function themeSequence(schedule: Schedule): ThemeSlot[] {
	const slots: ThemeSlot[] = []
	for (const batch of themedBatches(schedule)) {
		for (const [index, item] of batch.items.entries()) {
			slots.push({
				batchId: batch.id,
				index,
				file: item.file,
				theme: themeOf(item.file),
				expected: expectedAt(schedule, slots.length),
			})
		}
	}
	return slots
}

/** What the next video dropped at the end of a batch must be. */
export function nextThemeFor(schedule: Schedule, batchId: string): Theme {
	let position = 0
	for (const batch of themedBatches(schedule)) {
		position += batch.items.length
		if (batch.id === batchId) break
	}
	return expectedAt(schedule, position)
}

/**
 * Out-of-sequence videos up to and including a batch: everything that would post
 * before or with it. Later batches can't affect what this one publishes.
 */
export function themeProblems(schedule: Schedule, throughBatchId?: string): ThemeSlot[] {
	const order = themedBatches(schedule).map((b) => b.id)
	const last = throughBatchId === undefined ? order.length - 1 : order.indexOf(throughBatchId)
	const allowed = new Set(order.slice(0, last + 1))
	return themeSequence(schedule).filter((slot) => allowed.has(slot.batchId) && slot.theme !== slot.expected)
}

export function describeProblem(slot: ThemeSlot): string {
	return `${slot.batchId} day ${slot.index + 1} is ${slot.theme}, but the sequence needs ${slot.expected} there`
}
