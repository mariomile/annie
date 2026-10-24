// The first page of the app: the server address, checked by the app (Rust), never by this page.
const { invoke } = window.__TAURI__.core;
const form = document.querySelector("form");
const input = document.querySelector("#server");
const error = document.querySelector("#error");
const button = form.querySelector("button");
const local = document.querySelector("#locale");

// The app reloads this page when Owni on this computer is ready or did not start.
const state = await invoke("state");
document.querySelector(state.starting ? "#avvio" : "#collega").hidden = false;
if (state.current) input.value = state.current;
if (state.error) {
	error.textContent = state.error;
	error.hidden = false;
}
local.hidden = !state.local;
if (!state.starting) input.focus();

local.addEventListener("click", async () => {
	local.disabled = true;
	try {
		await invoke("use_local");
	} catch (message) {
		error.textContent = String(message);
		error.hidden = false;
		local.disabled = false;
	}
});

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	error.hidden = true;
	button.disabled = true;
	button.textContent = "Controllo…";
	try {
		// On success the app opens the server in this window: nothing else to do here.
		await invoke("connect", { input: input.value });
	} catch (message) {
		error.textContent = String(message);
		error.hidden = false;
		button.disabled = false;
		button.textContent = "Collega";
		input.focus();
	}
});
