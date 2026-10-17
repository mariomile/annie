# «Primi passi» e la console come app

Chi apre Annie la prima volta trova una chat che risponde con istruzioni generiche, e nessuna indicazione su cosa la rende utile: dirle chi è, collegare il telefono, lasciarla cercare sul web, invitare il team. E la console si usava solo da una scheda del browser, mentre sul telefono la si vuole aprire come un'app.

## Come funziona

- **I passi si leggono dalle impostazioni vere**, non da un elenco di spunte: `GET /api/instances/:id/setup` (solo owner) dice se il modello è vero, se l'owner ha scritto qualcosa di suo, se ha già avuto una risposta (non l'errore «Non sono riuscita a rispondere»), se un canale collegato ha qualcuno che può scrivere, se il web è consentito e se un'altra persona può scrivere a questa istanza. Senza chiamate di rete (i canali collegati sono letti dalla memoria del processo) e al più 5 conversazioni lette: la console lo chiede a ogni apertura, dopo aver disegnato la pagina.
- **Le parole dell'owner vanno dopo le istruzioni predefinite**, in un blocco «Informazioni su chi ti usa:» che un nuovo salvataggio sostituisce: così quello che Annie sa fare resta detto. Vale anche per una nuova istanza creata con delle istruzioni. Le istruzioni predefinite cambiano di versione in versione, quindi «scritte dall'owner» vuol dire: c'è il blocco, oppure il testo non comincia come le predefinite. Testo vuoto, segnaposto tra parentesi quadre rimasti dagli esempi, più di 2000 caratteri o le istruzioni e il blocco nella stessa richiesta sono rifiutati.
- **Quando si vedono**: l'owner atterra su «Primi passi» aprendo la console senza una pagina in mente finché non ha mai avuto una risposta da Annie; poi restano nel menu con il numero dei passi che può fare dalla console (il modello è dell'operatore, e alcuni browser non installano: non contano). Si nascondono per istanza e per browser, e si ritrovano in Impostazioni.
- **La console come app**: un manifest, icone (anche maskable e per iOS) e un service worker. Il service worker tiene solo la shell (pagina, script, stile, font, icone), chiede sempre prima alla rete e usa la copia solo senza rete; non tocca mai `/api`, `/oauth`, `/hooks` e `/login`, nemmeno aperti come pagina. La pagina tenuta per l'offline è l'ultima `/` aperta online. CSP: `manifest-src 'self'; worker-src 'self'`. `sw.js` è servito `no-cache`.
- **Senza server**: se la rete manca o il server non risponde, la console lo dice e riprova da sola ogni 10 secondi, con un pulsante Riprova; la barra «Sei offline» è un elemento `role=status`, non un'immagine di CSS.

## Alternative scartate

- **Un wizard obbligatorio a più schermate**: blocca chi vuole solo provare la chat; i passi in qualsiasi ordine, con le azioni dentro la pagina o un «Vai» che porta alla scheda giusta, costano meno.
- **Spunte salvate a mano**: dicono «fatto» anche quando il bot non risponde a nessuno; leggere le impostazioni vere no.
- **Sostituire le istruzioni predefinite con quelle dell'owner**: Annie perderebbe la descrizione dei suoi strumenti (sentinelle, ricerca, memoria) e li userebbe peggio.
- **Cache delle risposte `/api` per usare la console offline**: terrebbe sul telefono conversazioni e file, e servirebbe una coda di invii. Per ora la console offline dice solo che è offline.
- **Nascondere i passi sul server**: costa un campo nuovo nell'istanza; per ora il browser basta, e i passi si ritrovano in Impostazioni.

## Conseguenze

- Su iPhone l'app installata ha una sessione separata da Safari: la schermata di accesso accetta il link incollato.
- Il nome dell'app è «Annie» per tutti: chi usa due tenant di Annie Cloud sulla stessa Home li distingue solo dall'indirizzo.
- I passi non guardano Telegram e WhatsApp per «Scrivile qualcosa»: conta una risposta nella chat web.
