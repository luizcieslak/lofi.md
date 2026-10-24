#!/usr/bin/env node
// Plan and schedule social posts for lofi.md renders. See scripts/README.md.
//
//   node scripts/schedule.ts videos [--folder <name>]
//   node scripts/schedule.ts batches
//   node scripts/schedule.ts add <file…> [--batch <id>]
//   node scripts/schedule.ts move <file> --batch <id> [--index <n>]
//   node scripts/schedule.ts remove <file>
//   node scripts/schedule.ts extra <file> <text>
//   node scripts/schedule.ts new-batch [--start YYYY-MM-DD]
//   node scripts/schedule.ts run [next|<id>] [--dry-run] [--draft] [--only a,b] [--limit n] [--folder f] [--json]
//   node scripts/schedule.ts handle <artist> [@handle…]
//   node scripts/schedule.ts theme-before <light|dark>

import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { dueAtFor, emptyItem, newBatch, nextBatch, nextWindowStart, sortBatches, windowEnd } from './lib/batches.ts'
import { buildCaption, resolveItem } from './lib/caption.ts'
import { buildCatalog, findVideo } from './lib/catalog.ts'
import { RECORDINGS_DIR, today } from './lib/env.ts'
import { absolutePath, findGroup } from './lib/recordings.ts'
import { runBatch } from './lib/runner.ts'
import { describeProblem, nextThemeFor, themeOf, themeProblems, themeSequence } from './lib/theme.ts'
import { loadHandles, loadSchedule, saveHandles, saveSchedule } from './lib/store.ts'
import { SERVICES, isService } from './lib/types.ts'
import type { Batch, RunEvent, Schedule, Service } from './lib/types.ts'

const USAGE = `Usage: node scripts/schedule.ts <command> [options]

Commands:
  videos [--folder <name>]          List local renders, matched to radio tracks
  batches                           Show every batch, its days and status
  add <file…> [--batch <id>]        Append videos to a batch (default: next)
  move <file> --batch <id> [--index <n>]
                                    Move a video to another batch or day (1-based)
  remove <file>                     Take a video out of its batch
  extra <file> <text>               Set the custom text under the credit line
  new-batch [--start YYYY-MM-DD]    Add a batch (default: after the last window)
  run [next|<id>]                   Upload to R2 and schedule one post a day
      --dry-run                     Validate payloads; no upload, no posts
      --draft                       Create Buffer drafts instead
      --only <list>                 youtube,tiktok,instagram subset
      --limit <n>                   Videos to fill an empty batch with (default 10)
      --folder <name>               Fill an empty batch from this recordings folder
      --json                        Stream NDJSON events (used by the posts UI)
  handle <artist> [@handle…]        Set an artist's Instagram handles (none = remove)
  theme-before <light|dark>         Theme of the last post before light/dark alternation

Files are relative to ${RECORDINGS_DIR}.`

function fail(message: string): never {
	console.error(`error: ${message}`)
	process.exit(2)
}

function findBatch(schedule: Schedule, id: string | undefined): Batch {
	if (!id || id === 'next') {
		const next = nextBatch(schedule)
		if (next) return next
		const batch = newBatch(schedule, nextWindowStart(schedule, today(schedule.settings.timeZone)))
		schedule.batches.push(batch)
		return batch
	}
	return schedule.batches.find((b) => b.id === id) ?? fail(`no batch "${id}"`)
}

function assertExists(file: string): void {
	if (!existsSync(absolutePath(file))) fail(`${file} is not in ${RECORDINGS_DIR}; use a path from \`videos\``)
}

function assertEditable(batch: Batch): void {
	if (batch.status !== 'draft') fail(`batch ${batch.id} is ${batch.status}; it can't be edited`)
}

function removeFromBatches(schedule: Schedule, file: string): void {
	for (const batch of schedule.batches) {
		const index = batch.items.findIndex((item) => item.file === file)
		if (index === -1) continue
		assertEditable(batch)
		batch.items.splice(index, 1)
	}
}

const DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
const formatDay = (date: string) => DAY.format(new Date(`${date}T12:00:00Z`))

