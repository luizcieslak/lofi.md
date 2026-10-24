import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { RECORDINGS_DIR, today } from './env.ts'
import { themeOf } from './theme.ts'
import type { Video, VideoGroup } from './types.ts'

const VIDEO_EXT = /\.(mp4|mov|webm)$/i
// Archived renders live in backup/YYYY-MM-DD or backup/YYYY-MM-DDTHH-MM-SS.
const FOLDER_DATE = /^(\d{4}-\d{2}-\d{2})(T\d{2}-\d{2}-\d{2})?$/
// Renders are named <track-slug>-<scene-uuid>[-<light|dark|default>]-<width>x<height>.mp4.
const RENDER_SUFFIX = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-(light|dark|default))?(-\d+x\d+)?$/

export function slugOf(file: string): string {
	return basename(file)
		.replace(/\.[^.]+$/, '')
		.replace(RENDER_SUFFIX, '')
}

function readVideos(dir: string, prefix: string): Video[] {
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && VIDEO_EXT.test(entry.name))
		.map((entry) => {
			const stat = statSync(join(dir, entry.name))
			return {
				file: prefix ? `${prefix}/${entry.name}` : entry.name,
				name: entry.name,
				slug: slugOf(entry.name),
				theme: themeOf(entry.name),
				size: stat.size,
				mtimeMs: stat.mtimeMs,
			}
		})
		.sort((a, b) => a.name.localeCompare(b.name))
}

/** The recordings root plus every dated backup folder, newest first. */
export function listVideoGroups(dir = RECORDINGS_DIR): VideoGroup[] {
	if (!existsSync(dir)) throw new Error(`recordings dir not found: ${dir} (set RECORDINGS_DIR in .env)`)
	const groups: VideoGroup[] = []

	const rootVideos = readVideos(dir, '')
	if (rootVideos.length > 0) groups.push({ id: '', label: 'Unsorted', date: today(), videos: rootVideos })

	const backup = join(dir, 'backup')
	if (existsSync(backup)) {
		const folders = readdirSync(backup, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && FOLDER_DATE.test(entry.name))
			.map((entry) => entry.name)
			// Timestamps sort lexically in time order.
			.sort()
			.reverse()
		for (const folder of folders) {
			const videos = readVideos(join(backup, folder), `backup/${folder}`)
			if (videos.length === 0) continue
			groups.push({ id: `backup/${folder}`, label: folder, date: folder.slice(0, 10), videos })
		}
	}
	return groups
}

/** The newest group dated today or earlier, so a future-dated folder isn't picked by accident. */
export function defaultGroup<G extends Pick<VideoGroup, 'date'>>(groups: G[], on = today()): G | null {
	return groups.find((group) => group.date <= on) ?? groups[0] ?? null
}

/** Accepts a group id ("backup/2026-10-01"), a bare folder name ("2026-10-01") or "root". */
export function findGroup<G extends Pick<VideoGroup, 'id' | 'label'>>(groups: G[], name: string): G | null {
	const wanted = name.replace(/\/+$/, '')
	if (wanted === 'root' || wanted === '.' || wanted === '') return groups.find((g) => g.id === '') ?? null
	return groups.find((g) => g.id === wanted || g.label === wanted || g.id === `backup/${wanted}`) ?? null
}

export function absolutePath(file: string, dir = RECORDINGS_DIR): string {
	return join(dir, file)
}
