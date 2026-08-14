// Application entry point.

import { createStore } from "./state.js";
import { mount } from "./ui.js";

const root = document.getElementById("app");
if (!(root instanceof HTMLElement)) {
	throw new Error("App root element #app is missing.");
}
const store = createStore();
mount(store, root);

// Probe the server once to prefill sane defaults and surface connectivity.
void store.fetchCapabilities();
