import { useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { addDays, dueAtFor, windowEnd } from '../../scripts/lib/batches.ts'
import type { CatalogVideo } from '../../scripts/lib/catalog.ts'
import type { Batch, BatchItem, Handles, ScheduleSettings } from '../../scripts/lib/types.ts'
import { RunPanel } from './RunPanel.tsx'
import type { RunState } from './RunPanel.tsx'
import { Art, Chip, ServiceDots, formatDate, formatDay, viewItem } from './ui.tsx'

interface Props {
	batch: Batch
	settings: ScheduleSettings
	videos: Map<string, CatalogVideo>
	handles: Handles
	isNext: boolean
	selected: string | null
	run: RunState | null
	canRun: string | null
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
							settings={settings}
							video={props.videos.get(item.file)}
							handles={props.handles}
							locked={locked}
							selected={props.selected === item.file}
							runState={run?.items[index]}
							run={run}
							onSelect={props.onSelect}
						/>
					))}
					{!locked &&
						Array.from({ length: emptySlots }, (_, n) => {
							const index = batch.items.length + n
							return (
								<li key={`empty-${index}`} className="slot slot-empty">
									<span className="slot-day">{formatDay(addDays(batch.start, index))}</span>
									<span className="slot-hint">{n === 0 ? 'Drop a video here' : ''}</span>
								</li>
							)
						})}
				</ol>
			</SortableContext>

			{!batch.imported && batch.status !== 'scheduled' && (
				<RunPanel batch={batch} settings={settings} run={run} canRun={props.canRun} onRun={props.onRun} />
			)}
		</section>
	)
}

function SlotItem({
	item,
	index,
	batch,
	settings,
	video,
	handles,
	locked,
	selected,
	runState,
	run,
	onSelect,
}: {
	item: BatchItem
	index: number
	batch: Batch
	settings: ScheduleSettings
	video: CatalogVideo | undefined
	handles: Handles
	locked: boolean
	selected: boolean
	runState: RunState['items'][number] | undefined
	run: RunState | null
	onSelect: (file: string) => void
}) {
	const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
		id: `item:${item.file}`,
		data: { kind: 'item', file: item.file, batchId: batch.id, index },
		disabled: locked,
	})
	const { resolved, caption } = viewItem(item, video, item.file, handles)
	const day = batch.imported ? null : dueAtFor(batch, index, settings)

	return (
		<li
			ref={setNodeRef}
			className="slot row"
			style={{ transform: CSS.Translate.toString(transform), transition }}
			data-dragging={isDragging ? '' : undefined}
			data-selected={selected ? '' : undefined}
			data-locked={locked ? '' : undefined}
			data-run={runState?.state}
			{...attributes}
			{...listeners}
			onClick={() => onSelect(item.file)}
		>
			<span className="slot-day">{day ? formatDay(day.slice(0, 10)) : `#${index + 1}`}</span>
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
