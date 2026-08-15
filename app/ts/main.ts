// Application entry point.

import { createStore } from "./state.js";
import { resumeActiveJobs } from "./queue.js";
import { mount } from "./ui.js";

const root = document.getElementById("app");
if (!(root instanceof HTMLElement)) {
	throw new Error("App root element #app is missing.");
}
const store = createStore();
// Re-attach to any generation that was in flight before a page reload before mount lets the pump pick the next job.
resumeActiveJobs(store);
mount(store, root);

// Probe the server once to prefill sane defaults and surface connectivity.
void store.fetchCapabilities();
