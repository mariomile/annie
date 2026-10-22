# Clic sulla foto del browser

L'[ADR 0044](0044-browser-interno.md) ha messo il browser della conversazione in un pannello accanto alla chat e ha rimandato il clic sulla foto. Ora la persona clicca sulla pagina nel pannello, invece di chiedere all'agente di farlo.

## Decisione

- **Il clic sulla foto è un clic nella pagina.** Il pannello manda il punto cliccato come frazioni della foto mostrata (`POST …/browser {click: {x, y}}`, tra 0 e 1), così non conta quanto è grande la foto sullo schermo. Il server lo porta nella finestra della pagina (1280 per 800) e lo clicca nel browser di quella conversazione; poi il pannello si aggiorna da solo con la foto nuova.
- **Le stesse regole del clic dell'agente.** Passa dalla stessa coda delle azioni, dallo stesso fetch controllato (solo i siti consentiti, mai un indirizzo interno, solo GET) e dagli stessi blocchi: i moduli che inviano restano fermi e un clic su un caricamento di file è rifiutato. Chi guarda non ha più permessi dell'agente: nessuna approvazione aggirata, perché il browser non invia niente da solo.
- **Stessi controlli del pannello.** Sessione della persona, conversazione sua, e solo chi può scrivere all'agente in chat. Un punto fuori dalla foto (non un numero, o fuori da 0-1) è rifiutato prima di toccare il browser.
- **Come per la barra dell'indirizzo,** dopo un clic della persona i numeri dell'ultima vista dell'agente puntano altrove: `web_click` e `web_type` li rifiutano finché l'agente non riguarda la pagina.

## Alternative scartate

- **Coordinate in pixel della foto.** Dipendono da come il pannello la ridimensiona; le frazioni no.
- **Scrivere e scorrere dalla foto.** Non servono per cliccare un menu, un filtro o una scheda; si aggiungono se serve.

## Conseguenze

- Il clic sulla foto non è registrato nell'audit, come Indietro; l'apertura di una pagina da indirizzo sì.
- Un clic a coordinate non vede cosa c'è sotto come l'agente, che sceglie elementi numerati: può cliccare un pulsante che la pagina disegna in modo ingannevole. Il danno resta quello di un clic in un browser che legge soltanto.
- Il pannello non si prova senza Chromium: i test coprono il calcolo del punto, le regole e l'endpoint con un browser finto.
