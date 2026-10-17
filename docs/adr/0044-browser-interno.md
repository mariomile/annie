# Browser interno nella chat

Mario (17 ottobre 2026): «aggiungiamo anche un browser interno che gli agenti possono utilizzare». Gli agenti hanno già un browser per conversazione (`web_browse`, ADR 0014), ma la persona non lo vede: legge solo quello che l'agente ne riferisce, e per indicargli una pagina deve copiare un indirizzo in chat.

## Decisione

- **Lo stesso browser, visto dalla chat.** Accanto alla conversazione della console c'è un pannello «Browser» con la pagina che l'agente ha aperto in quella conversazione. Si apre da solo la prima volta che l'agente comincia a navigare (una volta per conversazione: se la persona lo chiude resta chiuso; sul telefono, dove coprirebbe la chat, compare invece un pallino sul pulsante), e dal pulsante «Browser» in alto. Non è un secondo browser: è la sessione di `web_browse` di quella conversazione, chiave `sessionKey("<tenant>/<agente>", web:<thread>)`.
- **La persona lo guida.** Barra dell'indirizzo e Indietro: quello che la persona apre è la pagina che l'agente vede con `web_browse` senza url, così può dirgli «leggi questa». Stessa lista di siti dell'owner, stessa guardia su ogni richiesta, stesso blocco di ogni invio: chi guarda non ha più permessi dell'agente. Solo chi può scrivere all'agente in chat lo guida; l'audit tiene `web.browser.opened` con il sito e l'esito (anche i rifiuti), mai l'indirizzo intero. Dopo una pagina aperta dalla persona i numeri dell'ultima vista dell'agente puntano altrove: `web_click` e `web_type` li rifiutano finché l'agente non riguarda la pagina.
- **Guardare non cambia la pagina.** `BrowseSessions` conta le azioni (`version`), tiene indirizzo e titolo dell'ultima azione (lo stato non chiede niente a Chromium) e fa una foto dello schermo solo dopo un'azione, mai mentre l'agente agisce: i numeri degli elementi della sua ultima vista restano validi e l'agente non aspetta chi guarda. La console chiede lo stato ogni 2 secondi con il pannello aperto o nei due minuti dopo un messaggio, e ogni 8 altrimenti, e scarica la foto solo quando la versione cambia; mostra quando l'agente sta usando il browser, e dice se Chromium su questo server non parte.
- **Solo la console.** Su Telegram e WhatsApp il browser resta quello che l'agente racconta, con lo screenshot se serve.
- **API.** `GET /api/instances/:id/threads/:thread/browser` (stato), `GET …/browser.png` (la foto), `POST …/browser {url}` o `{back: true}`. Solo per le conversazioni della persona stessa.

## Alternative scartate

- **Uno streaming video dello schermo** (CDP screencast o VNC): più vivo, ma un flusso continuo per ogni chat aperta, e il browser di Annie non ha uno schermo da trasmettere tra un'azione e l'altra. Le foto dopo ogni azione mostrano tutto quello che cambia.
- **Clic sulla foto per cliccare nella pagina.** Utile, ma porta clic a coordinate in un browser pensato per elementi numerati e controllati (password, file, invii). Rimandato: per ora la persona guida con l'indirizzo e chiede all'agente il resto.

## Conseguenze

- Il pannello funziona solo dove c'è Chromium (come `web_browse`); altrimenti dice che il browser non c'è.
- Una persona e l'agente possono agire insieme sulla stessa pagina: le azioni vanno in coda, una alla volta, e dopo una pagina aperta dalla persona l'agente deve riguardarla prima di cliccare.
- Il messaggio «non è tra i siti che questa istanza può leggere» diventa «… che questo agente può leggere», ovunque.
