import {
	DndContext,
	DragOverlay,
	KeyboardSensor,
	PointerSensor,
	closestCenter,
	pointerWithin,
	useSensor,
	useSensors,
} from '@dnd-kit/core'
import type { CollisionDetection, DragEndEvent, DragStartEvent } from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { nextBatch, sortBatches } from '../../scripts/lib/batches.ts'
import { nextThemeFor, themeOf, themeProblems, themeSequence } from '../../scripts/lib/theme.ts'
import type { Schedule } from '../../scripts/lib/types.ts'
import { SERVICES } from '../../scripts/lib/types.ts'
import { ApiError, api, streamRun } from './api.ts'
import { BatchCard } from './BatchCard.tsx'
import { Handles } from './Handles.tsx'
import { Inspector } from './Inspector.tsx'
import { Library } from './Library.tsx'
import { applyEvent, startRun } from './RunPanel.tsx'
import type { RunMode, RunState } from './RunPanel.tsx'
import { initialState, reducer, videoIndex } from './store.ts'
import { Art, SERVICE_LABEL, ThemeSwatch, viewItem } from './ui.tsx'

// Drop targets: a batch item (insert before it), a batch (append) or the library (remove).
type DropTarget = { kind: 'item'; batchId: string; index: number } | { kind: 'batch'; batchId: string } | { kind: 'library' }

function dropTarget(data: Record<string, unknown> | undefined): DropTarget | null {
	if (!data) return null
	if (data.kind === 'library') return { kind: 'library' }
	if (data.kind === 'batch' && typeof data.batchId === 'string') return { kind: 'batch', batchId: data.batchId }
	if (data.kind === 'item' && typeof data.batchId === 'string' && typeof data.index === 'number')
		return { kind: 'item', batchId: data.batchId, index: data.index }
	return null
}

function fileOf(data: Record<string, unknown> | undefined): string | null {
	return typeof data?.file === 'string' ? data.file : null
}

/** Prefer the item under the pointer, so a drop lands between rows; fall back to its container. */
const collision: CollisionDetection = (args) => {
	const within = pointerWithin(args)
	const items = within.filter((c) => String(c.id).startsWith('item:'))
	if (items.length > 0) return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((c) => items.some((i) => i.id === c.id)) })
	return within.length > 0 ? within : closestCenter(args)
}

