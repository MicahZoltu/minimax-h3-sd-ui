// Pure date helpers for archive-wide, date-based history deletion.
// Nothing here touches the DOM, the store, or a backend, so it is fully unit-testable in Bun.
// Every consumer (preview count, resident deletion, archive deletion) must decide deletability through predatesCutoff, so a count can never drift from what is actually deleted.

/**
 * The ONE shared deletion predicate: an item is deletable exactly when its createdAt is a finite epoch-ms strictly before the cutoff.
 * A non-finite createdAt is never counted and never deleted.
 * The parameter is `unknown` so raw (unvalidated) backend records can be tested without type assertions.
 */
export function predatesCutoff(createdAt: unknown, cutoffMs: number): boolean {
	return typeof createdAt === "number" && Number.isFinite(createdAt) && createdAt < cutoffMs;
}

/** Count the items the shared predicate would delete at this cutoff. */
export function dateCutoffCount(items: { createdAt: number }[], cutoffMs: number): number {
	let count = 0;
	for (const item of items) {
		if (predatesCutoff(item.createdAt, cutoffMs)) count += 1;
	}
	return count;
}

/**
 * Format an epoch-ms instant as the LOCAL YYYY-MM-DD `<input type="date">` value of its calendar day.
 * Built from the local date parts on purpose: toISOString is UTC, so a UTC-straddling instant would format as the wrong (e.g. tomorrow's) day in some timezones.
 */
export function formatDateInput(ms: number): string {
	const date = new Date(ms);
	const year = String(date.getFullYear()).padStart(4, "0");
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/**
 * Parse a YYYY-MM-DD `<input type="date">` value into epoch ms of LOCAL midnight, or null when empty or invalid.
 * Uses the explicit new Date(y, m - 1, d) constructor on purpose: new Date("YYYY-MM-DD") parses as UTC midnight and shifts the day boundary by hours.
 * Calendar rollovers (e.g. 2026-02-31) are rejected by round-tripping the constructed date's parts.
 */
export function parseDateInput(value: string): number | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const [year, month, day] = value.split("-").map(Number);
	if (year === undefined || month === undefined || day === undefined) return null;
	const date = new Date(year, month - 1, day);
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
	return date.getTime();
}
