import assert from 'node:assert/strict'
import test from 'node:test'
import { queuePostArgs } from './runner.ts'

test('queues a post without forcing a due time', () => {
	const args = queuePostArgs({
		url: 'https://cdn.example/video.mp4',
		description: 'Track by Artist',
		title: 'Track by Artist',
		services: ['youtube', 'tiktok', 'instagram'],
		draft: false,
		dryRun: false,
	})

	assert.deepEqual(args, [
		'--video',
		'https://cdn.example/video.mp4',
		'--description',
		'Track by Artist',
		'--title',
		'Track by Artist',
		'--only',
		'youtube,tiktok,instagram',
	])
	assert.equal(args.includes('--due-at'), false)
})
