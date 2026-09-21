import './style.css'
import { createRadioPlayer } from './radio-player'

const RADIO_API = import.meta.env.VITE_RADIO_API_URL

if (!RADIO_API) {
	throw new Error('VITE_RADIO_API_URL is not set — copy .env.example to .env')
}

const audio = document.getElementById('audio') as HTMLAudioElement
const meta = document.getElementById('meta') as HTMLDivElement
const cover = document.getElementById('cover') as HTMLImageElement
const titleEl = document.getElementById('title') as HTMLParagraphElement
const artistEl = document.getElementById('artist') as HTMLParagraphElement
const toggle = document.getElementById('toggle') as HTMLButtonElement
const iconPlay = document.getElementById('icon-play') as unknown as SVGElement
const iconPause = document.getElementById('icon-pause') as unknown as SVGElement

const player = createRadioPlayer(audio, RADIO_API)

toggle.addEventListener('click', () => player.toggle())

// Double-click anywhere on the art toggles playback. Once the stream is running
// this is the primary control — the button is only a fallback for the
// autoplay-blocked case.
document.getElementById('stage')!.addEventListener('dblclick', event => {
	if (event.target === toggle || toggle.contains(event.target as Node)) return
	player.toggle()
})

// Space toggles playback, as long as focus isn't already on the button
// (where the browser fires a click of its own).
document.addEventListener('keydown', event => {
	if (event.code !== 'Space' || event.target === toggle) return
	event.preventDefault()
	player.toggle()
})

// Tuning panel for the #meta wall tilt.
//
// Always available in dev. In a production build it ships only when built with
// VITE_ENABLE_TUNER=true, and even then it stays hidden until you ask for it
// with ?tuner — so a tuner-enabled deploy looks normal to everyone else.
//
// Vite inlines import.meta.env.* at build time, so when the flag is off this
// whole branch is statically false and the dynamic import is tree-shaken: the
// panel's code never enters the bundle. Env vars are strings, so compare
// explicitly — 'false' would otherwise be truthy.
const tunerBuilt = import.meta.env.DEV || import.meta.env.VITE_ENABLE_TUNER === 'true'
const tunerRequested =
	import.meta.env.DEV || new URLSearchParams(location.search).has('tuner')

if (tunerBuilt && tunerRequested) {
	void import('./meta-tuner').then(({ mountMetaTuner }) => mountMetaTuner(meta))
}

// The footer lives below the fold; fade it in once scrolling brings it into view.
const footer = document.getElementById('footer') as HTMLElement
new IntersectionObserver(
	entries => {
		for (const entry of entries) {
			footer.dataset.visible = entry.isIntersecting ? 'true' : 'false'
		}
	},
	{ threshold: 0.25 },
).observe(footer)

// Browsers refuse unmuted autoplay without a gesture. Try anyway; if we're
// blocked, reveal the play button so there's something to click.
void player.tryAutoplay().then(started => {
	if (!started) document.body.dataset.needsGesture = 'true'
})

let currentCover = ''

// The fullscreen backdrop is the fixed banner art (set in CSS); per-track art
// only ever fills the small thumbnail beside the title.
function setCover(url: string) {
	if (url === currentCover) return
	currentCover = url
	cover.src = url
}

player.subscribe(state => {
	const track = state.track

	titleEl.textContent = track?.title || ''
	artistEl.textContent = track?.artist || ''

	const art = track?.albumArtUrl || track?.coverUrl || ''
	if (art) setCover(art)

	cover.alt = track?.title ? `${track.title} cover art` : ''
	meta.dataset.loaded = track?.title ? 'true' : 'false'

	document.title = track?.title
		? track.artist
			? `${track.title} — ${track.artist}`
			: track.title
		: 'lofi.md'

	toggle.setAttribute('aria-label', state.wantPlaying ? 'Pause' : 'Play')
	iconPlay.toggleAttribute('hidden', state.wantPlaying)
	iconPause.toggleAttribute('hidden', !state.wantPlaying)

	// While playing, the art stands alone — double-click is the control. When
	// stopped, offer the button again so there's always an obvious way back in.
	document.body.dataset.playing = state.wantPlaying ? 'true' : 'false'
})
