// The new-job form DOM builder and the .zip intake that fills it.
// Both take the store as input and neither reaches into any mount-closure transient state.

import { h, type Child } from "./dom.js";
import { frameDurationLabel, truncate } from "./format.js";
import { FALLBACK_DIMS, type Store } from "./state.js";
import { analyzeZip } from "./zip.js";

export function buildForm(store: Store): HTMLElement {
	const f = store.state.form;
	const labels: Record<string, string> = {
		prompt: "Text only",
		"start-end": "Start/End frames",
		refs: "Reference frames",
	};

	const notice: Child[] = f.analysis
		? [
			  h("div", { class: "badge" }, labels[f.analysis.mode] ?? f.analysis.mode),
			  h("div", { class: "analysis" }, [
				  h("div", { class: "analysis-row" }, [
					  h("span", { class: "key" }, "prompt"),
					  h("span", { class: "val prompt-preview" }, truncate(f.analysis.prompt, 240)),
				  ]),
				  f.analysis.files.length > 0
					  ? h("div", { class: "analysis-row" }, [
							h("span", { class: "key" }, "images"),
							h("div", { class: "thumbs" },
								f.analysis.files.map((file) =>
									h("img", { class: "thumb", src: file.dataUrl, alt: file.name, title: file.name, decoding: "async", "data-action": "view-image", "data-name": file.name }),
								)),
						])
					  : null,
			  ]),
		  ]
		: [];

	return h("div", { class: "inner" }, [
		h("h2", {}, "New generation"),
		h("div", { class: `dropzone ${f.parsing ? "busy" : ""}`, title: f.analysis ? (f.zipName ?? "zip loaded") : "Drop a .zip here or click to choose" }, [
			h("input", { id: "zipFile", type: "file", accept: ".zip,application/x-zip-compressed,application/zip", class: "hidden" }),
			h("div", { class: "dropzone-inner" }, [
				h("p", { class: "dz-title" }, f.analysis ? "Zip loaded" : "Drop a .zip here"),
				h("p", { class: "dz-sub" }, f.parsing ? "Reading zip…" : "or click to browse"),
			]),
		]),
		...notice,
		f.error ? h("div", { class: "form-error", role: "alert" }, f.error) : null,
		h("div", { class: "dims" }, [
			dimField("Width", "width", f.width, "width"),
			dimField("Height", "height", f.height, "height"),
			dimField("Frames", "frames", f.frames, "frames", frameDurationLabel(f.frames)),
			dimField("Steps", "steps", f.steps, "steps"),
		]),
		h("div", { class: "actions" }, [
			h("button", {
				class: "btn primary",
				type: "button",
				disabled: !f.analysis || f.parsing,
				"data-action": "add-queue",
			}, "Add to queue"),
		]),
	]);
}

export function dimField(label: string, name: string, value: number, aria: string, hint?: string): HTMLElement {
	return h("label", { class: "field" }, [
		h("span", {}, label),
		h("input", {
			type: "number",
			name: name,
			value: String(value),
			min: "1",
			step: "1",
			"data-dim": name,
			"aria-label": aria,
		}),
		hint ? h("span", { class: "field-hint", "data-dim-hint": name }, hint) : null,
	]);
}

export async function handleZipFile(store: Store, file: File): Promise<void> {
	store.setForm({ parsing: true, error: null });
	try {
		const analysis = await analyzeZip(file, file.name);
		const form = store.state.form;
		// Prefill dimensions from server defaults only if the user has not customized them (fields are still at the fallback values).
		const caps = store.state.caps?.defaults_by_mode?.vid_gen;
		store.setForm({
			analysis,
			zipName: file.name,
			parsing: false,
			width: form.width === FALLBACK_DIMS.width && caps?.width ? caps.width : form.width,
			height: form.height === FALLBACK_DIMS.height && caps?.height ? caps.height : form.height,
		});
	} catch (err) {
		store.setForm({ parsing: false, error: err instanceof Error ? err.message : String(err) });
	}
}
