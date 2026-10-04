// The storage modal: a build-once DOM handle plus its pure canvas pie-drawing helper.
// The builder takes a store and a usage/quota pair; open/close wiring and the refresh cadence live on in ui.ts mount.
// update() patches text, the pie, and the date preview in place, so the number and date inputs are never recreated while the modal stays open.

import { h } from "./dom.js";
import { formatBytes } from "./format.js";
import { historyItemBytes } from "./historyList.js";
import { isButtonElement, isHTMLElement, isInputElement, requiredElement } from "./list.js";
import type { Store } from "./state.js";
import { parseDateInput, formatDateInput } from "./storageDate.js";

const PIE_COLORS = ["#5b8cff", "#e6b45c", "#4cc38a", "#e0605f", "#c678dd", "#7aa3b0"];

const IDLE_DELETE_BEFORE_LABEL = "Delete before date";

/** The date-based deletion currently armed in the button, exactly as painted. */
export interface DeleteBeforePreview {
	/** The parsed local-midnight epoch-ms cutoff the deletion will run with. */
	cutoffMs: number;
	/** The raw YYYY-MM-DD input value the preview was computed from. */
	date: string;
	/** The archive-wide count of items the deletion would remove. */
	count: number;
}

export interface StorageModalHandle {
	el: HTMLElement;
	/** Patch the usage/quota summary, the pie, and every history-derived readout in place; never rebuilds the inputs. */
	update(usage: number, quota: number): void;
	/** The deletion preview painted into the date button, or null when nothing valid is armed. */
	deleteBeforePreview(): DeleteBeforePreview | null;
	/**
	 * Disable the date button while a confirmed deletion is in flight so it cannot be double-clicked.
	 * `false` re-enables the button and re-runs the preview count.
	 */
	setDeleteBeforeBusy(busy: boolean): void;
	/**
	 * Disable the delete-oldest button while its confirmed deletion is in flight so it cannot be double-clicked.
	 * `false` re-enables the button unless the resolved archive count is 0.
	 */
	setDeleteOldestBusy(busy: boolean): void;
	/** Re-run the date-input preview count immediately, bypassing the resident-signature gate; the arms call it once a confirmed deletion has shrunk what the preview counts. */
	refreshPreview(): void;
	/**
	 * Re-scan the archive-wide delete-oldest count immediately, bypassing the resident-signature gate.
	 * An evicted-only deletion leaves every resident (and thus the gate's signature) untouched while shrinking the archive, so the gated update path alone would never repaint the label.
	 */
	refreshArchiveCount(): void;
}

