// Minimal hyperscript helper.
// Values are always placed via createTextNode / element properties, never via innerHTML, so app-provided strings (prompts, file names) cannot be injected as markup.

export type Child = string | Node | null | undefined | Child[];

export function h(
	tag: string,
	attrs: Record<string, unknown> = {},
	children: Child = [],
): HTMLElement {
	const el = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs)) {
		if (value === false || value == null) continue;
		if (key === "class") {
			el.className = String(value);
			continue;
		}
		if (key === "value") {
			if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
				el.value = String(value);
			}
			continue;
		}
		if (key === "autoplay" || key === "muted" || key === "loop" || key === "playsinline" || key === "controls" || key === "disabled" || key === "open" || key === "checked") {
			if (value === true) el.setAttribute(key, "");
			continue;
		}
		if (typeof value === "boolean") {
			if (value) el.setAttribute(key, "");
			continue;
		}
		el.setAttribute(key, String(value));
	}
	appendChildren(el, children);
	return el;
}

function appendChildren(el: HTMLElement, children: Child): void {
	if (Array.isArray(children)) {
		for (const c of children) appendChildren(el, c);
		return;
	}
	if (children == null) return;
	if (typeof children === "string") {
		el.appendChild(document.createTextNode(children));
	} else {
		el.appendChild(children);
	}
}

export function clear(el: HTMLElement): void {
	el.replaceChildren();
}
