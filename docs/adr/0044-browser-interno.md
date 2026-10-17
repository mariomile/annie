# Browser interno nella chat

Mario (17 ottobre 2026): «aggiungiamo anche un browser interno che gli agenti possono utilizzare». Gli agenti hanno già un browser per conversazione (`web_browse`, ADR 0014), ma la persona non lo vede: legge solo quello che l'agente ne riferisce, e per indicargli una pagina deve copiare un indirizzo in chat.

## Decisione

- **Lo stesso browser, visto dalla chat.** Accanto alla conversazione della console c'è un pannello «Browser» con la pagina che l'agente ha aperto in quella conversazione. Si apre da solo la prima volta che l'agente comincia a navigare (una volta per conversazione: se la persona lo chiude resta chiuso), e dal pulsante «Browser» in alto. Non è un secondo browser: è la sessione di `web_browse` di quella conversazione, chiave `sessionKey("<tenant>/<agente>", web:<thread>)`.
- **La persona lo guida.** Barra dell'indirizzo e Indietro: quello che la persona apre è la pagina che l'agente vede con `web_browse` senza url, così può dirgli «leggi questa». Stessa lista di siti dell'owner, stessa guardia su ogni richiesta, stesso blocco di ogni invio: chi guarda non ha più permessi dell'agente. Solo chi può scrivere all'agente lo guida; l'audit tiene `web.browser.opened` con il sito, mai l'indirizzo intero.
- **Guardare non cambia la pagina.** `BrowseSessions` conta le azioni (`version`) e fa una foto dello schermo solo dopo un'azione, in coda con le azioni dell'agente: i numeri degli elementi della sua ultima vista restano validi. La console chiede lo stato ogni 2,5 secondi mentre la chat è a schermo (una domanda leggera, senza foto) e scarica la foto solo quando la versione cambia e il pannello è aperto.
- **Solo la console.** Su Telegram e WhatsApp il browser resta quello che l'agente racconta, con lo screenshot se serve.
- **API.** `GET /api/instances/:id/threads/:thread/browser` (stato), `GET …/browser.png` (la foto), `POST …/browser {url}` o `{back: true}`. Solo per le conversazioni della persona stessa.

## Alternative scartate

- **Uno streaming video dello schermo** (CDP screencast o VNC): più vivo, ma un flusso continuo per ogni chat aperta, e il browser di Annie non ha uno schermo da trasmettere tra un'azione e l'altra. Le foto dopo ogni azione mostrano tutto quello che cambia.
- **Clic sulla foto per cliccare nella pagina.** Utile, ma porta clic a coordinate in un browser pensato per elementi numerati e controllati (password, file, invii). Rimandato: per ora la persona guida con l'indirizzo e chiede all'agente il resto.

## Conseguenze

- Il pannello funziona solo dove c'è Chromium (come `web_browse`); altrimenti dice che il browser non c'è.
- Una persona e l'agente possono agire insieme sulla stessa pagina: le azioni vanno in coda, una alla volta, e l'agente si accorge che la pagina è cambiata e la riguarda.
- Il messaggio «non è tra i siti che questa istanza può leggere» diventa «… che questo agente può leggere», ovunque.
