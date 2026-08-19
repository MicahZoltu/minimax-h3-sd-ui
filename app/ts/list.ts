// Shared DOM primitives for the queue/history row lists.
// Houses the element guards used by every rendering module and the single in-place reconcile primitive
// that both list sections drive, so open <details> and input focus survive background reconciles.

export const isHTMLElement = (el: unknown): el is HTMLElement => el instanceof HTMLElement;
export const isInputElement = (el: unknown): el is HTMLInputElement => el instanceof HTMLInputElement;
export const isVideoElement = (el: unknown): el is HTMLVideoElement => el instanceof HTMLVideoElement;

export function requiredElement<T extends Element>(el: unknown, guard: (el: unknown) => el is T, what: string): T {
	if (!guard(el)) throw new Error(`Required ${what} element is missing.`);
	return el;
}

export function maybeElement<T extends Element>(el: unknown, guard: (el: unknown) => el is T): T | null {
	return guard(el) ? el : null;
}

export interface ReconcileRowSpec {
	/** The stable data-id each row carries; existing rows are matched by it. */
	id: string;
	/** Decide whether an existing row with this id can be reused in place rather than rebuilt. */
	isSame: (existing: HTMLElement) => boolean;
	/** Build the desired row; invoked only when the existing row is absent or failed isSame, never for a reused row. */
	build: () => HTMLElement;
	/** Optional per-row touch applied when an existing row is reused in place (e.g. history's "new" highlight). */
	onKept?: (row: HTMLElement) => void;
}

export interface ReconcileOptions {
	/** CSS selector matching the rows owned by this list inside the container. */
	rowSelector: string;
	/** Called with a removed row's id so a caller can drop its media object URLs. */
	onRemoved?: (id: string) => void;
}

// Reconcile the container's rows against the desired list in display order.
// Rows whose id still exists and whose isSame passes are kept in place (an open <details> and live input/value
// survive); others are moved and only removed, rebuilt, or freshly built as needed.
//
// The desired rows are described lazily (spec.build runs only for a row that is absent or must be rebuilt), so a
// caller like the history section never constructs a throwaway row just to discover an existing one is reusable.
export function reconcileRows(container: HTMLElement, desired: ReconcileRowSpec[], opts: ReconcileOptions): void {
	const existing = new Map<string, HTMLElement>();
	for (const row of container.querySelectorAll<HTMLElement>(opts.rowSelector)) {
		existing.set(row.getAttribute("data-id") ?? "", row);
	}
	const wanted = new Set(desired.map((d) => d.id));
	for (const [id, row] of existing) {
		if (!wanted.has(id)) {
			row.remove();
			opts.onRemoved?.(id);
		}
	}
	let prev: HTMLElement | null = null;
	for (const spec of desired) {
		const current = existing.get(spec.id);
		if (current && spec.isSame(current)) {
			spec.onKept?.(current);
			positionRow(container, current, prev);
			prev = current;
		} else {
			if (current) current.remove();
			const fresh = spec.build();
			positionRow(container, fresh, prev);
			prev = fresh;
		}
	}
}

// Move `row` to just after `prev` (or to the list start when prev is null), only when it is not already there.
function positionRow(container: HTMLElement, row: HTMLElement, prev: HTMLElement | null): void {
	if (prev && row !== prev.nextSibling) container.insertBefore(row, prev.nextSibling);
	else if (!prev && row !== container.firstChild) container.insertBefore(row, container.firstChild);
}
