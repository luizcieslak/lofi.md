import { useDraggable, useDroppable } from '@dnd-kit/core'
import { useState } from 'react'
import type { Catalog, CatalogVideo } from '../../scripts/lib/catalog.ts'
import type { Schedule } from '../../scripts/lib/types.ts'
import { Art, Chip, ThemeSwatch, formatDate } from './ui.tsx'

interface Props {
	catalog: Catalog
	schedule: Schedule
	onSelect: (file: string) => void
	selected: string | null
}

export function Library({ catalog, schedule, onSelect, selected }: Props) {
	const [hideUsed, setHideUsed] = useState(true)
	const [query, setQuery] = useState('')
	const [open, setOpen] = useState<Set<string>>(() => new Set(catalog.defaultGroupId === null ? [] : [catalog.defaultGroupId]))
	// Dropping a batch item here takes it out of its batch.
	const { setNodeRef, isOver } = useDroppable({ id: 'library', data: { kind: 'library' } })

	const batchOf = new Map<string, string>()
	for (const batch of schedule.batches) for (const item of batch.items) batchOf.set(item.file, batch.id)
	const needle = query.trim().toLowerCase()
	const matches = (video: CatalogVideo) =>
		!needle ||
		video.file.toLowerCase().includes(needle) ||
		`${video.track?.title ?? ''} ${video.track?.artist ?? ''}`.toLowerCase().includes(needle)

	const toggle = (id: string) =>
		setOpen((current) => {
			const next = new Set(current)
			if (next.has(id)) next.delete(id)
			else next.add(id)
			return next
		})

	return (
		<aside className="library" ref={setNodeRef} data-over={isOver ? '' : undefined} aria-label="Videos">
			<header className="pane-head">
				<h2>Videos</h2>
				<label className="toggle">
					<input type="checkbox" checked={hideUsed} onChange={(e) => setHideUsed(e.target.checked)} />
					Hide used
				</label>
			</header>
			<input className="search" type="search" placeholder="Search title, artist, file" value={query} onChange={(e) => setQuery(e.target.value)} />
			{catalog.tracksError && <p className="pane-note warn">Radio API unavailable: {catalog.tracksError}</p>}
			<div className="groups">
				{catalog.groups.map((group) => {
					const videos = group.videos.filter((v) => matches(v) && !(hideUsed && batchOf.has(v.file)))
					const unused = group.videos.filter((v) => !batchOf.has(v.file)).length
					const isOpen = open.has(group.id) || needle !== ''
					return (
						<section key={group.id} className="group">
							<button type="button" className="group-head" aria-expanded={isOpen} onClick={() => toggle(group.id)}>
								<span className="caret" aria-hidden="true" />
								<span className="group-label">{group.label}</span>
								{group.id === catalog.defaultGroupId && <Chip tone="accent">newest</Chip>}
								<span className="group-count">
									{unused}/{group.videos.length} unused
								</span>
							</button>
							{isOpen && (
								<ul className="rows">
									{videos.length === 0 && <li className="empty-row">Everything here is in a batch.</li>}
									{videos.map((video) => (
										<LibraryRow
											key={video.file}
											video={video}
											batchId={batchOf.get(video.file) ?? null}
											locked={isLocked(schedule, batchOf.get(video.file))}
											selected={selected === video.file}
											onSelect={onSelect}
										/>
									))}
								</ul>
							)}
						</section>
					)
				})}
			</div>
		</aside>
	)
}

function isLocked(schedule: Schedule, batchId: string | undefined): boolean {
	if (!batchId) return false
	return schedule.batches.find((b) => b.id === batchId)?.status !== 'draft'
}

function LibraryRow({
	video,
	batchId,
	locked,
	selected,
	onSelect,
}: {
	video: CatalogVideo
	batchId: string | null
	locked: boolean
	selected: boolean
	onSelect: (file: string) => void
}) {
	const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
		id: `lib:${video.file}`,
		data: { file: video.file },
		disabled: locked,
	})
	return (
		<li
			ref={setNodeRef}
			className="row lib-row"
			data-dragging={isDragging ? '' : undefined}
			data-selected={selected ? '' : undefined}
			data-locked={locked ? '' : undefined}
			{...attributes}
			{...listeners}
			onClick={() => onSelect(video.file)}
		>
			<Art src={video.track?.albumArtUrl} />
			<span className="row-text">
				<span className="row-title">{video.track?.title ?? video.slug.replace(/-/g, ' ')}</span>
				<span className="row-sub">{video.track?.artist ?? video.name}</span>
			</span>
			<span className="row-chips">
				<ThemeSwatch theme={video.theme} />
				{!video.track && <Chip tone="warn">no match</Chip>}
				{batchId && <Chip tone={locked ? 'ok' : 'muted'}>{locked ? 'posted' : formatDate(batchId.slice(0, 10))}</Chip>}
			</span>
		</li>
	)
}
