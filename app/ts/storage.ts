// The storage modal DOM builder and its pure canvas pie-drawing helpers.
// The builder takes a store and a usage/quota pair; open/close wiring and the refresh cadence live on in ui.ts mount.

import { h } from "./dom.js";
import { formatBytes } from "./format.js";
import { historyItemBytes } from "./historyList.js";
import type { Store } from "./state.js";

const PIE_COLORS = ["#5b8cff", "#e6b45c", "#4cc38a", "#e0605f", "#c678dd", "#7aa3b0"];

// Build the full storage modal overlay, draw its pie onto the freshly created canvas, and return the overlay node ready to append.
export function buildStorageModal(store: Store, usage: number, quota: number): HTMLElement {
	const items = store.history.items();
	const slices = items.map((it, index) => ({
		label: it.prompt,
		value: historyItemBytes(it),
		color: PIE_COLORS[index % PIE_COLORS.length] ?? PIE_COLORS[0] ?? "#5b8cff",
	}));
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
			h("p", { class: "storage-summary" }, persistent ? `history saved in this browser · ${formatBytes(usage)} of ${formatBytes(quota)}` : "session-only history (not persisted)"),
			h("div", { class: "storage-delete-oldest" }, [
				h("label", { class: "storage-del-label" }, "Delete oldest history"),
				h("div", { class: "storage-del-row" }, [
					h("input", { type: "number", min: "1", value: "1", "data-delete-oldest-count": "", "aria-label": "How many oldest history items to delete" }),
					h("button", { class: "btn small", "data-action": "delete-oldest" }, "Delete oldest"),
				]),
			]),
			h("div", { class: "modal-actions" }, [
				h("button", { class: "btn small danger", "data-action": "clear-history" }, "Clear all history"),
			]),
		]),
	]);
	drawStoragePie(canvas, slices, usage, quota);
	return overlay;
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