export function buildStorageModal(store: Store, usage: number, quota: number): StorageModalHandle {
	const persistent = store.history.isPersistent();
	const canvas = document.createElement("canvas");
	canvas.className = "storage-pie";
	const overlay = h("div", { class: "overlay storage-overlay" }, [
		h("div", { class: "modal storage-modal" }, [
			h("div", { class: "modal-head" }, [
				h("h2", {}, "Storage"),
				h("button", { class: "btn", "data-action": "close-storage" }, "Close"),
			]),
			canvas,
			h("p", { class: "storage-summary", "data-storage-summary": "" }, ""),
			h("div", { class: "storage-delete-oldest" }, [
				h("label", { class: "storage-del-label", "data-delete-oldest-label": "" }, "Delete oldest (counting saved generations…)"),
				h("div", { class: "storage-del-row" }, [
					h("input", { type: "number", min: "1", value: "1", "data-delete-oldest-count": "", "aria-label": "How many oldest history items to delete" }),
					h("button", { class: "btn small", "data-action": "delete-oldest", "data-delete-oldest-button": "" }, "Delete oldest"),
				]),
			]),
			h("div", { class: "storage-delete-before" }, [
				h("label", { class: "storage-del-label" }, "Delete by date"),
				h("div", { class: "storage-del-row" }, [
					h("input", { type: "date", "data-delete-before-date": "", "aria-label": "Delete history before this date" }),
					h("button", { class: "btn small", "data-action": "delete-before", "data-delete-before-button": "" }, IDLE_DELETE_BEFORE_LABEL),
				]),
				h("p", { class: "storage-del-hint", "data-delete-before-hint": "" }, ""),
			]),
			h("div", { class: "modal-actions" }, [
				h("button", { class: "btn small danger", "data-action": "clear-history" }, "Clear all history"),
			]),
		]),
	]);
	const summaryEl = requiredElement(overlay.querySelector("[data-storage-summary]"), isHTMLElement, "storage summary");
	const delLabelEl = requiredElement(overlay.querySelector("[data-delete-oldest-label]"), isHTMLElement, "delete-oldest label");
	const countInputEl = requiredElement(overlay.querySelector("[data-delete-oldest-count]"), isInputElement, "delete-oldest count input");
	const deleteOldestBtn = requiredElement(overlay.querySelector("[data-delete-oldest-button]"), isButtonElement, "delete-oldest button");
	const dateInputEl = requiredElement(overlay.querySelector("[data-delete-before-date]"), isInputElement, "delete-before date input");
	const deleteBeforeBtn = requiredElement(overlay.querySelector("[data-delete-before-button]"), isButtonElement, "delete-before button");
	const hintEl = requiredElement(overlay.querySelector("[data-delete-before-hint]"), isHTMLElement, "delete-before hint");
	// A future cutoff could outrun its own preview count, so the date input is capped at today's LOCAL calendar day (the modal is rebuilt fresh on every open, so the cap never goes stale).
	dateInputEl.max = formatDateInput(Date.now());

	// Date-preview state: a generation counter discards stale async counts, and `busy` freezes the button while a confirmed deletion runs.
	let previewGeneration = 0;
	let busy = false;
	let preview: DeleteBeforePreview | null = null;

	const paintIdle = (hint: string): void => {
		preview = null;
		deleteBeforeBtn.disabled = true;
		deleteBeforeBtn.textContent = IDLE_DELETE_BEFORE_LABEL;
		hintEl.textContent = hint;
	};

	const refreshPreview = (): void => {
		if (busy) return;
		const generation = ++previewGeneration;
		const value = dateInputEl.value;
		const cutoff = parseDateInput(value);
		if (cutoff === null) {
			paintIdle("Choose a date to preview what will be deleted.");
			return;
		}
		paintIdle(`Counting generations before ${value}.`);
		void store.countHistoryBefore(cutoff).then((count) => {
			// A stale resolution (the date changed again, or a repaint superseded this one) must never paint.
			if (generation !== previewGeneration || busy) return;
			if (count <= 0) {
				paintIdle(`No generations before ${value}.`);
				return;
			}
			preview = { cutoffMs: cutoff, date: value, count };
			deleteBeforeBtn.disabled = false;
			deleteBeforeBtn.textContent = `Delete ${count} items before ${value}`;
			hintEl.textContent = "Removes every generation made before the chosen date, including ones no longer shown in the list.";
		}).catch(() => {
			if (generation !== previewGeneration || busy) return;
			paintIdle("Could not count the generations for that date.");
		});
	};
	dateInputEl.addEventListener("input", refreshPreview);

	// Gates the preview and archive-count refreshes inside update(): the polls repaint every couple of seconds, but only a history change can move either readout.
	// The signature is built from RESIDENT items only, so an evicted-only deletion changes nothing here; the handle's refresh methods bypass it for exactly that case.
	let lastHistorySig: string | null = null;
	const residentSig = (): string => store.history.items().map((i) => `${i.id}:${i.createdAt}`).join(",");

	// Archive-count state: a generation counter discards stale scans, so the label and max only ever paint a resolved archive-wide figure (never the resident count).
	// `lastArchiveCount` is null until a scan resolves (the counting placeholder), and `oldestBusy` keeps a resolved count from re-enabling the button underneath an in-flight deletion.
	let countGeneration = 0;
	let lastArchiveCount: number | null = null;
	let oldestBusy = false;

	const paintDeleteOldest = (): void => {
		// While counting (no resolution yet) the button keeps its enabled placeholder; once a count has resolved it is enabled exactly when the universe is non-empty and no deletion is in flight.
		deleteOldestBtn.disabled = oldestBusy || (lastArchiveCount !== null && lastArchiveCount <= 0);
	};

	const refreshArchiveCount = (): void => {
		const generation = ++countGeneration;
		void store.countHistory().then((count) => {
			// A stale resolution (a newer history change superseded this scan) must never paint.
			if (generation !== countGeneration) return;
			lastArchiveCount = count;
			delLabelEl.textContent = `Delete oldest (of ${count} saved generations)`;
			countInputEl.max = String(Math.max(1, count));
			paintDeleteOldest();
		}).catch(() => {
			if (generation !== countGeneration) return;
			// A failed scan keeps the last resolved count's button state; only the label falls back to the bare placeholder.
			delLabelEl.textContent = "Delete oldest";
		});
	};

	const update = (nextUsage: number, nextQuota: number): void => {
		const items = store.history.items();
		const slices = items.map((it, index) => ({
			label: it.prompt,
			value: historyItemBytes(it),
			color: PIE_COLORS[index % PIE_COLORS.length] ?? PIE_COLORS[0] ?? "#5b8cff",
		}));
		drawStoragePie(canvas, slices, nextUsage, nextQuota);
		summaryEl.textContent = persistent ? `history saved in this browser · ${formatBytes(nextUsage)} of ${formatBytes(nextQuota)}` : "session-only history (not persisted)";
		const sig = residentSig();
		if (sig !== lastHistorySig) {
			lastHistorySig = sig;
			refreshPreview();
			refreshArchiveCount();
		}
	};

	update(usage, quota);
	return {
		el: overlay,
		update,
		deleteBeforePreview: () => (busy ? null : preview),
		setDeleteBeforeBusy: (next: boolean) => {
			busy = next;
			if (busy) {
				preview = null;
				deleteBeforeBtn.disabled = true;
				return;
			}
			refreshPreview();
		},
		setDeleteOldestBusy: (next: boolean) => {
			oldestBusy = next;
			paintDeleteOldest();
		},
		refreshPreview: (): void => refreshPreview(),
		refreshArchiveCount: (): void => {
			// Bring the signature gate up to date at request time so a subsequent gated update sees a consistent gate; the generation counter discards whichever overlapping scan loses.
			lastHistorySig = residentSig();
			refreshArchiveCount();
		},
	};
}

