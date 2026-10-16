// Annie Cloud: sign up and sign in by email link. Text is set with textContent only.

const $status = document.getElementById("status");
const $form = document.getElementById("signup");

async function post(path, body) {
	const res = await fetch(path, { method: "POST", headers: { "x-annie": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error ?? `Errore ${res.status}`);
	return data;
}

if (location.pathname === "/verify") {
	const token = location.hash.slice(1);
	history.replaceState(null, "", "/verify");
	$form.hidden = true;
	document.getElementById("title").textContent = "Un momento";
	document.getElementById("lead").textContent = "Sto preparando la tua Annie. La prima volta può volerci qualche secondo.";
	post("/api/verify", { token })
		.then(({ loginUrl }) => location.replace(loginUrl))
		.catch((error) => {
			document.getElementById("title").textContent = "Il link non funziona";
			$status.textContent = error.message;
			$form.hidden = false;
		});
}

$form.addEventListener("submit", async (event) => {
	event.preventDefault();
	const email = document.getElementById("email").value.trim();
	$status.textContent = "";
	try {
		await post("/api/signup", { email });
		$form.hidden = true;
		document.getElementById("title").textContent = "Controlla la posta";
		document.getElementById("lead").textContent = `Ti ho mandato un link per entrare a ${email}. Vale 30 minuti.`;
	} catch (error) {
		$status.textContent = error.message;
	}
});
