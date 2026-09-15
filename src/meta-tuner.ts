// Dev-only tuning panel for the #meta block: the four 3D transform knobs plus
// its two edge offsets. Imported behind `import.meta.env.DEV` in main.ts, so it
// is dropped entirely from production builds.
//
// Values are written as inline custom properties on #meta, which override the
// stylesheet's defaults without touching it. `Copy CSS` emits the current set
// ready to paste back into the #meta rule; `Reset` drops the overrides and
// returns to whatever the stylesheet says.

type Knob = {
	prop: string
	label: string
	min: number
	max: number
	step: number
	unit: string
}

const KNOBS: Knob[] = [
	{ prop: '--meta-top', label: 'top', min: 0, max: 1200, step: 1, unit: 'px' },
	{ prop: '--meta-right', label: 'right', min: 0, max: 1200, step: 1, unit: 'px' },
	{ prop: '--meta-perspective', label: 'perspective', min: 120, max: 4000, step: 10, unit: 'px' },
	{ prop: '--meta-rotate-y', label: 'rotateY', min: -200, max: 200, step: 0.5, unit: 'deg' },
	{ prop: '--meta-rotate-x', label: 'rotateX', min: -200, max: 200, step: 0.5, unit: 'deg' },
	{ prop: '--meta-rotate-z', label: 'rotateZ', min: -200, max: 200, step: 0.5, unit: 'deg' },
]

const STORAGE_KEY = 'meta-tuner'

export function mountMetaTuner(meta: HTMLElement) {
	// Resolving against the computed style means the sliders open on the real
	// current values — including the stylesheet's, on a first run with no saved
	// overrides.
	//
	// Custom properties resolve as raw tokens, not computed lengths: a value
	// written in any unit other than the knob's own would come back as a bare
	// number in the wrong scale (`2rem` → 2). Warn rather than silently mis-tune.
	const read = (prop: string, unit?: string) => {
		const raw = getComputedStyle(meta).getPropertyValue(prop).trim()
		const value = parseFloat(raw)
		if (Number.isNaN(value)) return 0
		if (unit && raw && !raw.endsWith(unit)) {
			console.warn(
				`[meta-tuner] ${prop} is "${raw}", not ${unit} — the slider will rewrite it in ${unit}.`,
			)
		}
		return value
	}

	const write = (knob: Knob, value: number) =>
		meta.style.setProperty(knob.prop, `${value}${knob.unit}`)

	// Restore a previous session's tuning before the panel reads its values, so
	// the sliders and the page agree on the starting point.
	const saved: Record<string, number> = JSON.parse(
		localStorage.getItem(STORAGE_KEY) ?? '{}',
	)
	for (const knob of KNOBS) {
		if (typeof saved[knob.prop] === 'number') write(knob, saved[knob.prop])
	}

	const save = () => {
		const current = Object.fromEntries(KNOBS.map(k => [k.prop, read(k.prop, k.unit)]))
		localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
	}

	const panel = document.createElement('div')
	panel.id = 'meta-tuner'
	panel.innerHTML = `
		<style>
			#meta-tuner {
				position: fixed;
				bottom: 16px;
				left: 16px;
				z-index: 9999;
				display: grid;
				gap: 10px;
				width: 260px;
				padding: 14px;
				border-radius: 10px;
				background: rgba(0, 0, 0, 0.85);
				backdrop-filter: blur(10px);
				color: #f5f5f4;
				font: 11px ui-monospace, SFMono-Regular, Menlo, monospace;
				box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
			}
			#meta-tuner[data-collapsed='true'] > :not(header) { display: none; }
			#meta-tuner header {
				display: flex;
				align-items: center;
				justify-content: space-between;
				cursor: pointer;
				user-select: none;
				font-weight: 600;
			}
			#meta-tuner label { display: grid; gap: 3px; }
			#meta-tuner input { width: 100%; margin: 0; accent-color: #f5f5f4; }
			#meta-tuner footer { display: flex; gap: 6px; }
			#meta-tuner button {
				flex: 1;
				padding: 5px;
				border: 0;
				border-radius: 5px;
				background: rgba(255, 255, 255, 0.14);
				color: inherit;
				font: inherit;
				cursor: pointer;
			}
			#meta-tuner button:hover { background: rgba(255, 255, 255, 0.24); }
		</style>
		<header><span>#meta tuner</span><span data-chevron>▾</span></header>
	`

	const header = panel.querySelector('header') as HTMLElement
	const chevron = panel.querySelector('[data-chevron]') as HTMLElement
	header.addEventListener('click', () => {
		const collapsed = panel.dataset.collapsed === 'true'
		panel.dataset.collapsed = collapsed ? 'false' : 'true'
		chevron.textContent = collapsed ? '▾' : '▸'
	})

	const sync: Array<() => void> = []

	for (const knob of KNOBS) {
		const row = document.createElement('label')
		const out = document.createElement('span')
		const input = document.createElement('input')

		input.type = 'range'
		input.min = String(knob.min)
		input.max = String(knob.max)
		input.step = String(knob.step)

		const refresh = () => {
			const value = read(knob.prop, knob.unit)
			input.value = String(value)
			out.textContent = `${knob.label}: ${value}${knob.unit}`
		}
		refresh()
		sync.push(refresh)

		input.addEventListener('input', () => {
			const value = Number(input.value)
			write(knob, value)
			out.textContent = `${knob.label}: ${value}${knob.unit}`
			save()
		})

		row.append(out, input)
		panel.append(row)
	}

	const footer = document.createElement('footer')

	const copy = document.createElement('button')
	copy.textContent = 'Copy CSS'
	copy.addEventListener('click', () => {
		const css = KNOBS.map(k => `\t${k.prop}: ${read(k.prop, k.unit)}${k.unit};`).join('\n')
		void navigator.clipboard.writeText(css)
		console.log(css)
		copy.textContent = 'Copied'
		setTimeout(() => (copy.textContent = 'Copy CSS'), 1200)
	})

	const reset = document.createElement('button')
	reset.textContent = 'Reset'
	reset.addEventListener('click', () => {
		for (const knob of KNOBS) meta.style.removeProperty(knob.prop)
		localStorage.removeItem(STORAGE_KEY)
		for (const refresh of sync) refresh()
	})

	footer.append(copy, reset)
	panel.append(footer)
	document.body.append(panel)

	return panel
}
