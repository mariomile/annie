# Lo schermo: un desktop per agente, con Cua

Mario (17 ottobre 2026): «computer use e browser use con Cua». Annie aveva già un terminale senza rete ([ADR 0013](0013-terminale-in-un-computer-senza-rete.md), [ADR 0015](0015-computer-su-micro-vm.md)) e un browser che legge, clicca e scrive nei siti consentiti ([ADR 0014](0014-browser-con-clic-nella-cella.md)). Mancava un desktop vero: una finestra da guardare, un mouse e una tastiera, i programmi che non hanno una pagina web, i siti che il browser della cella non riesce a usare.

Lo schermo è quel desktop. Ogni agente ne ha uno suo: un Linux con XFCE e Firefox, dove Annie guarda lo schermo e clicca, scrive, preme tasti, scorre e apre programmi o indirizzi. Lo guida attraverso [Cua](https://github.com/trycua/cua), che dà un desktop già pronto in un'immagine Docker e un demone che lo comanda via MCP.

## Decisione

- **Cua come immagine separata, non come codice nostro.** Annie avvia `trycua/cua-xfce:0.3.0` (tag fisso, mai `latest`; solo amd64, circa 8 GB) come container a parte e parla con il suo demone `cua-spacesd` sulla porta 3211: `GET /health` per sapere se è pronto, `POST /mcp` per i comandi. Non copiamo né distribuiamo il codice di Cua (licenza FSL-1.1-MIT per il demone): usiamo l'immagine che pubblicano.
- **Un client MCP minimo, nostro** (`src/desktop/mcp-client.ts`): JSON-RPC 2.0 su HTTP, `initialize` e `notifications/initialized` prima di tutto, l'intestazione `Mcp-Session-Id` del server rimandata a ogni richiesta, l'elenco degli strumenti chiesto una volta, un tempo massimo per richiesta, una sessione che il server ha dimenticato riaperta una volta. Le risposte sono JSON; legge anche un event stream, per i server che rispondono così. I connettori tengono l'SDK completo: qui bastano poche richieste a un demone che Annie avvia da sé.
- **Il controllo degli strumenti.** Prima di chiamare uno strumento di Cua (`get_desktop_state`, `click`, `type_text`, `press_key`, `hotkey`, `scroll`, `get_screen_size`, `launch_app`) Annie guarda se il demone lo offre. Se manca, lo dice in chiaro invece di fallire a metà: l'immagine pubblicata può differire dal codice di Cua su `main`.
- **Sei tool** (`src/core/tools/desktop-tools.ts`), offerti solo se il server ha lo schermo:
  - `desktop_look`: una foto dello schermo, che arriva al modello come immagine (al più 1280 pixel di lato), con il testo che il desktop accompagna, recintato come dati.
  - `desktop_click` (x, y, tasto, doppio clic), `desktop_type` (testo dove sta il cursore), `desktop_key` (un tasto, o una combinazione come `ctrl+l` che diventa `hotkey`), `desktop_scroll` (direzione, passi, punto), `desktop_open` (un programma per nome, o un indirizzo nel browser dello schermo).
  - Dopo ogni azione Annie riceve lo schermo com'è adesso: vede subito l'effetto, senza un `desktop_look` in più.
  - Le coordinate si leggono sull'immagine. Lo schermo Docker è 1280×800, la stessa misura della foto, quindi coincidono. Uno schermo più grande (quello remoto) arriva rimpicciolito: Annie riporta le coordinate alla misura vera con le dimensioni originali che Cua manda con la foto o, dopo un riavvio, con `get_screen_size`. Non usa il `capture_id` di Cua per questo: il conto lo fa il codice nostro, e si prova nei test.
- **L'owner accende lo schermo agente per agente** (Impostazioni, «Schermo»), spento di default: è il connettore `schermo` nella egress policy, letto a ogni chiamata come per il computer. L'operatore lo rende disponibile con `ANNIE_DESKTOP`.
- **Due fornitori.**
  - `ANNIE_DESKTOP=docker`: un container per agente sul server Docker di Annie, con il nome da un hash di tenant e agente come il computer. Token del demone (`CUA_ENV_TOKEN`) e password VNC (`VNC_PW`, senza la quale noVNC non ne chiede una) casuali per ogni container: stanno nelle impostazioni del container, e dopo un riavvio Annie li rilegge da Docker. 3 GB di memoria, 2 CPU, 1 GB di `/dev/shm` per Firefox, niente escalation di privilegi, alcune capability tolte, nessuna porta pubblicata sul server. Al massimo 4 schermi accesi; uno senza azioni per 15 minuti si ferma.
  - `ANNIE_DESKTOP=remote`: un solo demone di Cua che qualcuno fa girare altrove, con `ANNIE_DESKTOP_URL` (https) e `ANNIE_DESKTOP_TOKEN`. **È lo stesso schermo per tutti gli agenti che lo usano**: la console lo dice, e non lo si riavvia da Annie.
- **La rete dello schermo Docker.** Annie mette gli schermi su una rete Docker sua. Di default è `annie-desktop`, **interna**: niente internet, e il browser dello schermo apre solo quello che c'è dentro. Con `ANNIE_DESKTOP_NETWORK=internet` l'operatore sceglie `annie-desktop-internet`, che arriva a internet: serve per usare il web dal Firefox dello schermo. Quando Annie crea la rete, spegne il traffico fra container, così lo schermo di un agente non vede quello di un altro. Annie raggiunge il demone all'indirizzo del container su quella rete. Una rete con quel nome che esiste già deve essere interna o no come dice l'operatore, altrimenti Annie si ferma e lo dice.

## Cosa resta fuori dalle regole del resto di Annie

Lo diciamo chiaro, perché è la differenza con il browser della cella.

- **Con internet, il browser dello schermo non segue l'elenco dei siti consentiti dell'agente.** Il browser della cella passa da un fetch che controlla ogni richiesta; quello dello schermo esce dalla rete Docker. È una scelta dell'operatore (`ANNIE_DESKTOP_NETWORK=internet`) più quella dell'owner, agente per agente. La card in Impostazioni lo scrive.
- **Quello che Annie fa sullo schermo non passa dalle approvazioni.** Un modulo inviato, una mail mandata, un acquisto, un accesso a un account dentro lo schermo non diventano una card da approvare, perché per Annie sono clic e tasti. Le descrizioni dei tool dicono al modello di fermarsi e chiedere alla persona in chat prima di inviare, pagare, accettare condizioni o accedere a qualsiasi account, e di non scrivere mai password. È un'istruzione, non un blocco: per questo lo schermo è spento di default e senza internet di default.
- **Quello che c'è sullo schermo sono dati, non istruzioni.** Una pagina o una mail aperta può contenere testo scritto per far fare qualcosa ad Annie; il testo che accompagna la foto arriva recintato con un'etichetta casuale, e le descrizioni dei tool lo ripetono.

## Audit

Una riga per azione (`desktop.action` con il tipo: clic, scrittura, tasto, scorrimento, apertura), mai il testo scritto né l'indirizzo aperto: della scrittura resta solo quanti caratteri, dell'apertura se era un programma o un indirizzo. Gli errori del desktop vanno nel log dell'operatore; al modello arriva una frase semplice e nell'audit `desktop.failed`. Accensione e riavvio dalla console hanno le loro righe (`desktop.allowed`, `desktop.reset`).

## Ripetizioni dopo un crash

Come `web_click`: ogni azione gira dentro un passo durevole, quindi un'azione finita non si ripete quando la chiamata riparte dopo un crash. Un crash nel mezzo di un'azione può ripeterla (un clic in più, un testo scritto due volte). La foto dopo l'azione si rifà sempre: guardare non cambia niente.

## Limiti voluti

- Niente vista dal vivo nella console: l'owner non vede lo schermo mentre Annie lo usa. Il VNC c'è dentro il container, con la sua password, ma non è pubblicato.
- Niente file fra workspace e schermo: lo schermo non ha `/work`, e Cua non ha uno strumento per i file via MCP. Per i file c'è il computer.
- Solo amd64, perché così è l'immagine di Cua. `pnpm annie check` lo dice su un server ARM.
- In Annie Cloud lo schermo resta spento: una cella non ha il socket di Docker, e lo schermo remoto condiviso non va bene fra tenant diversi.
- Nella chat del brief del mattino i tool dello schermo non girano, come tutti i tool che non sono di sola lettura.

## Alternative scartate

- **L'SDK di Cua (Python) o il loro agente**: porterebbe un secondo runtime e un secondo modello dentro Annie. A noi serve solo il desktop: il modello resta quello dell'agente.
- **Il desktop nel computer di ADR 0013**: il computer non ha rete per scelta, e un desktop con Firefox ha senso proprio quando può averla. Due macchine diverse, accese separatamente dall'owner.
- **Il traffico dello schermo attraverso il fetch controllato della cella**, per tenere l'elenco dei siti: servirebbe un proxy per ogni schermo con TLS da ispezionare. Prima lo schermo spento di default e la scelta esplicita dell'operatore; un proxy si può aggiungere dopo.
- **Approvazione per ogni clic**: renderebbe lo schermo inutilizzabile, e un clic da solo non dice cosa invia.
- **Porte pubblicate sul server** per raggiungere il demone: con una rete interna Docker non funzionano, e con una normale esporrebbero il demone e il VNC fuori da Docker.

## Conseguenze

- Come per il computer, il processo di Annie che usa il socket di Docker equivale a root sul server: lo schermo Docker va acceso solo dove Annie è l'unico servizio.
- Annie deve raggiungere l'indirizzo del container sulla rete degli schermi. Annie installata direttamente sul server Linux lo raggiunge. Annie in Docker Compose deve stare anche lei su quella rete: il runbook (6n) spiega come, e in quel caso la rete va creata con il traffico fra container acceso, altrimenti Annie stessa non arriva agli schermi.
- Con internet, lo schermo raggiunge anche la rete locale e le porte del server aperte su tutte le interfacce. L'operatore che lo accende lo sa, e il runbook lo ripete.
- Da provare dal vivo, su un server amd64 con Docker vero: l'avvio dell'immagine con le capability tolte e senza escalation di privilegi, il tempo di avvio, che il server raggiunga l'indirizzo del container su una rete interna, e che la versione 0.3.0 del demone offra gli strumenti e le dimensioni originali come previsto.
