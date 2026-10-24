import { buildCaption, resolveItem } from '../../scripts/lib/caption.ts'
import type { Caption, ResolvedItem } from '../../scripts/lib/caption.ts'
import type { CatalogVideo } from '../../scripts/lib/catalog.ts'
import { SERVICES } from '../../scripts/lib/types.ts'
import type { BatchItem, Handles, Service } from '../../scripts/lib/types.ts'

const DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', timeZone: 'UTC' })
const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/** "Fri 24" for a YYYY-MM-DD. */
export const formatDay = (date: string) => DAY.format(new Date(`${date}T12:00:00Z`))
/** "Oct 24" for a YYYY-MM-DD. */
export const formatDate = (date: string) => DATE.format(new Date(`${date}T12:00:00Z`))

export const SERVICE_LABEL: Record<Service, string> = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram' }

export interface ItemView {
	resolved: ResolvedItem
	caption: Caption
}

export function viewItem(item: Pick<BatchItem, 'title' | 'artist' | 'extra'>, video: CatalogVideo | undefined, file: string, handles: Handles): ItemView {
	const resolved = resolveItem(item, video?.slug ?? file.split('/').pop() ?? file, video?.track ?? null)
	return { resolved, caption: buildCaption(resolved, item.extra, handles) }
}

export function Art({ src, size = 36 }: { src: string | null | undefined; size?: number }) {
	if (!src) return <span className="art art-empty" style={{ width: size, height: size }} aria-hidden="true" />
	return <img className="art" src={src} alt="" width={size} height={size} loading="lazy" decoding="async" />
}

export function Chip({ tone = 'muted', children }: { tone?: 'muted' | 'warn' | 'ok' | 'accent' | 'error'; children: React.ReactNode }) {
	return <span className={`chip chip-${tone}`}>{children}</span>
}

/** One dot per network: filled once that network has a post id. */
export function ServiceDots({ item }: { item: BatchItem }) {
	return (
		<span className="dots" aria-label={SERVICES.map((s) => `${SERVICE_LABEL[s]} ${item.posts[s] ? 'scheduled' : 'pending'}`).join(', ')}>
			{SERVICES.map((service) => (
				<span key={service} className="dot" data-on={item.posts[service] ? '' : undefined} title={SERVICE_LABEL[service]}>
					{SERVICE_LABEL[service][0]}
				</span>
			))}
		</span>
	)
}
