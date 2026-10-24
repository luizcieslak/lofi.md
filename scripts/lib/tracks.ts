import { RADIO_API_URL } from './env.ts'
import type { Track, TrackMatch } from './types.ts'

/**
 * Same slugify as lofi-radio/src/recordingPaths.ts, which names every render after
 * its track file. NFKD + stripping marks turns "Café" into "cafe", not "caf".
 */
export function slugify(input: string): string {
	return (
		input
			.normalize('NFKD')
			.replace(/\p{M}/gu, '')
			.replace(/\.mp3$/i, '')
			.replace(/[^a-zA-Z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.toLowerCase() || 'track'
	)
}

const CACHE_MS = 5 * 60 * 1000
let cache: { at: number; tracks: Track[] } | null = null

export async function fetchTracks(force = false): Promise<Track[]> {
	if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.tracks
	const response = await fetch(`${RADIO_API_URL}/api/tracks`)
	if (!response.ok) throw new Error(`${RADIO_API_URL}/api/tracks returned ${response.status}`)
	const body: { tracks: Track[] } = await response.json()
	cache = { at: Date.now(), tracks: body.tracks }
	return body.tracks
}

export interface TrackIndex {
	match(slug: string): TrackMatch | null
}

/**
 * A render's slug is the track's file name ("the-deli-sunflowers" from
 * "The Deli - Sunflowers向日葵.mp3"); older renders used the title or artist + title.
 * Try them in that order of confidence.
 */
export function indexTracks(tracks: Track[]): TrackIndex {
	const byFile = new Map<string, Track>()
	const byArtistTitle = new Map<string, Track>()
	const byTitle = new Map<string, Track>()
	const put = (map: Map<string, Track>, key: string, track: Track) => {
		if (key && !map.has(key)) map.set(key, track)
	}
	for (const track of tracks) {
		const fileName = (track.path ?? '').split('/').pop() ?? ''
		if (fileName) put(byFile, slugify(fileName.replace(/\.[^.]+$/, '')), track)
		put(byArtistTitle, slugify(`${track.artist} ${track.title}`), track)
		put(byTitle, slugify(track.title), track)
	}
	return {
		match(slug) {
			const track = byFile.get(slug) ?? byArtistTitle.get(slug) ?? byTitle.get(slug)
			if (!track) return null
			return {
				id: track.id,
				title: track.title,
				artist: track.artist,
				album: track.album ?? null,
				albumArtUrl: track.albumArtUrl ?? null,
			}
		},
	}
}
