import type { Catalog } from '../../scripts/lib/catalog.ts'
import type { Handles, RunEvent, Schedule, Service, Track } from '../../scripts/lib/types.ts'

export interface Config {
	recordingsDir: string
	bufferProfile: 'repo' | 'env' | 'global'
	channels: Record<Service, string | null>
	running: boolean
}

export interface Loaded<T> {
	data: T
	mtime: number
}

export class ApiError extends Error {
	status: number
	constructor(status: number, message: string) {
		super(message)
		this.status = status
	}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`/__posts${path}`, {
		...init,
		headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
	})
	const body = await response.json()
	if (!response.ok) throw new ApiError(response.status, body?.error ?? `${response.status} ${response.statusText}`)
	return body
}

export const api = {
	config: () => request<Config>('/config'),
	videos: () => request<Catalog>('/videos'),
	tracks: () => request<{ tracks: Track[] }>('/tracks').then((body) => body.tracks),
	schedule: () =>
		request<{ schedule: Schedule; mtime: number }>('/schedule').then((b): Loaded<Schedule> => ({ data: b.schedule, mtime: b.mtime })),
	saveSchedule: (schedule: Schedule, mtime: number) =>
		request<{ schedule: Schedule; mtime: number }>('/schedule', {
			method: 'PUT',
			body: JSON.stringify({ schedule, mtime }),
		}).then((b): Loaded<Schedule> => ({ data: b.schedule, mtime: b.mtime })),
	handles: () =>
		request<{ handles: Handles; mtime: number }>('/handles').then((b): Loaded<Handles> => ({ data: b.handles, mtime: b.mtime })),
	saveHandles: (handles: Handles, mtime: number) =>
		request<{ handles: Handles; mtime: number }>('/handles', {
			method: 'PUT',
			body: JSON.stringify({ handles, mtime }),
		}).then((b): Loaded<Handles> => ({ data: b.handles, mtime: b.mtime })),
	preview: (batchId: string, index: number) =>
		request<{ payloads: { service: Service; payload: unknown }[]; log: string[] }>('/preview', {
			method: 'POST',
			body: JSON.stringify({ batchId, index }),
		}),
}

export interface RunRequest {
	batchId: string
	dryRun: boolean
	draft: boolean
	only: Service[]
}

/** POST /run and hand each NDJSON event to onEvent as it arrives. */
export async function streamRun(run: RunRequest, onEvent: (event: RunEvent) => void): Promise<void> {
	const response = await fetch('/__posts/run', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(run),
	})
	if (!response.ok || !response.body) {
		const body = await response.json().catch(() => null)
		throw new ApiError(response.status, body?.error ?? `${response.status} ${response.statusText}`)
	}
	const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
	let pending = ''
	for (;;) {
		const { value, done } = await reader.read()
		if (done) break
		pending += value
		const lines = pending.split('\n')
		pending = lines.pop() ?? ''
		for (const line of lines) if (line.trim()) onEvent(JSON.parse(line))
	}
	if (pending.trim()) onEvent(JSON.parse(pending))
}

export function previewUrl(recordingsDir: string, file: string): string {
	return `/@fs${recordingsDir}/${file.split('/').map(encodeURIComponent).join('/')}`
}

/** The channel's page in Buffer's publishing app. */
export function bufferChannelUrl(channelId: string): string {
	return `https://publish.buffer.com/channels/${channelId}`
}
