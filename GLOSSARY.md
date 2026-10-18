# Annie

Piattaforma open source di agenti sempre attivi per aziende attente a privacy e controllo dei processi: ogni cliente ha i suoi agenti, che parlano con le persone sui canali, usano i sistemi dell'azienda e non fanno nulla di irreversibile senza un'approvazione.

## Chi

**Owner**:
Chi gestisce un tenant: in self-host chi installa Annie (Buildrs o l'IT del cliente), in Annie Cloud chi si registra. Crea istanze e decide cosa possono raggiungere.
_Avoid_: admin, superuser

**Operatore**:
Chi gestisce Annie Cloud per tutti i tenant (Buildrs). Non legge le conversazioni nel lavoro normale; può entrare in una cella come owner solo lasciando traccia nell'audit della cella, e non se l'owner ha la verifica in due passaggi.
_Avoid_: admin, owner

**Tenant**:
Un cliente (azienda, studio o professionista), con dati, segreti, audit e spesa separati da tutti gli altri.
_Avoid_: cliente (nel codice), account, workspace

**Istanza**:
Un agente di un tenant, con il suo modello, le sue conversazioni, i suoi connettori, i suoi file e le sue regole di uscita. Nella console e nei testi per le persone si chiama **agente** (ADR 0041).
_Avoid_: bot, profilo; «istanza» nei testi per le persone

**Agente**:
Un'istanza vista da chi la usa: ha un nome, una faccia (un'emoji), un compito in una riga e un tono, e con loro la sua memoria, i suoi task, file, connettori e bot. Ognuno si presenta con il suo nome. L'owner lo elimina da Impostazioni scrivendone il nome (tranne il principale e la segreteria). Vedi ADR 0041 e 0046.
_Avoid_: bot, assistente (quando si intende uno degli agenti), GPT

**Board**:
La pagina della console con le cose da fare del tenant: schede in quattro colonne (Da fare, In corso, Da rivedere, Fatto), ognuna affidabile a un agente. L'agente ci lavora in una conversazione con chi gliel'ha affidata e la manda in «Da rivedere»; la chiude una persona. Vedi ADR 0049.
_Avoid_: kanban (nei testi per le persone), backlog, issue tracker

