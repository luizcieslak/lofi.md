import { emptyItem, newBatch, nextWindowStart } from '../../scripts/lib/batches.ts'
import type { Catalog, CatalogVideo } from '../../scripts/lib/catalog.ts'
import type { Batch, BatchItem, Handles, Schedule, Theme, Track } from '../../scripts/lib/types.ts'
import type { Config } from './api.ts'

export type Tab = 'batches' | 'handles'

export interface State {
	loading: boolean
	error: string | null
	config: Config | null
	catalog: Catalog | null
	tracks: Track[]
	schedule: Schedule | null
	scheduleMtime: number
	scheduleDirty: boolean
	handles: Handles
	handlesMtime: number
	handlesDirty: boolean
	selected: string | null
	tab: Tab
	notice: { tone: 'info' | 'error'; text: string } | null
}

export const initialState: State = {
	loading: true,
	error: null,
	config: null,
	catalog: null,
	tracks: [],
	schedule: null,
	scheduleMtime: 0,
	scheduleDirty: false,
	handles: {},
	handlesMtime: 0,
	handlesDirty: false,
	selected: null,
	tab: 'batches',
	notice: null,
}

export type Action =
	| { type: 'loaded'; config: Config; catalog: Catalog; schedule: Schedule; scheduleMtime: number; handles: Handles; handlesMtime: number }
	| { type: 'failed'; error: string }
	| { type: 'tracks'; tracks: Track[] }
	| { type: 'config'; config: Config }
	| { type: 'catalog'; catalog: Catalog }
	| { type: 'scheduleSaved'; schedule: Schedule; mtime: number }
	| { type: 'handlesSaved'; handles: Handles; mtime: number }
	/** Put a file in a batch at an index; batchId null takes it out of every batch. */
	| { type: 'move'; file: string; batchId: string | null; index: number }
	| { type: 'editItem'; file: string; patch: Partial<Pick<BatchItem, 'extra' | 'title' | 'artist'>> }
	| { type: 'editBatch'; id: string; patch: Partial<Pick<Batch, 'start' | 'note'>> }
	| { type: 'addBatch'; today: string }
	| { type: 'themeBefore'; theme: Theme }
	| { type: 'removeBatch'; id: string }
	| { type: 'setHandles'; artist: string; handles: string[] }
	| { type: 'select'; file: string | null }
	| { type: 'tab'; tab: Tab }
	| { type: 'notice'; notice: State['notice'] }

function withSchedule(state: State, update: (schedule: Schedule) => Schedule): State {
	if (!state.schedule) return state
	return { ...state, schedule: update(state.schedule), scheduleDirty: true }
}

function mapBatches(schedule: Schedule, update: (batch: Batch) => Batch): Schedule {
	return { ...schedule, batches: schedule.batches.map(update) }
}

export function reducer(state: State, action: Action): State {
	switch (action.type) {
		case 'loaded':
			return {
				...state,
				loading: false,
				error: null,
				config: action.config,
				catalog: action.catalog,
				schedule: action.schedule,
				scheduleMtime: action.scheduleMtime,
				scheduleDirty: false,
				handles: action.handles,
				handlesMtime: action.handlesMtime,
				handlesDirty: false,
			}
		case 'failed':
			return { ...state, loading: false, error: action.error }
		case 'tracks':
			return { ...state, tracks: action.tracks }
		case 'config':
			return { ...state, config: action.config }
		case 'catalog':
			return { ...state, catalog: action.catalog }
		case 'scheduleSaved':
			return { ...state, schedule: action.schedule, scheduleMtime: action.mtime, scheduleDirty: false }
		case 'handlesSaved':
			return { ...state, handles: action.handles, handlesMtime: action.mtime, handlesDirty: false }

		case 'move':
			return withSchedule(state, (schedule) => {
				const existing = schedule.batches.flatMap((b) => b.items).find((item) => item.file === action.file)
				const item = existing ?? emptyItem(action.file)
				const without = mapBatches(schedule, (batch) => ({
					...batch,
					items: batch.items.filter((i) => i.file !== action.file),
				}))
				if (action.batchId === null) return without
				return mapBatches(without, (batch) => {
					if (batch.id !== action.batchId) return batch
					const items = [...batch.items]
					items.splice(Math.min(action.index, items.length), 0, item)
					return { ...batch, items }
				})
			})

		case 'editItem':
			return withSchedule(state, (schedule) =>
				mapBatches(schedule, (batch) => ({
					...batch,
					items: batch.items.map((item) => (item.file === action.file ? { ...item, ...action.patch } : item)),
				})),
			)

		case 'editBatch':
			return withSchedule(state, (schedule) =>
				mapBatches(schedule, (batch) => (batch.id === action.id ? { ...batch, ...action.patch } : batch)),
			)

		case 'addBatch':
			return withSchedule(state, (schedule) => ({
				...schedule,
				batches: [...schedule.batches, newBatch(schedule, nextWindowStart(schedule, action.today))],
			}))

		case 'themeBefore':
			return withSchedule(state, (schedule) => ({ ...schedule, settings: { ...schedule.settings, themeBefore: action.theme } }))

		case 'removeBatch':
			return withSchedule(state, (schedule) => ({
				...schedule,
				batches: schedule.batches.filter((batch) => batch.id !== action.id || batch.status !== 'draft'),
			}))

		case 'setHandles': {
			const handles = { ...state.handles }
			const key = action.artist.toLowerCase()
			if (action.handles.length === 0) delete handles[key]
			else handles[key] = action.handles
			return { ...state, handles, handlesDirty: true }
		}

		case 'select':
			return { ...state, selected: action.file }
		case 'tab':
			return { ...state, tab: action.tab }
		case 'notice':
			return { ...state, notice: action.notice }
	}
}

export function videoIndex(catalog: Catalog | null): Map<string, CatalogVideo> {
	const index = new Map<string, CatalogVideo>()
	for (const group of catalog?.groups ?? []) for (const video of group.videos) index.set(video.file, video)
	return index
}
