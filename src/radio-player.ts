export type RadioTrack = {
	title?: string
	artist?: string
	album?: string
	albumArtUrl?: string
	coverUrl?: string
}

export type RadioState = {
	wantPlaying: boolean
	playing: boolean
	hasInteracted: boolean
	track: RadioTrack | null
}

export type RadioPlayer = {
	toggle: () => void
	/**
	 * Try to start playback without a user gesture. Resolves `true` if the
	 * browser allowed it, `false` if autoplay was blocked (the common case for
	 * unmuted audio) — callers surface a play control in that case.
	 */
	tryAutoplay: () => Promise<boolean>
	getState: () => RadioState
	subscribe: (listener: (state: RadioState) => void) => () => void
}

type Internal = {
	api: string
	audio: HTMLAudioElement
	listeners: Set<(state: RadioState) => void>
	state: RadioState
	reconnectAttempt: number
	reconnectTimer: ReturnType<typeof setTimeout> | null
	wakeLock: WakeLockSentinel | null
	events: EventSource | null
	heartbeatTimer: ReturnType<typeof setInterval> | null
}

const BASE_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30000
const HEARTBEAT_INTERVAL_MS = 60_000
const METADATA_RESUME_REFRESH_MIN_INTERVAL_MS = 5_000

export function createRadioPlayer(audio: HTMLAudioElement, api: string): RadioPlayer {
	const internal: Internal = {
		api,
		audio,
		listeners: new Set(),
		state: { wantPlaying: false, playing: false, hasInteracted: false, track: null },
		reconnectAttempt: 0,
		reconnectTimer: null,
		wakeLock: null,
		events: null,
		heartbeatTimer: null,
	}

	audio.volume = 0.45
	audio.preload = 'none'

	// Per-page-lifetime id so duplicated tabs cannot fight over one listener slot.
	const sessionId = crypto.randomUUID()

	const emit = () => {
		const snapshot = { ...internal.state }
		internal.listeners.forEach(l => l(snapshot))
	}

	const setTrack = (track: RadioTrack | null | undefined) => {
		if (!track) return
		internal.state = { ...internal.state, track }
		updateMediaSession(track)
		emit()
	}

	const refreshNowPlaying = async () => {
		try {
			const response = await fetch(internal.api + '/now-playing?t=' + Date.now(), { cache: 'no-store' })
			if (!response.ok) return

			const data = await response.json()
			setTrack(data && data.track)
		} catch {}
	}

	const connectMetadataEvents = () => {
		internal.events?.close()
		internal.events = new EventSource(internal.api + '/now-playing/events')
		internal.events.onmessage = ev => {
			try {
				const data = JSON.parse(ev.data)
				setTrack(data.track || data)
			} catch {}
		}
	}

	let lastMetadataResumeRefreshAt = 0
	const refreshMetadataAfterResume = () => {
		if (document.visibilityState !== 'visible') return

		const now = Date.now()
		if (now - lastMetadataResumeRefreshAt < METADATA_RESUME_REFRESH_MIN_INTERVAL_MS) return
		lastMetadataResumeRefreshAt = now

		void refreshNowPlaying()
		connectMetadataEvents()
	}

	const listenerUrl = (action: 'heartbeat' | 'end') => {
		return `${internal.api}/api/listeners/${action}?sid=${encodeURIComponent(sessionId)}`
	}

	const sendHeartbeat = () => {
		fetch(listenerUrl('heartbeat'), { method: 'POST', keepalive: true }).catch(() => {})
	}

	const sendEnd = () => {
		const url = listenerUrl('end')
		if (navigator.sendBeacon?.(url)) return
		fetch(url, { method: 'POST', keepalive: true }).catch(() => {})
	}

	const startHeartbeat = () => {
		if (internal.heartbeatTimer) return
		sendHeartbeat()
		internal.heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS)
	}

	const stopHeartbeat = (notifyServer: boolean) => {
		if (internal.heartbeatTimer) {
			clearInterval(internal.heartbeatTimer)
			internal.heartbeatTimer = null
		}
		if (notifyServer) sendEnd()
	}

	const updateMediaSession = (track: RadioTrack) => {
		if (!('mediaSession' in navigator)) return
		const cover = track.albumArtUrl || track.coverUrl
		const artwork = cover
			? [96, 128, 192, 256, 384, 512].map(s => ({
					src: cover,
					sizes: `${s}x${s}`,
					type: 'image/jpeg',
				}))
			: undefined
		navigator.mediaSession.metadata = new MediaMetadata({
			title: track.title || 'lofi radio',
			artist: track.artist || 'cieslak.dev',
			album: track.album || '',
			artwork,
		})
	}

	const requestWakeLock = async () => {
		if (!internal.state.wantPlaying || !('wakeLock' in navigator) || internal.wakeLock) return
		try {
			internal.wakeLock = await navigator.wakeLock.request('screen')
			internal.wakeLock.addEventListener('release', () => {
				internal.wakeLock = null
			})
		} catch {}
	}

	const releaseWakeLock = async () => {
		if (!internal.wakeLock) return
		const lock = internal.wakeLock
		internal.wakeLock = null
		await lock.release().catch(() => {})
	}

	const connect = () => {
		if (internal.reconnectTimer) {
			clearTimeout(internal.reconnectTimer)
			internal.reconnectTimer = null
		}
		audio.src = internal.api + '/stream?sid=' + sessionId + '&hb=1&t=' + Date.now()
		audio.play().catch(() => {
			scheduleReconnect()
		})
	}

	const scheduleReconnect = () => {
		if (!internal.state.wantPlaying || internal.reconnectTimer) return
		const delay = Math.min(BASE_BACKOFF_MS * Math.pow(1.5, internal.reconnectAttempt), MAX_BACKOFF_MS)
		internal.reconnectAttempt++
		internal.reconnectTimer = setTimeout(connect, delay)
	}

	const stop = () => {
		internal.state = { ...internal.state, wantPlaying: false, playing: false }
		if (internal.reconnectTimer) {
			clearTimeout(internal.reconnectTimer)
			internal.reconnectTimer = null
		}
		internal.reconnectAttempt = 0
		stopHeartbeat(true)
		void releaseWakeLock()
		audio.pause()
		audio.removeAttribute('src')
		audio.load()
		if ('mediaSession' in navigator) {
			navigator.mediaSession.playbackState = 'paused'
		}
		emit()
	}

	const toggle = () => {
		if (!internal.state.wantPlaying) {
			internal.state = { ...internal.state, wantPlaying: true, hasInteracted: true }
			void requestWakeLock()
			connect()
			startHeartbeat()
			emit()
			return
		}
		stop()
	}

	const tryAutoplay = async () => {
		if (internal.state.wantPlaying) return true

		// Optimistically enter the playing state so the stream/heartbeat wire up
		// exactly as they do for a real toggle...
		internal.state = { ...internal.state, wantPlaying: true }
		audio.src = internal.api + '/stream?sid=' + sessionId + '&hb=1&t=' + Date.now()

		try {
			await audio.play()
		} catch {
			// ...and unwind completely if the browser refused, so the UI is back to
			// a clean paused state and no reconnect loop is left running.
			stop()
			return false
		}

		void requestWakeLock()
		startHeartbeat()
		emit()
		return true
	}

	audio.addEventListener('play', () => {
		internal.state = { ...internal.state, playing: true }
		void requestWakeLock()
		if ('mediaSession' in navigator) {
			navigator.mediaSession.playbackState = 'playing'
		}
		emit()
	})

	audio.addEventListener('pause', () => {
		internal.state = { ...internal.state, playing: false }
		if ('mediaSession' in navigator) {
			navigator.mediaSession.playbackState = 'paused'
		}
		emit()
		// Don't reconnect here: `pause` fires on our own src swaps and OS pauses.
		// Real underruns surface as `waiting`; the watchdog handles genuine stalls.
	})

	// `ended`/`error` mean the connection dropped (or a track-boundary decode error,
	// recoverable only by reopening), so reconnect. We deliberately ignore
	// `stalled`/`waiting` — they're normal jitter on a shallow-buffer live stream.
	audio.addEventListener('ended', () => {
		if (internal.state.wantPlaying) scheduleReconnect()
	})
	audio.addEventListener('error', () => {
		if (internal.state.wantPlaying) scheduleReconnect()
	})

	// Silent-death watchdog: if currentTime stops advancing for ~6s while we want to
	// play, the stream is dead with no event (mobile background / dropped TCP). Reconnect.
	let lastTime = 0
	let stalledTicks = 0
	setInterval(() => {
		if (!internal.state.wantPlaying || !internal.state.playing) {
			stalledTicks = 0
			lastTime = audio.currentTime
			return
		}
		if (audio.currentTime === lastTime) {
			if (++stalledTicks >= 3) {
				// ~6s of no progress
				stalledTicks = 0
				connect()
			}
		} else {
			stalledTicks = 0
			internal.reconnectAttempt = 0 // reset backoff only on *real* progress
		}
		lastTime = audio.currentTime
	}, 2000)

	document.addEventListener('visibilitychange', () => {
		if (internal.state.wantPlaying && document.visibilityState === 'visible') {
			void requestWakeLock()
		}
		refreshMetadataAfterResume()
	})

	window.addEventListener('focus', refreshMetadataAfterResume)

	window.addEventListener('pagehide', () => {
		if (internal.state.wantPlaying) stopHeartbeat(true)
	})

	window.addEventListener('pageshow', () => {
		refreshMetadataAfterResume()
		if (!internal.state.wantPlaying) return
		connect()
		startHeartbeat()
	})

	if ('mediaSession' in navigator) {
		navigator.mediaSession.setActionHandler('play', () => {
			if (!internal.state.wantPlaying) toggle()
		})
		navigator.mediaSession.setActionHandler('pause', () => {
			if (internal.state.wantPlaying) toggle()
		})
	}

	const player: RadioPlayer = {
		toggle,
		tryAutoplay,
		getState: () => ({ ...internal.state }),
		subscribe: listener => {
			internal.listeners.add(listener)
			listener({ ...internal.state })
			return () => internal.listeners.delete(listener)
		},
	}

	void refreshNowPlaying()
	connectMetadataEvents()

	return player
}