**Scheda** (della board):
Una cosa da fare sulla board, con numero (#12), titolo, descrizione, priorità, l'agente a cui è affidata e la sua cronologia di spostamenti e commenti. Vedi ADR 0049.
_Avoid_: issue, ticket, card, task (che è un'istruzione programmata)

**Messaggio tra agenti**:
Una richiesta che un agente manda a un altro con `agent_message`, solo se l'owner ha permesso al secondo di ricevere messaggi dal primo. La risposta torna dopo, nella conversazione da cui era partita la domanda. Al più tre agenti in fila, senza giri. Vedi ADR 0042.
_Avoid_: chat tra bot, handoff, delega

**Personalità**:
Emoji, compito e tono di un agente, scelti dall'owner; il modello li riceve dopo le istruzioni, in un blocco «Chi sei». Il tono è uno tra naturale, formale, amichevole, conciso e scherzoso (in console «Spiritoso»).
_Avoid_: persona (nei testi per le persone), prompt, carattere

**Utente consentito**:
Una persona che può parlare con un'istanza su un canale. Chi non è nella lista non riceve risposta.
_Avoid_: user, membro

**Approvatore**:
Utente consentito che può approvare le azioni di un'istanza. Nella segreteria è il commerciale.
_Avoid_: admin, supervisore

**Link personale**:
Il link con cui una persona entra nella console web. È la sua chiave: chi lo ha entra come lei. Rigenerarlo chiude le sessioni aperte.
_Avoid_: password, invito

**Console**:
Le pagine web di Annie, per l'owner e le persone. Si apre dal browser o si installa come app (sulla schermata Home o sul desktop, a schermo intero); senza rete l'app mostra solo che è offline, mai dati salvati.
_Avoid_: dashboard, PWA (nei testi per le persone)

**Primi passi**:
La pagina che l'owner trova aprendo la console finché non ha provato Annie: i passi che la rendono utile (modello, istruzioni, primo messaggio, telefono, web, team, app), ciascuno «fatto» quando le impostazioni vere lo dicono. Si nascondono per istanza, in quel browser, e si ritrovano in Impostazioni.
_Avoid_: onboarding, wizard, setup

**Verifica in due passaggi**:
Per chi la attiva, il link personale da solo non basta: serve anche il codice di sei cifre dell'app di autenticazione del telefono (TOTP). L'owner può toglierla a chi ha perso il telefono.
_Avoid_: MFA, OTP (nei testi per le persone)

## Dove gira

**Self-host**:
Annie installata dal cliente sul suo server, gestita dall'Owner.
_Avoid_: on-prem (nei testi per le persone)

**Annie Cloud**:
Annie offerta come servizio da Buildrs: ogni tenant ha la sua cella, con dati in Unione Europea.
_Avoid_: SaaS, versione online

**Cella**:
L'ambiente isolato di un tenant in Annie Cloud: lo stesso Annie del self-host, con il suo disco e separato dagli altri tenant, che si spegne quando non lavora.
_Avoid_: container, pod, istanza (un'istanza è un agente, dentro la cella)

**Control plane**:
La parte di Annie Cloud comune a tutti i tenant: registrazione, pagamento, smistamento dei messaggi alla cella giusta, risveglio delle celle. Inoltra i messaggi senza conservarli.
_Avoid_: backend, piattaforma

**Periodo di prova**:
I primi giorni di un tenant in Annie Cloud, gratuiti. Finiti senza abbonamento, la cella resta spenta con i dati intatti.
_Avoid_: trial, freemium, piano gratuito

**Abbonamento**:
Quello che un tenant paga ogni mese per Annie Cloud dopo la prova: una quota fissa e, se previsto, il consumo del modello.
_Avoid_: piano, licenza, subscription

## Conversazioni

**Canale**:
Un luogo dove le persone parlano con un'istanza: Telegram, WhatsApp, il telefono, l'interfaccia web.
_Avoid_: gateway, integrazione

**Thread**:
Una conversazione su un canale: una chat Telegram, una chat nell'interfaccia web.
_Avoid_: sessione, chat (nel codice)

**Chiamata**:
Una telefonata al numero Twilio di un'istanza, a turni: la persona parla, Annie risponde a voce. Il thread è il numero di chi chiama, quindi una chiamata continua la conversazione delle precedenti.
_Avoid_: sessione vocale

**Risposta**:
Il messaggio con cui un'istanza chiude un messaggio ricevuto. Arriva almeno una volta, e può arrivare due volte dopo un crash.
_Avoid_: output, reply (in italiano)

**Possibile doppione**:
Un messaggio rimandato dopo un crash che la persona potrebbe aver già ricevuto; viene sempre segnalato.

## Capacità

**Tool**:
Un'azione che il modello di un'istanza può chiamare. Può essere integrato, venire da un connettore o essere scritto dall'istanza stessa.
_Avoid_: funzione, skill, plugin

**Connettore**:
Il collegamento configurato tra un'istanza e un sistema esterno (un server MCP, Gmail, HubSpot), con i suoi segreti e i suoi host. Porta dei tool all'istanza.
_Avoid_: integrazione, adapter (fuori dal codice), plugin

**Tool proposto**:
Un tool scritto dall'istanza che non può essere usato finché un approvatore non lo approva.
_Avoid_: tool generato, skill autogenerata

**Workspace**:
I file di un'istanza: quelli che crea, quelli che le persone le caricano, quelli che invia.
_Avoid_: disco, storage, cartella

**Immagine**:
Una foto o un'immagine che l'istanza guarda: quelle che le persone mandano in un messaggio (al massimo 4, fino a 20 MB ciascuna, JPEG, PNG, GIF o WebP riconosciute dal contenuto, rimpicciolite se il modello le vuole più piccole) e quelle del workspace che riapre da sola. Restano nel workspace sotto `uploads/`.
_Avoid_: allegato (è qualunque file), media, vision

**Documento**:
Un PDF, Word, Excel, PowerPoint o OpenDocument nel workspace, di solito mandato da una persona. Annie ne legge il testo con `file_read`: pagine, fogli e diapositive restano distinti, la formattazione no. Una scansione non ha testo da leggere. Vedi ADR 0026.
_Avoid_: allegato (è qualunque file), file binario

**Scansione**:
Un PDF fatto di immagini delle pagine, senza testo: lo scanner dell'ufficio, un fax, una foto salvata in PDF. Annie ne guarda le pagine con `image_view` e legge da sé. Vedi ADR 0028.
_Avoid_: OCR (Annie non fa OCR, guarda), PDF immagine

**Documento creato**:
Un file Word, Excel o PDF che Annie scrive nel workspace con `document_create`, partendo da Markdown o da un CSV: un preventivo, una lettera, un listino, un report. Lo manda con `file_send`. Vedi ADR 0029.
_Avoid_: export, report (il report di ricerca è un'altra cosa, ADR 0022), template

**Grafico**:
Un'immagine PNG a barre, a linee o a torta che Annie disegna con `chart_create` da numeri o da un CSV, in `grafici/`: la manda in chat come una foto o la mette in un documento. Vedi ADR 0030.
_Avoid_: chart, plot, diagramma

**Domanda a una tabella**:
Una richiesta che Annie fa con `table_query` a un CSV, un Excel o un foglio OpenDocument del workspace: filtri, gruppi, totali, medie, classifiche, calcolati in codice e mai a mente. La risposta può essere salvata in un CSV per un grafico o un documento. Vedi ADR 0031.
_Avoid_: query, analisi dati, pivot

**Calcolo**:
L'aritmetica che Annie fa con `calculate` (un preventivo, l'IVA, uno sconto, una divisione), riga per riga e con i nomi, al centesimo. Vedi ADR 0031.
_Avoid_: calcolatrice, eval, formula

**Registrazione**:
Un file audio o video più lungo di un vocale (una riunione, una chiamata, una lezione) che Annie tiene nel workspace e trascrive con `audio_transcribe`, a pezzi di dieci minuti. Vedi ADR 0033.
_Avoid_: audio lungo, file vocale, recording

**Trascrizione**:
Il file Markdown in `trascrizioni/` con il testo di una registrazione, l'ora di ogni passaggio e, se il servizio le distingue, le voci (Voce 1, Voce 2). Vedi ADR 0033.
_Avoid_: transcript, sbobinatura

**Ricerca nei file**:
Quello che fa `file_search`: le parole chiave della domanda cercate dentro il testo di tutti i file del workspace (documenti, trascrizioni, note) e nei loro nomi, con i passaggi trovati e il punto da cui leggere il seguito. Senza accenti e maiuscole, all'inizio delle parole. Vedi ADR 0035.
_Avoid_: ricerca full-text, indice, grep

**Lista**:
Un elenco che Annie tiene per chi le scrive (la spesa, le cose da fare, i regali), con voci da fare e fatte, numerate come le mostra `list_show`. Di una persona sola, o condivisa con tutti quelli che scrivono all'istanza quando lo chiedono; in un gruppo solo le condivise. Vedi ADR 0038.
_Avoid_: checklist, todo, elenco puntato

**Meteo**:
Quello che dà `weather`: le condizioni di adesso, le fasce di oggi e domani (notte, mattina, pomeriggio, sera) e le previsioni giorno per giorno fino a 16 giorni compreso oggi, per un posto cercato per nome. Acceso dall'operatore con `ANNIE_WEATHER`. Vedi ADR 0039.
_Avoid_: previsioni del tempo (quando si intende il tool), forecast

**Cambio BCE**:
Il tasso di riferimento dell'euro pubblicato dalla Banca Centrale Europea nei giorni lavorativi verso le 16:00, che `exchange_rate` usa per convertire importi, oggi o alla data di una fattura. Per un giorno senza pubblicazione vale l'ultimo giorno lavorativo prima. Acceso dall'operatore con `ANNIE_EXCHANGE_RATES`. Vedi ADR 0040.
_Avoid_: tasso di mercato, quotazione (quando si intende il cambio BCE)

**Feed di notizie**:
Il file RSS o Atom pubblico di un giornale, da cui `news_headlines` prende i titoli recenti con fonte, ora e link. La lista la sceglie l'operatore (`ANNIE_NEWS_FEEDS`), con una di partenza; acceso con `ANNIE_NEWS`. Vedi ADR 0043.
_Avoid_: notiziario, rassegna stampa (quando si intendono i titoli dei feed)

**VIES**:
Il servizio della Commissione europea che dice se un numero IVA è attivo per gli scambi intra-UE, con nome e indirizzo quando il paese li dà; `vat_check` lo usa con `ANNIE_VAT_CHECK`. «Non attiva nel VIES» non vuol dire che la partita IVA non esista. Vedi ADR 0047.
_Avoid_: registro delle partite IVA, anagrafe tributaria

**Scadenza fine mese**:
Una scadenza di fattura come «60 gg d.f.f.m.»: Annie conta i giorni dalla data fattura e poi va all'ultimo giorno del mese; alcuni gestionali contano invece a mesi, e `date_calc` dà anche quella data quando è diversa. Una scadenza festiva non viene spostata. Vedi ADR 0048.
_Avoid_: fine mese commerciale, scadenza a 30 giorni come mese

**Partita IVA da ricontrollare**:
Una partita IVA scritta dal cliente in una mail che non supera il controllo formale: la segreteria non la salva e nella bozza chiede di ricontrollarla (dato mancante `vatNumberInvalid`). Non usa il VIES. Vedi ADR 0049.
_Avoid_: partita IVA inesistente, partita IVA non attiva

**Download**:
Un file del web salvato da Annie nel workspace, sotto `download/`, con `web_download`: per leggerlo tutto o mandarlo. Solo dai siti consentiti, fino a 20 MB. Vedi ADR 0027.
_Avoid_: allegato, scaricamento

**Task programmato**:
Un'istruzione che un'istanza esegue da sola a un'ora stabilita, una volta o a ripetizione, consegnando il risultato a un thread.
_Avoid_: cron, job, promemoria, routine

**Memoria**:
Le cose che un'istanza ricorda di una persona tra una conversazione e l'altra, su sua richiesta o perché la persona le ha dette; valgono solo quando parla con lei da sola, e la persona le vede, le aggiunge e le cancella. Una memoria condivisa vale per tutti quelli che scrivono all'istanza e la gestisce solo l'owner.
_Avoid_: profilo, contesto, knowledge base

**Account collegato**:
Un account esterno di una persona (oggi Google) che le istanze leggono per lei, solo nelle sue conversazioni e solo dove l'owner lo consente. Diverso da un connettore, che appartiene a un'istanza.
_Avoid_: integrazione, connettore personale

**Siti consentiti**:
I siti che un'istanza può leggere, fotografare e navigare con il browser, scelti dall'owner; tutto il resto, e qualunque indirizzo interno, le è negato.
_Avoid_: whitelist, domini, navigazione libera

**Ricerca sul web**:
La ricerca che un'istanza fa con il servizio di ricerca del server (Brave Search) per notizie, prezzi e fatti che cambiano: titoli, indirizzi ed estratti, che apre poi con la lettura dai siti consentiti. La accende l'owner istanza per istanza; al servizio vanno solo le parole cercate.
_Avoid_: Google, motore, browsing

**Risposta a voce**:
Una risposta che arriva su Telegram o WhatsApp come messaggio vocale, con il testo accanto. Di norma a chi ha mandato un vocale; ogni persona può chiedere «sempre» o «mai». Nella console, invece, ogni risposta si ascolta con «Ascolta», dalla voce del dispositivo.
_Avoid_: TTS, sintesi vocale (nei testi per le persone)

**Sentinella**:
Una pagina che un'istanza controlla da sola ogni tanto (da 30 minuti a una settimana), per una conversazione: tutta la pagina, la parte vicino a una frase, o un prezzo con una soglia sotto o sopra. Scrive nella conversazione solo quando qualcosa è cambiato, una volta per cambiamento; legge solo dai siti consentiti.
_Avoid_: watcher, monitor, alert

**Browser**:
La pagina web che un'istanza tiene aperta per una conversazione, dove clicca e scrive per usare siti costruiti in JavaScript. Legge e basta: quello che invia passa da un'azione sul web. Gira nella cella, non nel computer. Nella console si vede e si guida dal pannello «Browser» accanto alla chat.
_Avoid_: computer, automazione del browser, agente web

**Immagine su richiesta**:
Un'immagine che Annie crea da una descrizione o ritoccando una foto che le hanno mandato, con il servizio di immagini dell'operatore, solo nelle istanze dove l'owner lo consente. Arriva in chat e resta in `immagini/` del workspace.
_Avoid_: AI art, generazione

**Report di ricerca**:
Il file Markdown che Annie scrive quando le chiedono di approfondire un tema: più ricerche, le pagine migliori dei siti consentiti, e un testo dove ogni fatto rimanda a una fonte numerata del suo dossier. L'elenco delle fonti lo scrive il codice, non il modello.
_Avoid_: deep research, ricerca profonda

**Richiesta Google**:
Una mail, una risposta, una bozza o un evento che Annie prepara sul Google di chi le scrive dalla console, e che succede solo quando quella persona la approva dalla card in chat o in Approvazioni. Una volta sola; l'esito torna nella conversazione.
_Avoid_: azione Google, automazione

**Azione sul web**:
L'invio di un modulo di un sito consentito che l'istanza chiede e che parte solo dopo che chi l'ha chiesta, o un approvatore, ha letto destinazione e valori e l'ha approvato. Una volta sola; l'esito torna nella conversazione.
_Avoid_: automazione, bot, compilazione automatica

**Computer**:
La macchina di un'istanza, separata dalla cella, senza rete e senza segreti, dove l'istanza esegue comandi su copie dei file del workspace e rimette lì quelli che produce. Un container sul server di Annie o una micro-VM su Fly.io; in Annie Cloud sempre una micro-VM, raggiunta attraverso il control plane. La accende l'owner; i suoi file restano finché l'owner non la azzera.
_Avoid_: sandbox (è quella dei tool proposti), VM, server

**Schermo**:
Il desktop Linux di un agente, con Firefox, dove l'agente guarda lo schermo, clicca, scrive e apre programmi attraverso Cua. Un container sul server di Annie, senza internet se l'operatore non sceglie altrimenti, oppure un desktop che gira altrove e che tutti gli agenti che lo usano condividono. Lo accende l'owner agente per agente. Quello che l'agente fa sullo schermo non passa dalle approvazioni, e con internet il suo browser non segue i siti consentiti: prima di inviare o pagare chiede in chat.
_Avoid_: computer (è il terminale senza rete), browser (è quello della cella), desktop remoto, VNC

**Brief del mattino**:
Il task programmato di una persona che ogni mattina le riassume impegni del giorno, mail che chiedono una risposta e quello che l'istanza ricorda di lei, leggendo senza cambiare niente.
_Avoid_: digest, report giornaliero, newsletter

## Controllo

**Egress policy**:
L'elenco di ciò che un'istanza può raggiungere: provider di modelli, canali, connettori. Tutto il resto è negato.
_Avoid_: firewall, whitelist

**Approvazione**:
La decisione di un approvatore su un'azione che l'istanza non può compiere da sola: inviare una mail, attivare un tool proposto, inviare un modulo sul web (questa la può decidere anche chi l'ha chiesta, nella sua conversazione privata). Le richieste sul Google di una persona le decide solo lei.
_Avoid_: conferma, ok

**Audit**:
Il registro, per tenant, di ciò che è successo: accessi negati, invii, approvazioni, spese. Non contiene mai il testo dei messaggi.
_Avoid_: log

**Tetto di spesa**:
Il limite giornaliero di spesa in modelli di un tenant: oltre quello soft si avvisa, oltre quello hard si smette di chiamare il modello.
_Avoid_: budget, quota

## Segreteria commerciale

**Segreteria**:
Il primo caso d'uso: un'istanza che legge le richieste di preventivo arrivate per email, prepara il lead e la bozza di risposta e aspetta l'approvazione del commerciale.

**Pratica**:
Una richiesta di preventivo arrivata per email e tutto quello che ne segue, dalla lettura all'invio o allo scarto.
_Avoid_: ticket, caso, lead (il lead è nel CRM)

**Bozza**:
La risposta al cliente preparata dall'istanza. Ha una versione che cresce a ogni modifica e non parte senza approvazione.
_Avoid_: draft (in italiano), proposta

**Scheda** (della segreteria):
Il messaggio a un approvatore con la pratica, la bozza e i pulsanti Approva, Modifica, Scarta.
_Avoid_: notifica (quando ha pulsanti), card

**Connettore in un clic**:
Un servizio del catalogo (Notion, Linear, Jira, Stripe, GitHub e altri) che l'owner collega dalla pagina Connettori entrando con il suo account, o incollando un token. L'accesso resta sul server di Annie e si rinnova da solo; quando non si rinnova il connettore è «Da collegare». Vedi ADR 0024.
_Avoid_: integrazione, plugin, app

**Azione di un connettore**:
Una chiamata a uno strumento di un servizio collegato che cambia qualcosa (crea, modifica, cancella). Annie la prepara come richiesta; parte, una volta, solo quando chi l'ha chiesta o un approvatore la approva. Gli strumenti che il servizio indica come di sola lettura partono subito. Vedi ADR 0025.
_Avoid_: tool call, operazione

**Richiesta scaduta**:
Una richiesta da approvare (modulo, mail o evento Google, azione di un connettore) che nessuno ha approvato o rifiutato entro 24 ore. Non viene mai fatta; la conversazione che l'ha chiesta riceve un avviso, una volta. Vedi week31.md.
_Avoid_: richiesta annullata, timeout
