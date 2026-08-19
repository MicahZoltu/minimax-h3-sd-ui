// Application entry point.

import { createStore } from "./state.js";
import { resumeActiveJobs } from "./queue.js";
import { mount } from "./ui.js";

const root = document.getElementById("app");
if (!(root instanceof HTMLElement)) {
	throw new Error("App root element #app is missing.");
}
const store = createStore();
void (async () => {
	// Only after the queue is hydrated (so resumeActiveJobs sees the persisted serverIds) do we
	// re-attach to in-flight generations, then mount renders and the pump honours the active slot.
	await store.queueReady;
	resumeActiveJobs(store);
	mount(store, root);

	// Probe the server once to prefill sane defaults and surface connectivity.
	void store.fetchCapabilities();

	// Probe the server periodically so the online/offline indicator catches up when the server drops or recovers.
	// The tick is skipped while the tab is hidden, so background tabs do not waste requests.
	const CAPABILITIES_PROBE_MS = 30_000;
	const probe = () => {
		if (document.visibilityState === "visible") void store.fetchCapabilities();
	};
	setInterval(probe, CAPABILITIES_PROBE_MS);

	// When the tab becomes visible again, probe once immediately so the indicator reflects the current state.
	// The interval above then keeps probing every 30s for as long as the tab stays visible.
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") probe();
	});
})();
