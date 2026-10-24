# Buffer scheduling failure runbook

Use this when the `lofi.md Buffer Schedule` cron reports a failure. Buffer is the source of truth for posts that were actually created.

The implementation and behavior are documented in [`README.md`](README.md):

- [If a post fails](README.md#if-a-post-fails)
- [The scheduler](README.md#the-scheduler-batches-of-10-one-post-a-day)
- [What a run does](README.md#what-a-run-does)

## Automated cron guardrails

The cron has already attempted the live scheduling command once before troubleshooting starts.

- On success, do not run it again.
- A stale `scripts/.schedule.lock` may be removed only after proving its PID is dead and confirming the failure happened before any upload or post attempt. The live command may then be retried once.
- Do not automatically change batch dates/order, credentials, channel configuration, or recorded post IDs.
- Do not retry partial or ambiguous Buffer failures without first reconciling against the Buffer app; report the exact manual check Luiz needs instead.

## 1. Inspect the current batch

From the repository root:

```bash
pnpm schedule batches
```

Find the batch marked `← next`, any item marked `Failed`, and which networks already have recorded post IDs.

## 2. Verify Buffer before retrying

Open the Buffer app and inspect the relevant channels, dates, and posts. Check whether a post exists in Buffer even if `scripts/schedule.json` does not contain its ID. Do not blindly retry when the local state and Buffer disagree, because Buffer post creation is not idempotent.

## 3. Classify the failure

- **Partial batch / Buffer API error:** compare Buffer with the recorded network IDs in `scripts/schedule.json`.
- **Due date is in the past:** move the batch start to tomorrow or later in the posts UI (`pnpm dev`, then `/posts.html`).
- **Light/dark sequence error:** reorder the affected batch in the posts UI until the warning clears.
- **Authentication/channel error:** run `pnpm buffer:setup` and verify the reported configuration sources. Never copy API keys into logs or chat.
- **R2 upload error:** verify Wrangler authentication and the configured Cloudflare credentials, then check whether the expected CDN URL already works.
- **Another run is active:** wait for it to finish. Do not remove `scripts/.schedule.lock` while its PID is alive.

## 4. Retry only after reconciliation

Once Buffer and `scripts/schedule.json` agree, retry:

```bash
pnpm schedule run next
```

The scheduler skips networks with recorded post IDs and retries only missing ones. Confirm the result in Buffer, then run `pnpm schedule batches` again to verify that the batch is no longer partial.
