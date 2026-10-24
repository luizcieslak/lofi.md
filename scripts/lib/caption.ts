// Pure caption logic, also imported by the posts UI for its live preview.

import type { BatchItem, Handles, TrackMatch } from './types.ts'

/** Three line breaks between the credit line and the extra text. */
export const EXTRA_SEPARATOR = '<br><br><br>'

/**
 * "Flitz&Suppe, bert cussion" → ["Flitz&Suppe", "bert cussion"], so each artist
 * keeps its own handles. The radio separates artists with commas (or feat./ft.);
 * "&" and " x " stay inside names like 7&Nine and Saito & Lester.
 */
export function splitArtistNames(artist: string): string[] {
	return artist
		.split(/\s*(?:,|\s+(?:feat|ft)\.?\s+)\s*/i)
		.map((name) => name.trim())
		.filter(Boolean)
}

export function normalizeHandle(handle: string): string {
	const trimmed = handle.trim()
	return trimmed.startsWith('@') ? trimmed : `@${trimmed}`
}

/** Handles for every artist in a credit, deduped, in credit order. */
export function handlesFor(artist: string, handles: Handles): string[] {
	const out: string[] = []
	for (const name of splitArtistNames(artist)) {
		for (const handle of handles[name.toLowerCase()] ?? []) {
			const tag = normalizeHandle(handle)
			if (!out.includes(tag)) out.push(tag)
		}
	}
	return out
}

export interface ResolvedItem {
	title: string
	artist: string
	matched: boolean
}

/** Overrides beat the radio API, which beats the file name. */
export function resolveItem(item: Pick<BatchItem, 'title' | 'artist'>, slug: string, track: TrackMatch | null): ResolvedItem {
	return {
		title: item.title?.trim() || track?.title || slug.replace(/-/g, ' '),
		artist: item.artist?.trim() || track?.artist || '',
		matched: track !== null,
	}
}

export interface Caption {
	/** "{title} by {artist}": the YouTube title. */
	credit: string
	/** What post-video.sh gets as --description; it adds the hashtags per network. */
	description: string
	handles: string[]
}

export function buildCaption(resolved: ResolvedItem, extra: string, handles: Handles): Caption {
	const credit = resolved.artist ? `${resolved.title} by ${resolved.artist}` : resolved.title
	const tags = handlesFor(resolved.artist, handles)
	const body = [credit, ...tags].join(' ')
	const extraText = extra.trim()
	return {
		credit,
		description: extraText ? `${body}${EXTRA_SEPARATOR}${extraText}` : body,
		handles: tags,
	}
}
