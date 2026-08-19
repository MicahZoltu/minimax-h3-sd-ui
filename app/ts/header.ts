// The header: the status line, the inline API-base editor, and the storage-note readout.
// It owns building the topbar, the inline URL edit field (open on click, save on Enter, cancel on Escape/blur),
// and the transient api-error display with its auto-hide timer.
// The storage meter's text/bar/fill elements are exposed so mount can drive the quota meter from its refresh cadence;
// everything else the header renders stays internal. mount calls update() from its `caps` subscription.
// This module must never import ui.js.

import { getApiBase, getConfigurableBase } from "./config.js";
import { h, clear } from "./dom.js";
import { isHTMLElement, maybeElement, requiredElement } from "./list.js";
import type { Store } from "./state.js";

export interface HeaderHandle {
	el: HTMLElement;
	update(store: Store): void;
	storageTextEl: HTMLElement;
	storageBarEl: HTMLElement;
	storageFillEl: HTMLElement;
}

export function buildHeader(store: Store): HeaderHandle {
	const el = h("header", { class: "topbar" }, [
		h("div", { class: "brand" }, [h("h1", {}, "Video Studio")]),
		h("div", { class: "topbar-right" }, [
			h("span", { class: "status warn" }, "Connecting…"),
			h("div", { class: "api-inline" }, [
				h("span", { class: "api-url", "data-api-url": "", title: "Click to edit the API server URL" }, ""),
				h("span", { class: "api-err", "data-api-err": "" }, ""),
			]),
			h("div", { class: "storage-inline", "data-action": "open-storage", title: "Manage saved history and storage" }, [
				h("span", { class: "storage-note" }, ""),
				h("div", { class: "storage-meter", "data-storage-bar": "" }, [
					h("div", { class: "storage-meter-fill", "data-storage-fill": "" }),
				]),
				h("span", { class: "storage-meta", "data-storage-text": "" }, ""),
			]),
		]),
	]);
	const statusEl = requiredElement(el.querySelector(".status"), isHTMLElement, "status");
	const storageEl = requiredElement(el.querySelector(".storage-note"), isHTMLElement, "storage note");
	const storageTextEl = requiredElement(el.querySelector("[data-storage-text]"), isHTMLElement, "storage text");
	const storageBarEl = requiredElement(el.querySelector("[data-storage-bar]"), isHTMLElement, "storage bar");
	const storageFillEl = requiredElement(el.querySelector("[data-storage-fill]"), isHTMLElement, "storage fill");
	const apiUrlEl = requiredElement(el.querySelector("[data-api-url]"), isHTMLElement, "api url");
	const apiErrEl = maybeElement(el.querySelector("[data-api-err]"), isHTMLElement);
	const update = (store: Store): void => {
		if (store.state.progressError) {
			// The server is reachable but lacks the feature this UI requires; surface that clearly rather than silently degrading.
			statusEl.textContent = "Online";
			statusEl.className = "status warn";
			statusEl.title = store.state.progressError;
			if (apiErrEl) {
				apiErrEl.textContent = store.state.progressError;
				apiErrEl.className = "api-err show";
			}
		} else if (store.state.online) {
			statusEl.textContent = "Online";
			statusEl.className = "status ok";
		} else if (store.state.capsError) {
			statusEl.textContent = "Offline";
			statusEl.className = "status warn";
			statusEl.title = store.state.capsError;
		} else {
			statusEl.textContent = "Connecting…";
			statusEl.className = "status warn";
		}
		if (apiErrEl && !store.state.progressError) {
			apiErrEl.className = "api-err";
			apiErrEl.textContent = "";
		}
		// Don't clobber an in-progress URL edit.
		// Display the effective base (honoring a ?api= override) as the truth; the editable stored value differs only while a query override is active.
		if (!apiUrlEl.querySelector("input")) apiUrlEl.textContent = getApiBase();
		if (store.history.isPersistent()) {
			storageEl.textContent = "history saved";
			storageEl.title = "History is saved in this browser.";
		} else {
			storageEl.textContent = "session-only history";
			storageEl.title = "History is kept only for this session.";
		}
	};
	update(store);
	let apiEditing = false;
	let apiErrTimer: ReturnType<typeof setTimeout> | null = null;
	const hideApiError = (): void => {
		if (apiErrTimer != null) {
			clearTimeout(apiErrTimer);
			apiErrTimer = null;
		}
		if (apiErrEl) {
			apiErrEl.textContent = "";
			apiErrEl.classList.remove("show");
		}
	};
	const showApiError = (msg: string): void => {
		if (!apiErrEl) return;
		apiErrEl.textContent = msg;
		apiErrEl.classList.add("show");
		if (apiErrTimer != null) clearTimeout(apiErrTimer);
		apiErrTimer = setTimeout(hideApiError, 4000);
	};
	const endApiEdit = (): void => {
		apiEditing = false;
		clear(apiUrlEl);
		// Re-show the effective base after the edit closes, not the raw stored value, so a ?api= override stays visible as the truth.
		apiUrlEl.textContent = getApiBase();
		hideApiError();
	};
	const beginApiEdit = (): void => {
		if (apiEditing) return;
		apiEditing = true;
		clear(apiUrlEl);
		const input = document.createElement("input");
		input.type = "url";
		input.value = getConfigurableBase();
		input.spellcheck = false;
		input.autocomplete = "off";
		input.className = "api-url-input";
		input.setAttribute("aria-label", "API server URL");
		apiUrlEl.appendChild(input);
		input.focus();
		input.select();
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				try {
					store.setApiBase(input.value);
					endApiEdit();
				} catch (err) {
					showApiError(err instanceof Error ? err.message : String(err));
					input.focus();
				}
			} else if (e.key === "Escape") {
				endApiEdit();
			}
		});
		input.addEventListener("blur", () => {
			if (apiEditing) endApiEdit();
		});
	};
	apiUrlEl.addEventListener("click", beginApiEdit);
	return { el, update, storageTextEl, storageBarEl, storageFillEl };
}
