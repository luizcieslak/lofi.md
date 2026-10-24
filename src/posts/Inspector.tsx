import { useEffect, useState } from 'react'
import type { CatalogVideo } from '../../scripts/lib/catalog.ts'
import { SERVICES } from '../../scripts/lib/types.ts'
import type { Batch, BatchItem, Handles, Service } from '../../scripts/lib/types.ts'
import { api, bufferChannelUrl, previewUrl } from './api.ts'
import { themeOf } from '../../scripts/lib/theme.ts'
import { Chip, SERVICE_LABEL, ThemeSwatch, viewItem } from './ui.tsx'

interface Props {
	file: string
	video: CatalogVideo | undefined
	batch: Batch | null
	index: number
	item: BatchItem | null
	handles: Handles
	recordingsDir: string
	dirty: boolean
	onEdit: (patch: Partial<Pick<BatchItem, 'extra' | 'title' | 'artist'>>) => void
	onClose: () => void
}

type Preview = { state: 'idle' } | { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; payloads: { service: Service; payload: unknown }[] }

export function Inspector({ file, video, batch, index, item, handles, recordingsDir, dirty, onEdit, onClose }: Props) {
	const [preview, setPreview] = useState<Preview>({ state: 'idle' })
	const editable = batch?.status === 'draft'
	const draft = item ?? { title: null, artist: null, extra: '' }
	const { resolved, caption } = viewItem(draft, video, file, handles)

	// A different item, or an edit, makes an old payload preview a lie.
	useEffect(() => setPreview({ state: 'idle' }), [file, item?.extra, item?.title, item?.artist])

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') onClose()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [onClose])

	const loadPreview = () => {
		if (!batch) return
		setPreview({ state: 'loading' })
		api
			.preview(batch.id, index)
			.then((body) => setPreview({ state: 'ready', payloads: body.payloads }))
			.catch((error: unknown) => setPreview({ state: 'error', message: error instanceof Error ? error.message : String(error) }))
	}

	return (
		<aside className="inspector" aria-label="Post details">
			<header className="pane-head">
				<h2>{resolved.title}</h2>
				<button type="button" className="btn btn-ghost btn-icon" aria-label="Close" onClick={onClose}>
					×
				</button>
			</header>

			<div className="inspector-body">
				<video key={file} className="player" src={previewUrl(recordingsDir, file)} controls muted playsInline preload="metadata" />

				<dl className="facts">
					<dt>File</dt>
					<dd className="mono">{file}</dd>
					<dt>Theme</dt>
					<dd>
						<ThemeSwatch theme={themeOf(file)} label />
					</dd>
					{video?.track && (
						<>
							<dt>Radio</dt>
							<dd>
								{video.track.title} — {video.track.artist}
								{video.track.album && <span className="muted"> · {video.track.album}</span>}
							</dd>
						</>
					)}
					{!video?.track && (
						<>
							<dt>Radio</dt>
							<dd>
								<Chip tone="warn">no match</Chip> Set the title and artist below.
							</dd>
						</>
					)}
					{batch && !batch.imported && (
						<>
							<dt>Posts</dt>
							<dd>Day {index + 1} · next Buffer queue slot per channel</dd>
						</>
					)}
					{item?.url && (
						<>
							<dt>R2</dt>
							<dd className="mono">
								<a href={item.url} target="_blank" rel="noreferrer">
									{item.r2Key}
								</a>
							</dd>
						</>
					)}
				</dl>

				{!item && <p className="pane-note">Drag this video into a batch to schedule it.</p>}

				{item && (
					<>
						<div className="fields">
							<label className="field">
								<span>Title</span>
								<input
									value={item.title ?? ''}
									placeholder={video?.track?.title ?? resolved.title}
									disabled={!editable}
									onChange={(e) => onEdit({ title: e.target.value || null })}
								/>
							</label>
							<label className="field">
								<span>Artist</span>
								<input
									value={item.artist ?? ''}
									placeholder={video?.track?.artist ?? 'Artist'}
									disabled={!editable}
									onChange={(e) => onEdit({ artist: e.target.value || null })}
								/>
							</label>
							<label className="field">
								<span>Custom text</span>
								<textarea
									rows={3}
									value={item.extra}
									placeholder="Goes three lines under the credit. Trailing #hashtags merge into the tag block."
									disabled={!editable}
									onChange={(e) => onEdit({ extra: e.target.value })}
								/>
							</label>
						</div>

						<section className="caption">
							<h3>Caption</h3>
							<pre className="caption-text">{caption.description.replaceAll('<br>', '\n')}</pre>
							{resolved.artist && caption.handles.length === 0 && (
								<p className="pane-note warn">No Instagram handle for {resolved.artist}. Add one in Handles.</p>
							)}
							<p className="pane-note">post-video.sh adds the hashtags per network (5 on Instagram).</p>
							<button type="button" className="btn" disabled={dirty || !batch || preview.state === 'loading'} onClick={loadPreview}>
								{preview.state === 'loading' ? 'Building…' : 'Preview payloads'}
							</button>
							{dirty && <span className="run-hint">Save first</span>}
							{preview.state === 'error' && <pre className="run-error">{preview.message}</pre>}
							{preview.state === 'ready' &&
								preview.payloads.map(({ service, payload }) => (
									<details key={service} className="payload">
										<summary>{SERVICE_LABEL[service]}</summary>
										<pre>{JSON.stringify(payload, null, 2)}</pre>
									</details>
								))}
						</section>

						{SERVICES.some((s) => item.posts[s]) && (
							<section className="posted">
								<h3>In Buffer</h3>
								<ul>
									{SERVICES.map((service) => {
										const post = item.posts[service]
										if (!post) return null
										return (
											<li key={service}>
												{post.channelId ? (
													<a href={bufferChannelUrl(post.channelId)} target="_blank" rel="noreferrer">
														{SERVICE_LABEL[service]}
													</a>
												) : (
													SERVICE_LABEL[service]
												)}{' '}
												<span className="muted">
													{post.status} · {post.dueAt?.replace('T', ' ').slice(0, 16) ?? 'queued'} · {post.id}
												</span>
											</li>
										)
									})}
								</ul>
							</section>
						)}
						{item.error && <pre className="run-error">{item.error}</pre>}
					</>
				)}
			</div>
		</aside>
	)
}
