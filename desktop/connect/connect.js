// The first page of the app: the server address, checked by the app (Rust), never by this page.
const { invoke } = window.__TAURI__.core;
const form = document.querySelector("form");
const input = document.querySelector("#server");
const error = document.querySelector("#error");
const button = form.querySelector("button");

const current = await invoke("current");
if (current) input.value = current;
input.focus();

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