async function printBatches(schedule: Schedule): Promise<void> {
	const catalog = await buildCatalog(schedule)
	const handles = loadHandles()
	const next = nextBatch(schedule)
	const expected = new Map(themeSequence(schedule).map((slot) => [slot.file, slot.expected]))
	console.log(`Light/dark alternate; the post before the first batch was ${schedule.settings.themeBefore}.`)
	if (schedule.batches.length === 0) console.log('No batches yet. Run `new-batch` or `run next`.')
	for (const batch of sortBatches(schedule.batches)) {
		const marker = batch.id === next?.id ? '  ← next' : ''
		const range = `${formatDay(batch.start)} → ${formatDay(windowEnd(batch, schedule.settings))}`
		console.log(`\n${batch.id}  ${range}  ${batch.status}  ${batch.items.length}/${schedule.settings.batchSize}${marker}`)
		if (batch.note) console.log(`  ${batch.note}`)
		for (const [index, item] of batch.items.entries()) {
			const video = findVideo(catalog, item.file)
			const resolved = resolveItem(item, video?.slug ?? item.file, video?.track ?? null)
			const caption = buildCaption(resolved, item.extra, handles)
			const done = SERVICES.filter((s) => item.posts[s]).join(',')
			const due = batch.imported ? 'queued' : dueAtFor(batch, index, schedule.settings).slice(0, 16).replace('T', ' ')
			const theme = themeOf(item.file)
			const want = expected.get(item.file)
			const flag = want && want !== theme ? `  ! needs ${want}` : ''
			console.log(`  ${String(index + 1).padStart(2)}. ${due}  ${theme.padEnd(5)}  ${caption.credit}${resolved.matched ? '' : '  (no radio match)'}${flag}`)
			console.log(`      ${item.file}${done ? `  [${done}]` : ''}${item.error ? `  ! ${item.error.split('\n')[0]}` : ''}`)
			if (item.extra) console.log(`      + ${item.extra}`)
		}
		if (!batch.imported && batch.items.length < schedule.settings.batchSize)
			console.log(`      next video here must be ${nextThemeFor(schedule, batch.id)}`)
	}
	const problems = themeProblems(schedule)
	if (problems.length > 0) console.log(`\nOut of sequence:\n${problems.map((p) => `  ${describeProblem(p)}`).join('\n')}`)
}

async function printVideos(schedule: Schedule, folder: string | undefined): Promise<void> {
	const catalog = await buildCatalog(schedule)
	if (catalog.tracksError) console.error(`warning: ${catalog.tracksError}`)
	const groups = folder ? [findGroup(catalog.groups, folder) ?? fail(`no recordings folder "${folder}"`)] : catalog.groups
	for (const group of groups) {
		const marker = group.id === catalog.defaultGroupId ? '  ← default' : ''
		console.log(`\n${group.label} (${group.id || 'recordings root'})  ${group.videos.length} video(s)${marker}`)
		for (const video of group.videos) {
			const label = `${video.theme.padEnd(5)}  ${video.track ? `${video.track.title} — ${video.track.artist}` : `${video.slug}  (no radio match)`}`
			console.log(`  ${video.batchId ? `[${video.batchId}]` : '        '.padEnd(12)}  ${label}`)
			console.log(`  ${''.padEnd(12)}  ${video.file}`)
		}
	}
}

let dryRun = false

