import { useEffect, useState } from 'react'
import { normalizeHandle, splitArtistNames } from '../../scripts/lib/caption.ts'
import type { CatalogVideo } from '../../scripts/lib/catalog.ts'
import type { Handles as HandleMap, Schedule, Track } from '../../scripts/lib/types.ts'
import { Chip, viewItem } from './ui.tsx'

interface Props {
	handles: HandleMap
	tracks: Track[]
	schedule: Schedule
	videos: Map<string, CatalogVideo>
	onChange: (artist: string, handles: string[]) => void
}

interface ArtistRow {
	key: string
	name: string
	tracks: number
	upcoming: boolean
}

export function Handles({ handles, tracks, schedule, videos, onChange }: Props) {
	const [query, setQuery] = useState('')
	const [missingOnly, setMissingOnly] = useState(false)

	const rows = new Map<string, ArtistRow>()
	const touch = (name: string) => {
		const key = name.toLowerCase()
		const row = rows.get(key) ?? { key, name, tracks: 0, upcoming: false }
		rows.set(key, row)
		return row
	}
	for (const track of tracks) for (const name of splitArtistNames(track.artist)) touch(name).tracks++
	for (const key of Object.keys(handles)) touch(key)
	for (const batch of schedule.batches) {
		if (batch.status === 'scheduled') continue
		for (const item of batch.items) {
			const { resolved } = viewItem(item, videos.get(item.file), item.file, handles)
			for (const name of splitArtistNames(resolved.artist)) touch(name).upcoming = true
		}
	}

	const needle = query.trim().toLowerCase()
	const list = [...rows.values()]
		.filter((row) => !needle || row.key.includes(needle) || (handles[row.key] ?? []).some((h) => h.toLowerCase().includes(needle)))
		.filter((row) => !missingOnly || !handles[row.key]?.length)
		// Upcoming artists without a handle first: those are the captions that need fixing.
		.sort((a, b) => rank(b, handles) - rank(a, handles) || a.key.localeCompare(b.key))
	const missingUpcoming = [...rows.values()].filter((row) => row.upcoming && !handles[row.key]?.length).length

	return (
		<section className="handles-pane" aria-label="Instagram handles">
			<header className="pane-head">
				<h2>Instagram handles</h2>
				<span className="muted">
					{Object.keys(handles).length} of {rows.size} artists
					{missingUpcoming > 0 && ` · ${missingUpcoming} in upcoming batches without one`}
				</span>
			</header>
			<div className="handles-tools">
				<input className="search" type="search" placeholder="Search or add an artist" value={query} onChange={(e) => setQuery(e.target.value)} />
				<label className="toggle">
					<input type="checkbox" checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} />
					Missing only
				</label>
			</div>
			<table className="handles-table">
				<thead>
					<tr>
						<th scope="col">Artist</th>
						<th scope="col">Handles</th>
						<th scope="col" className="num">
							Tracks
						</th>
					</tr>
				</thead>
				<tbody>
					{list.map((row) => (
						<tr key={row.key} data-missing={row.upcoming && !handles[row.key]?.length ? '' : undefined}>
							<td>
								{row.name}
								{row.upcoming && (
									<>
										{' '}
										<Chip tone={handles[row.key]?.length ? 'muted' : 'warn'}>upcoming</Chip>
									</>
								)}
							</td>
							<td>
								<HandleInput value={handles[row.key] ?? []} onCommit={(next) => onChange(row.key, next)} />
							</td>
							<td className="num">{row.tracks || ''}</td>
						</tr>
					))}
					{list.length === 0 && needle && (
						<tr>
							<td>{query.trim()}</td>
							<td>
								<HandleInput value={[]} onCommit={(next) => onChange(needle, next)} />
							</td>
							<td />
						</tr>
					)}
				</tbody>
			</table>
		</section>
	)
}

function rank(row: ArtistRow, handles: HandleMap): number {
	const has = (handles[row.key]?.length ?? 0) > 0
	return (row.upcoming && !has ? 2 : 0) + (row.upcoming ? 1 : 0)
}

/** Free text while typing; parsed into handles on blur or Enter. */
function HandleInput({ value, onCommit }: { value: string[]; onCommit: (handles: string[]) => void }) {
	const joined = value.join(' ')
	const [text, setText] = useState(joined)
	useEffect(() => setText(joined), [joined])

	const commit = () => {
		const next = text
			.split(/[\s,]+/)
			.filter(Boolean)
			.map(normalizeHandle)
		if (next.join(' ') !== joined) onCommit(next)
		else setText(joined)
	}
	return (
		<input
			className="handle-input"
			value={text}
			placeholder="@handle"
			spellCheck={false}
			onChange={(e) => setText(e.target.value)}
			onBlur={commit}
			onKeyDown={(e) => {
				if (e.key === 'Enter') e.currentTarget.blur()
				if (e.key === 'Escape') {
					setText(joined)
					e.currentTarget.blur()
				}
			}}
		/>
	)
}