function drawStoragePie(canvas: HTMLCanvasElement, slices: { value: number; color: string }[], usage: number, quota: number): void {
	const size = 220;
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	const cx = size / 2;
	const cy = size / 2;
	const r = 88;
	const total = quota > 0 ? quota : usage > 0 ? usage : 1;
	const used = usage > 0 ? usage : 0;
	const itemTotal = slices.reduce((n, s) => n + s.value, 0);
	let start = -Math.PI / 2;
	if (itemTotal > 0 && used > 0) {
		for (const s of slices) {
			const angle = ((used * (s.value / itemTotal)) / total) * Math.PI * 2;
			ctx.beginPath();
			ctx.moveTo(cx, cy);
			ctx.arc(cx, cy, r, start, start + angle);
			ctx.closePath();
			ctx.fillStyle = s.color;
			ctx.fill();
			start += angle;
		}
	}
	const otherVal = itemTotal === 0 ? used : used - itemTotal;
	if (otherVal > 0) {
		const angle = (otherVal / total) * Math.PI * 2;
		if (angle > 0) {
			ctx.beginPath();
			ctx.moveTo(cx, cy);
			ctx.arc(cx, cy, r, start, start + angle);
			ctx.closePath();
			ctx.fillStyle = "#333a47";
			ctx.fill();
			start += angle;
		}
	}
	if (total > used) {
		const angle = ((total - used) / total) * Math.PI * 2;
		ctx.beginPath();
		ctx.moveTo(cx, cy);
		ctx.arc(cx, cy, r, start, start + angle);
		ctx.closePath();
		ctx.fillStyle = "#222832";
		ctx.fill();
	}
	ctx.fillStyle = "#e6e9ee";
	ctx.font = "bold 18px system-ui, sans-serif";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(formatBytes(usage), cx, cy);
}
