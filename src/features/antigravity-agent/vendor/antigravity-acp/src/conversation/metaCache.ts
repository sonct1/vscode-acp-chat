import { conversationDbPath, statConversation, type DbStat } from "./database.js";
import type { NativeMetadata } from "./metadata.js";
import { extractMetadata } from "./metadata.js";

interface CacheEntry {
	metadata: NativeMetadata;
	key: DbStat | null;
}

const metadataCache = new Map<string, CacheEntry>();

function sameStat(left: DbStat | null, right: DbStat | null): boolean {
	if (left === null || right === null) return left === right;
	return (
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs &&
		left.size === right.size &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.walMtimeMs === right.walMtimeMs &&
		left.walCtimeMs === right.walCtimeMs &&
		left.walSize === right.walSize &&
		left.walDev === right.walDev &&
		left.walIno === right.walIno
	);
}

export function getCachedMetadata(dir: string, id: string): NativeMetadata {
	const dbPath = conversationDbPath(dir, id);
	const currentKey = statConversation(dir, id);

	const cached = metadataCache.get(dbPath);
	if (cached && sameStat(cached.key, currentKey)) {
		return cached.metadata;
	}

	const metadata = extractMetadata(dir, id);

	// Missing DBs are cached too; a later file creation changes the identity.
	metadataCache.set(dbPath, { metadata, key: currentKey });

	return metadata;
}

export function clearMetadataCache(): void {
	metadataCache.clear();
}
