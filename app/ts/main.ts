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
})();