function today(timeZone: string): string {
	return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

/** Why a batch can't be scheduled because of the light/dark sequence, or null. */
function themeBlockFor(schedule: Schedule, batchId: string): string | null {
	const problems = themeProblems(schedule, batchId)
	if (problems.length === 0) return null
	const first = problems[0]
	const where = first.batchId === batchId ? `Day ${first.index + 1}` : `Batch ${first.batchId}, day ${first.index + 1},`
	return `Light and dark must alternate: ${where} is ${first.theme} but needs ${first.expected}.`
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

export function App() {
	const [state, dispatch] = useReducer(reducer, initialState)
	const [runs, setRuns] = useState<Record<string, RunState>>({})
	const [dragging, setDragging] = useState<string | null>(null)
	const [saving, setSaving] = useState(false)
	const stateRef = useRef(state)
	stateRef.current = state

	const sensors = useSensors(
		// A small distance keeps a click a click (it opens the inspector).
		useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	)

	const load = useCallback(async () => {
		try {
			const [config, schedule, handles] = await Promise.all([api.config(), api.schedule(), api.handles()])
			const catalog = await api.videos()
			dispatch({
				type: 'loaded',
				config,
				catalog,
				schedule: schedule.data,
				scheduleMtime: schedule.mtime,
				handles: handles.data,
				handlesMtime: handles.mtime,
			})
		} catch (error) {
			dispatch({ type: 'failed', error: errorText(error) })
		}
		api.tracks()
			.then((tracks) => dispatch({ type: 'tracks', tracks }))
			.catch(() => dispatch({ type: 'tracks', tracks: [] }))
	}, [])

	useEffect(() => {
		load()
	}, [load])

	const save = useCallback(async () => {
		const current = stateRef.current
		if (!current.schedule || (!current.scheduleDirty && !current.handlesDirty)) return
		setSaving(true)
		try {
			if (current.handlesDirty) {
				const saved = await api.saveHandles(current.handles, current.handlesMtime)
				dispatch({ type: 'handlesSaved', handles: saved.data, mtime: saved.mtime })
			}
			if (current.scheduleDirty) {
				const saved = await api.saveSchedule(current.schedule, current.scheduleMtime)
				dispatch({ type: 'scheduleSaved', schedule: saved.data, mtime: saved.mtime })
			}
			dispatch({ type: 'notice', notice: { tone: 'info', text: 'Saved' } })
		} catch (error) {
			const text = error instanceof ApiError && error.status === 409 ? `${error.message}.` : `Save failed: ${errorText(error)}`
			dispatch({ type: 'notice', notice: { tone: 'error', text } })
		} finally {
			setSaving(false)
		}
	}, [])

	// ⌘S / Ctrl+S saves; leaving with unsaved edits asks first.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
				event.preventDefault()
				save()
			}
		}
		const onUnload = (event: BeforeUnloadEvent) => {
			if (stateRef.current.scheduleDirty || stateRef.current.handlesDirty) event.preventDefault()
		}
		window.addEventListener('keydown', onKey)
		window.addEventListener('beforeunload', onUnload)
		return () => {
			window.removeEventListener('keydown', onKey)
			window.removeEventListener('beforeunload', onUnload)
		}
	}, [save])

	useEffect(() => {
		if (state.notice?.tone !== 'info') return
		const timer = window.setTimeout(() => dispatch({ type: 'notice', notice: null }), 1800)
		return () => window.clearTimeout(timer)
	}, [state.notice])

	const run = useCallback(
		async (batchId: string, mode: RunMode) => {
			setRuns((all) => ({ ...all, [batchId]: startRun(mode) }))
			try {
				await streamRun({ batchId, dryRun: mode === 'dry', draft: mode === 'draft', only: [...SERVICES] }, (event) =>
					setRuns((all) => {
						const current = all[batchId] ?? startRun(mode)
						return { ...all, [batchId]: applyEvent(current, event) }
					}),
				)
			} catch (error) {
				setRuns((all) => ({ ...all, [batchId]: { ...(all[batchId] ?? startRun(mode)), running: false, error: errorText(error) } }))
			}
			setRuns((all) => (all[batchId]?.running ? { ...all, [batchId]: { ...all[batchId], running: false } } : all))
			// The runner wrote post ids, R2 keys and errors to schedule.json.
			await load()
		},
		[load],
	)

	if (state.loading) return <div className="splash">Loading videos and batches…</div>
	if (state.error || !state.schedule || !state.catalog || !state.config)
		return (
			<div className="splash error">
				<p>{state.error ?? 'Nothing loaded.'}</p>
				<button type="button" className="btn" onClick={load}>
					Retry
				</button>
			</div>
		)

	const { schedule, catalog, config } = state
	const videos = videoIndex(catalog)
	const batches = sortBatches(schedule.batches)
	const next = nextBatch(schedule)
	// Next up first, then upcoming by date; finished batches sink to the bottom.
	const ordered = [
		...batches.filter((b) => b.status !== 'scheduled'),
		...batches.filter((b) => b.status === 'scheduled').reverse(),
	]
	const dirty = state.scheduleDirty || state.handlesDirty
	const expected = new Map(themeSequence(schedule).map((slot) => [slot.file, slot.expected]))
	const anyRunning = config.running || Object.values(runs).some((r) => r.running)
	const missingChannels = SERVICES.filter((s) => !config.channels[s])
	const canRun = anyRunning
		? 'A run is in progress.'
		: dirty
			? 'Save your changes first.'
			: missingChannels.length > 0
				? `Set BUFFER_${missingChannels[0].toUpperCase()}_CHANNEL_ID in .env.`
				: null

	const selectedBatch = state.selected ? (schedule.batches.find((b) => b.items.some((i) => i.file === state.selected)) ?? null) : null
	const selectedIndex = selectedBatch?.items.findIndex((i) => i.file === state.selected) ?? -1

	const onDragStart = (event: DragStartEvent) => setDragging(fileOf(event.active.data.current))
	const onDragEnd = ({ active, over }: DragEndEvent) => {
		setDragging(null)
		const file = fileOf(active.data.current)
		const target = dropTarget(over?.data.current)
		if (!file || !target) return
		if (target.kind === 'library') {
			if (schedule.batches.some((b) => b.items.some((i) => i.file === file))) dispatch({ type: 'move', file, batchId: null, index: 0 })
			return
		}
		const batch = schedule.batches.find((b) => b.id === target.batchId)
		if (!batch || batch.status !== 'draft') return
		const others = batch.items.filter((i) => i.file !== file)
		if (others.length >= schedule.settings.batchSize) {
			dispatch({ type: 'notice', notice: { tone: 'error', text: `That batch is full (${schedule.settings.batchSize}). Move something out first.` } })
			return
		}
		const index = target.kind === 'item' ? target.index : others.length
		dispatch({ type: 'move', file, batchId: batch.id, index })
	}

	const draggingVideo = dragging ? videos.get(dragging) : undefined
	const draggingItem = dragging ? schedule.batches.flatMap((b) => b.items).find((i) => i.file === dragging) : undefined

	return (
		<div className="app" data-inspector={state.selected ? '' : undefined}>
			<header className="topbar">
				<h1>
					lofi.md <span className="muted">posts</span>
				</h1>
				<nav className="tabs" aria-label="Views">
					<button type="button" aria-pressed={state.tab === 'batches'} onClick={() => dispatch({ type: 'tab', tab: 'batches' })}>
						Batches
					</button>
					<button type="button" aria-pressed={state.tab === 'handles'} onClick={() => dispatch({ type: 'tab', tab: 'handles' })}>
						Handles
					</button>
				</nav>
				<div className="status">
					<span className="muted" title="Which Buffer config the CLI uses here">
						Buffer: {config.bufferProfile === 'global' ? <span className="warn">global profile</span> : `${config.bufferProfile} profile`}
					</span>
					{missingChannels.length > 0 && (
						<span className="warn" title="Set these in .env">
							no {missingChannels.map((s) => SERVICE_LABEL[s]).join(', ')} channel
						</span>
					)}
					{state.notice && (
						<span className={`notice notice-${state.notice.tone}`} role="status">
							{state.notice.text}
						</span>
					)}
					<button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={save} title="⌘S">
						{saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
					</button>
				</div>
			</header>

			{state.tab === 'handles' ? (
				<main className="main main-single">
					<Handles
						handles={state.handles}
						tracks={state.tracks}
						schedule={schedule}
						videos={videos}
						onChange={(artist, handles) => dispatch({ type: 'setHandles', artist, handles })}
					/>
				</main>
			) : (
				<DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
					<main className="main">
						<Library catalog={catalog} schedule={schedule} selected={state.selected} onSelect={(file) => dispatch({ type: 'select', file })} />
						<section className="batches" aria-label="Batches">
							<header className="pane-head">
								<h2>Batches</h2>
								<span className="muted">
									{schedule.settings.batchSize} posts, one per day using each channel's Buffer schedule, light and dark alternating
								</span>
								<label className="field-inline" title="Theme of the last post before the alternation started">
									<span>Post before</span>
									<select
										value={schedule.settings.themeBefore}
										onChange={(e) => dispatch({ type: 'themeBefore', theme: e.target.value === 'dark' ? 'dark' : 'light' })}
									>
										<option value="light">light</option>
										<option value="dark">dark</option>
									</select>
								</label>
								<button type="button" className="btn" onClick={() => dispatch({ type: 'addBatch', today: today(schedule.settings.timeZone) })}>
									+ Add batch
								</button>
							</header>
							{ordered.length === 0 && <p className="pane-note">No batches yet. Add one, then drag videos into it.</p>}
							{ordered.map((batch) => (
								<BatchCard
									key={batch.id}
									batch={batch}
									settings={schedule.settings}
									videos={videos}
									handles={state.handles}
									isNext={batch.id === next?.id}
									selected={state.selected}
									run={runs[batch.id] ?? null}
									canRun={canRun}
									expected={expected}
									nextTheme={nextThemeFor(schedule, batch.id)}
									themeBlock={themeBlockFor(schedule, batch.id)}
									onSelect={(file) => dispatch({ type: 'select', file })}
									onEdit={(patch) => dispatch({ type: 'editBatch', id: batch.id, patch })}
									onRemove={() => dispatch({ type: 'removeBatch', id: batch.id })}
									onRun={(mode) => run(batch.id, mode)}
								/>
							))}
						</section>
					</main>
					<DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }}>
						{dragging && (
							<div className="row drag-overlay">
								<Art src={draggingVideo?.track?.albumArtUrl} />
								<span className="row-text">
									<span className="row-title">
										{viewItem(draggingItem ?? { title: null, artist: null, extra: '' }, draggingVideo, dragging, state.handles).resolved.title}
									</span>
									<span className="row-sub">{draggingVideo?.track?.artist ?? ''}</span>
								</span>
								<ThemeSwatch theme={themeOf(dragging)} label />
							</div>
						)}
					</DragOverlay>
				</DndContext>
			)}

			{state.selected && (
				<Inspector
					key={state.selected}
					file={state.selected}
					video={videos.get(state.selected)}
					batch={selectedBatch}
					index={selectedIndex}
					item={selectedBatch?.items[selectedIndex] ?? null}
					handles={state.handles}
					recordingsDir={config.recordingsDir}
					dirty={dirty}
					onEdit={(patch) => state.selected && dispatch({ type: 'editItem', file: state.selected, patch })}
					onClose={() => dispatch({ type: 'select', file: null })}
				/>
			)}
		</div>
	)
}
