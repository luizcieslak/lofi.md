import { useState } from 'react'
import { dueAtFor, windowEnd } from '../../scripts/lib/batches.ts'
import type { Batch, RunEvent, ScheduleSettings, Service } from '../../scripts/lib/types.ts'
import { bufferChannelUrl } from './api.ts'
import { SERVICE_LABEL, formatDate } from './ui.tsx'

export type RunMode = 'dry' | 'draft' | 'live'

export interface RunItemState {
	state: 'queued' | 'uploading' | 'posting' | 'done' | 'failed' | 'skipped'
	title: string
	dueAt: string
	url: string | null
	posts: { service: Service; id: string; channelId: string | null; draft: boolean }[]
	payloads: number
	error: string | null
}

export interface RunState {
	mode: RunMode
	running: boolean
	items: Record<number, RunItemState>
	log: string[]
	done: { ok: boolean; posted: number; failed: number; skipped: number } | null
	error: string | null
}

export function startRun(mode: RunMode): RunState {
	return { mode, running: true, items: {}, log: [], done: null, error: null }
}

function patchItem(state: RunState, index: number, patch: Partial<RunItemState>): RunState {
	const current: RunItemState = state.items[index] ?? {
		state: 'queued',
		title: '',
		dueAt: '',
		url: null,
		posts: [],
		payloads: 0,
		error: null,
	}
	return { ...state, items: { ...state.items, [index]: { ...current, ...patch } } }
}

export function applyEvent(state: RunState, event: RunEvent): RunState {
	switch (event.type) {
		case 'start':
			return state
		case 'item': {
			const header = `${state.log.length > 0 ? '\n' : ''}=== ${event.index + 1}. ${event.title}  @ ${event.dueAt}`
			const next = patchItem(state, event.index, { state: 'queued', title: event.title, dueAt: event.dueAt })
			return { ...next, log: [...next.log, header] }
		}
		case 'upload':
			return patchItem(state, event.index, {
				state: event.state === 'uploading' ? 'uploading' : 'posting',
				url: event.url,
			})
		case 'log':
			return { ...state, log: [...state.log, event.index === null ? event.line : `  ${event.line}`].slice(-400) }
		case 'payload':
			return patchItem(state, event.index, { payloads: (state.items[event.index]?.payloads ?? 0) + 1 })
		case 'post':
			return patchItem(state, event.index, {
				posts: [...(state.items[event.index]?.posts ?? []), { service: event.service, id: event.id, channelId: event.channelId, draft: event.draft }],
			})
		case 'item-done':
			return patchItem(state, event.index, {
				state: event.skipped ? 'skipped' : event.ok ? 'done' : 'failed',
				error: event.error,
			})
		case 'done':
			return { ...state, running: false, done: { ok: event.ok, posted: event.posted, failed: event.failed, skipped: event.skipped } }
		case 'error':
			return { ...state, running: false, error: event.message }
	}
}

interface Props {
	batch: Batch
	settings: ScheduleSettings
	run: RunState | null
	/** Why a run can't start right now, or null when it can. */
	canRun: string | null
	/** Set when light/dark doesn't alternate: drafts and scheduling stay off, a dry run still works. */
	themeBlock: string | null
	onRun: (mode: RunMode) => void
}

export function RunPanel({ batch, settings, run, canRun, themeBlock, onRun }: Props) {
	const [confirming, setConfirming] = useState(false)
	const count = batch.items.length
	const disabled = canRun !== null || count === 0 || run?.running === true
	const first = count > 0 ? dueAtFor(batch, 0, settings) : null
	const pastDue = first !== null && Date.parse(first) < Date.now() + 10 * 60 * 1000
	const results = Object.entries(run?.items ?? {})

	return (
		<div className="run">
			<div className="run-actions">
				<button type="button" className="btn" disabled={disabled} onClick={() => onRun('dry')}>
					Dry run
				</button>
				<button type="button" className="btn" disabled={disabled || themeBlock !== null} onClick={() => onRun('draft')}>
					Save as drafts
				</button>
				<button type="button" className="btn btn-primary" disabled={disabled || pastDue || themeBlock !== null} onClick={() => setConfirming(true)}>
					Schedule {count} post{count === 1 ? '' : 's'}
				</button>
				{themeBlock ? (
					<span className="run-hint error">{themeBlock}</span>
				) : canRun ? (
					<span className="run-hint">{canRun}</span>
				) : (
					pastDue && <span className="run-hint warn">Day 1 is in the past. Move the start date.</span>
				)}
			</div>

			{confirming && !themeBlock && (
				<div className="confirm" role="alertdialog" aria-label="Confirm scheduling">
					<p>
						Upload {count} video{count === 1 ? '' : 's'} to R2 and schedule them on YouTube, TikTok and Instagram: one a day,{' '}
						{formatDate(batch.start)} → {formatDate(windowEnd(batch, settings))}, at {settings.postTime} {settings.timeZone}.
					</p>
					<p className="confirm-note">Buffer posts can't be deduplicated. Anything already scheduled is skipped.</p>
					<div className="confirm-actions">
						<button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
							Cancel
						</button>
						<button
							type="button"
							className="btn btn-primary"
							autoFocus
							onClick={() => {
								setConfirming(false)
								onRun('live')
							}}
						>
							Schedule
						</button>
					</div>
				</div>
			)}

			{run && (
				<div className="run-result" data-running={run.running ? '' : undefined}>
					<p className="run-status">
						{run.running && <span className="spinner" aria-hidden="true" />}
						{run.running
							? `${run.mode === 'dry' ? 'Validating' : run.mode === 'draft' ? 'Saving drafts' : 'Scheduling'}…`
							: run.error
								? `Stopped: ${run.error}`
								: run.done
									? `${run.done.posted} ${run.mode === 'dry' ? 'validated' : run.mode === 'draft' ? 'drafted' : 'scheduled'}, ${run.done.failed} failed, ${run.done.skipped} skipped`
									: 'Finished'}
					</p>
					{results.length > 0 && (
						<ul className="run-items">
							{results.map(([index, item]) => (
								<li key={index} data-state={item.state}>
									<span className="run-item-title">
										{Number(index) + 1}. {item.title}
									</span>
									<span className="run-item-links">
										{item.url && run.mode !== 'dry' && (
											<a href={item.url} target="_blank" rel="noreferrer">
												video
											</a>
										)}
										{item.posts.map((post) =>
											post.channelId ? (
												<a key={post.service} href={bufferChannelUrl(post.channelId)} target="_blank" rel="noreferrer" title={`post ${post.id}`}>
													{SERVICE_LABEL[post.service]}
													{post.draft ? ' draft' : ''}
												</a>
											) : (
												<span key={post.service} title={`post ${post.id}`}>
													{SERVICE_LABEL[post.service]}
												</span>
											),
										)}
										{run.mode === 'dry' && item.payloads > 0 && <span>{item.payloads} payloads ok</span>}
									</span>
									{item.error && <pre className="run-error">{item.error}</pre>}
								</li>
							))}
						</ul>
					)}
					<details className="log">
						<summary>CLI output ({run.log.length} lines)</summary>
						<pre>{run.log.join('\n')}</pre>
					</details>
				</div>
			)}
		</div>
	)
}