/** Human-readable rendering of the runner's events. */
function printEvent(event: RunEvent): void {
	switch (event.type) {
		case 'start':
			dryRun = event.dryRun
			console.error(`Batch ${event.batchId}: ${event.count} video(s) → ${event.services.join(', ')}${event.dryRun ? ' (dry run)' : ''}${event.draft ? ' (drafts)' : ''}`)
			break
		case 'item':
			console.error(`\n=== ${event.index + 1}. ${event.title}  @ ${event.dueAt}\n    ${event.file}`)
			break
		case 'upload':
			console.error(`  r2: ${event.state} ${event.url}`)
			break
		case 'log':
			console.error(event.index === null ? event.line : `  ${event.line}`)
			break
		case 'payload':
			console.log(JSON.stringify({ index: event.index, service: event.service, payload: event.payload }))
			break
		case 'post':
			break
		case 'item-done':
			if (event.skipped) console.error('  skipped: already scheduled on every network')
			break
		case 'done':
			console.error(`\nDone: ${event.posted} ${dryRun ? 'validated' : 'scheduled'}, ${event.failed} failed, ${event.skipped} skipped.`)
			if (event.failed > 0) console.error('Failed items keep their error in schedule.json; re-run to retry only what is missing.')
			break
		case 'error':
			console.error(`error: ${event.message}`)
			break
	}
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			batch: { type: 'string' },
			index: { type: 'string' },
			folder: { type: 'string' },
			start: { type: 'string' },
			only: { type: 'string' },
			limit: { type: 'string' },
			'dry-run': { type: 'boolean', default: false },
			draft: { type: 'boolean', default: false },
			json: { type: 'boolean', default: false },
			help: { type: 'boolean', short: 'h', default: false },
		},
	})
	const [command, ...rest] = positionals
	if (values.help || !command) {
		console.log(USAGE)
		return
	}
	const schedule = loadSchedule()

	switch (command) {
		case 'videos':
			return printVideos(schedule, values.folder)

		case 'batches':
			return printBatches(schedule)

		case 'add': {
			if (rest.length === 0) fail('add needs at least one file')
			const batch = findBatch(schedule, values.batch)
			assertEditable(batch)
			for (const file of rest) {
				assertExists(file)
				removeFromBatches(schedule, file)
				batch.items.push(emptyItem(file))
			}
			saveSchedule(schedule)
			console.error(`Added ${rest.length} video(s) to ${batch.id} (${batch.items.length}/${schedule.settings.batchSize}).`)
			return
		}

		case 'move': {
			const [file] = rest
			if (!file || !values.batch) fail('move needs <file> --batch <id>')
			assertExists(file)
			const source = schedule.batches.find((b) => b.items.some((item) => item.file === file))
			const item = source?.items.find((i) => i.file === file) ?? emptyItem(file)
			const target = findBatch(schedule, values.batch)
			assertEditable(target)
			removeFromBatches(schedule, file)
			const at = values.index ? Math.max(0, Number(values.index) - 1) : target.items.length
			target.items.splice(at, 0, item)
			saveSchedule(schedule)
			console.error(`Moved ${file} to ${target.id}, day ${Math.min(at, target.items.length - 1) + 1}.`)
			return
		}

		case 'remove': {
			const [file] = rest
			if (!file) fail('remove needs <file>')
			removeFromBatches(schedule, file)
			saveSchedule(schedule)
			return
		}

		case 'extra': {
			const [file, ...words] = rest
			if (!file) fail('extra needs <file> <text>')
			const item = schedule.batches.flatMap((b) => b.items).find((i) => i.file === file) ?? fail(`${file} is not in a batch`)
			item.extra = words.join(' ')
			saveSchedule(schedule)
			return
		}

		case 'new-batch': {
			const start = values.start ?? nextWindowStart(schedule, today(schedule.settings.timeZone))
			if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) fail('--start must be YYYY-MM-DD')
			const batch = newBatch(schedule, start)
			schedule.batches.push(batch)
			saveSchedule(schedule)
			console.error(`Created ${batch.id} (${formatDay(batch.start)} → ${formatDay(windowEnd(batch, schedule.settings))}).`)
			return
		}

		case 'handle': {
			const [artist, ...list] = rest
			if (!artist) fail('handle needs <artist>')
			const handles = loadHandles()
			if (list.length === 0) delete handles[artist.toLowerCase()]
			else handles[artist.toLowerCase()] = list.map((h) => (h.startsWith('@') ? h : `@${h}`))
			saveHandles(handles)
			return
		}

		case 'theme-before': {
			const [theme] = rest
			if (theme !== 'light' && theme !== 'dark') fail('theme-before takes light or dark')
			schedule.settings.themeBefore = theme
			saveSchedule(schedule)
			console.error(`The post before the first batch was ${theme}; the sequence starts ${theme === 'light' ? 'dark' : 'light'}.`)
			return
		}

		case 'run': {
			const only: Service[] = []
			for (const name of (values.only ?? '').split(',').filter(Boolean)) {
				if (!isService(name)) fail(`--only accepts ${SERVICES.join(', ')} (got "${name}")`)
				only.push(name)
			}
			const limit = values.limit === undefined ? null : Number(values.limit)
			if (limit !== null && (!Number.isInteger(limit) || limit < 1)) fail('--limit must be a positive integer')
			const ok = await runBatch(
				{
					batch: rest[0] ?? 'next',
					dryRun: values['dry-run'],
					draft: values.draft,
					only,
					limit,
					folder: values.folder ?? null,
				},
				values.json ? (event) => process.stdout.write(`${JSON.stringify(event)}\n`) : printEvent,
			)
			process.exitCode = ok ? 0 : 1
			return
		}

		default:
			fail(`unknown command "${command}"\n\n${USAGE}`)
	}
}

main().catch((error: unknown) => {
	console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
	process.exit(1)
})
