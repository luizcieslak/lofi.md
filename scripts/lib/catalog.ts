import { usedFiles } from './batches.ts'
import { defaultGroup, listVideoGroups } from './recordings.ts'
import { fetchTracks, indexTracks } from './tracks.ts'
import type { Schedule, TrackMatch, Video, VideoGroup } from './types.ts'

export interface CatalogVideo extends Video {
	track: TrackMatch | null
	/** The batch this video is already in, if any. */
	batchId: string | null
}

export interface CatalogGroup extends Omit<VideoGroup, 'videos'> {
	videos: CatalogVideo[]
}

export interface Catalog {
	groups: CatalogGroup[]
	defaultGroupId: string | null
	tracksError: string | null
}

/** Local renders matched to radio tracks and to the batches they're already in. */
export async function buildCatalog(schedule: Schedule): Promise<Catalog> {
	const groups = listVideoGroups()
	let tracksError: string | null = null
	let index = indexTracks([])
	try {
		index = indexTracks(await fetchTracks())
	} catch (error) {
		tracksError = error instanceof Error ? error.message : String(error)
	}
	const used = usedFiles(schedule)
	return {
		groups: groups.map((group) => ({
			...group,
			videos: group.videos.map((video) => ({
				...video,
				track: index.match(video.slug),
				batchId: used.get(video.file) ?? null,
			})),
		})),
		defaultGroupId: defaultGroup(groups)?.id ?? null,
		tracksError,
	}
}

export function findVideo(catalog: Catalog, file: string): CatalogVideo | null {
	for (const group of catalog.groups) {
		const video = group.videos.find((v) => v.file === file)
		if (video) return video
	}
	return null
}
