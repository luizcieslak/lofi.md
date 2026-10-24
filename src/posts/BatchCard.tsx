import { useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { addDays, windowEnd } from '../../scripts/lib/batches.ts'
import type { CatalogVideo } from '../../scripts/lib/catalog.ts'
import { otherTheme, themeOf } from '../../scripts/lib/theme.ts'
import type { Batch, BatchItem, Handles, ScheduleSettings, Theme } from '../../scripts/lib/types.ts'
import { RunPanel } from './RunPanel.tsx'
import type { RunState } from './RunPanel.tsx'
import { Art, Chip, ServiceDots, ThemeSwatch, formatDate, formatDay, viewItem } from './ui.tsx'

interface Props {
	batch: Batch
	settings: ScheduleSettings
	videos: Map<string, CatalogVideo>
	handles: Handles
	isNext: boolean
	selected: string | null
	run: RunState | null
	canRun: string | null
	/** Theme each placed video's position requires. */
	expected: Map<string, Theme>
	/** Theme the first empty slot requires. */
	nextTheme: Theme
	/** Why scheduling is blocked by the light/dark sequence, or null. */
	themeBlock: string | null
	onSelect: (file: string) => void
	onEdit: (patch: Partial<Pick<Batch, 'start' | 'note'>>) => void
	onRemove: () => void
	onRun: (mode: 'dry' | 'draft' | 'live') => void
}

export function BatchCard(props: Props) {
	const { batch, settings, isNext, run } = props
	const locked = batch.status !== 'draft' || run?.running === true
	const { setNodeRef, isOver } = useDroppable({ id: `batch:${batch.id}`, data: { kind: 'batch', batchId: batch.id }, disabled: locked })
	const emptySlots = Math.max(0, settings.batchSize - batch.items.length)
	const outOfSequence = batch.imported ? 0 : batch.items.filter((item) => props.expected.get(item.file) !== themeOf(item.file)).length

	return (
		<section className="batch" data-next={isNext ? '' : undefined} data-status={batch.status} aria-label={`Batch ${batch.id}`}>
			<header className="batch-head">
				<div className="batch-title">
					{isNext && <Chip tone="accent">Next up</Chip>}
					<h3>
						{formatDate(batch.start)} <span className="arrow">→</span> {formatDate(windowEnd(batch, settings))}
					</h3>
					<Chip tone={batch.status === 'scheduled' ? 'ok' : batch.status === 'partial' ? 'warn' : 'muted'}>{batch.status}</Chip>
					<span className="count">
						{batch.items.length}/{settings.batchSize}
					</span>
					{outOfSequence > 0 && <Chip tone="error">{outOfSequence} out of sequence</Chip>}
				</div>
				{batch.status === 'draft' && (
					<div className="batch-controls">
						<label className="field-inline">
							<span>Starts</span>
							<input type="date" value={batch.start} disabled={locked} onChange={(e) => e.target.value && props.onEdit({ start: e.target.value })} />
						</label>
						{batch.items.length === 0 && (
							<button type="button" className="btn btn-ghost" onClick={props.onRemove}>
								Remove
							</button>
						)}
					</div>
				)}
			</header>
			{batch.note && <p className="batch-note">{batch.note}</p>}

			<SortableContext id={batch.id} items={batch.items.map((item) => `item:${item.file}`)} strategy={verticalListSortingStrategy}>
				<ol className="slots" ref={setNodeRef} data-over={isOver ? '' : undefined}>
					{batch.items.map((item, index) => (
						<SlotItem
							key={item.file}
							item={item}
							index={index}
							batch={batch}
							video={props.videos.get(item.file)}
							handles={props.handles}
							locked={locked}
							selected={props.selected === item.file}
							runState={run?.items[index]}
							run={run}
							expected={batch.imported ? null : (props.expected.get(item.file) ?? null)}
							onSelect={props.onSelect}
						/>
					))}
					{!locked &&
						Array.from({ length: emptySlots }, (_, n) => {
							const index = batch.items.length + n
							const want = n % 2 === 0 ? props.nextTheme : otherTheme(props.nextTheme)
							return (
								<li key={`empty-${index}`} className="slot slot-empty">
									<span className="slot-day">{formatDay(addDays(batch.start, index))}</span>
									<ThemeSwatch theme={want} label />
									<span className="slot-hint">{n === 0 ? `Drop a ${want} video here` : ''}</span>
								</li>
							)
						})}
				</ol>
			</SortableContext>

			{!batch.imported && batch.status !== 'scheduled' && (
				<RunPanel batch={batch} settings={settings} run={run} canRun={props.canRun} themeBlock={props.themeBlock} onRun={props.onRun} />
			)}
		</section>
	)
}

function SlotItem({
	item,
	index,
	batch,
	video,
	handles,
	locked,
	selected,
	runState,
	run,
	expected,
	onSelect,
}: {
	item: BatchItem
	index: number
	batch: Batch
	video: CatalogVideo | undefined
	handles: Handles
	locked: boolean
	selected: boolean
	runState: RunState['items'][number] | undefined
	run: RunState | null
	expected: Theme | null
	onSelect: (file: string) => void
}) {
	const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
		id: `item:${item.file}`,
		data: { kind: 'item', file: item.file, batchId: batch.id, index },
		disabled: locked,
	})
	const { resolved, caption } = viewItem(item, video, item.file, handles)
	const day = batch.imported ? null : addDays(batch.start, index)
	const theme = themeOf(item.file)
	const wrongTheme = expected !== null && expected !== theme

	return (
		<li
			ref={setNodeRef}
			className="slot row"
			style={{ transform: CSS.Translate.toString(transform), transition }}
			data-dragging={isDragging ? '' : undefined}
			data-selected={selected ? '' : undefined}
			data-locked={locked ? '' : undefined}
			data-run={runState?.state}
			data-theme-error={wrongTheme ? '' : undefined}
			// Locked rows can't be dragged but still open the inspector, so skip dnd-kit's aria-disabled.
			{...(locked ? { role: 'button', tabIndex: 0 } : attributes)}
			{...(locked
				? {
						onKeyDown: (event: React.KeyboardEvent) => {
							if (event.key !== 'Enter' && event.key !== ' ') return
							event.preventDefault()
							onSelect(item.file)
						},
					}
				: listeners)}
			onClick={() => onSelect(item.file)}
		>
			<span className="slot-day">{day ? formatDay(day) : `#${index + 1}`}</span>
			<Art src={video?.track?.albumArtUrl} />
			<span className="row-text">
				<span className="row-title">
					{resolved.title}
					{caption.handles.length > 0 && <span className="handles"> {caption.handles.join(' ')}</span>}
				</span>
				<span className="row-sub">
					{resolved.artist || 'Unknown artist'}
					{item.extra && <span className="extra"> · {item.extra}</span>}
				</span>
			</span>
			<span className="row-chips">
				<ThemeSwatch theme={theme} />
				{wrongTheme && <Chip tone="error">needs {expected}</Chip>}
				{!resolved.matched && !item.title && <Chip tone="warn">no match</Chip>}
				{!video && <Chip tone="error">missing file</Chip>}
				{item.error && <Chip tone="error">failed</Chip>}
				{runState && run && <RunBadge state={runState.state} dry={run.mode === 'dry'} />}
				{batch.imported ? <Chip tone="ok">queued</Chip> : <ServiceDots item={item} />}
			</span>
		</li>
	)
}

function RunBadge({ state, dry }: { state: RunState['items'][number]['state']; dry: boolean }) {
	const label = { queued: 'queued', uploading: 'uploading', posting: 'posting', done: dry ? 'valid' : 'done', failed: 'failed', skipped: 'skipped' }[state]
	const tone = state === 'done' ? 'ok' : state === 'failed' ? 'error' : state === 'skipped' ? 'muted' : 'accent'
	return <Chip tone={tone}>{label}</Chip>
}
