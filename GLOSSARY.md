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
Un agente di un tenant, con il suo modello, le sue conversazioni, i suoi connettori, i suoi file e le sue regole di uscita.
_Avoid_: bot, agente (quando si intende la configurazione), profilo

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

**Sentinella**:
Una pagina che un'istanza controlla da sola ogni tanto (da 30 minuti a una settimana), per una conversazione: tutta la pagina, la parte vicino a una frase, o un prezzo con una soglia sotto o sopra. Scrive nella conversazione solo quando qualcosa è cambiato, una volta per cambiamento; legge solo dai siti consentiti.
_Avoid_: watcher, monitor, alert

**Browser**:
La pagina web che un'istanza tiene aperta per una conversazione, dove clicca e scrive per usare siti costruiti in JavaScript. Legge e basta: quello che invia passa da un'azione sul web. Gira nella cella, non nel computer.
_Avoid_: computer, automazione del browser, agente web

**Azione sul web**:
L'invio di un modulo di un sito consentito che l'istanza chiede e che parte solo dopo che chi l'ha chiesta, o un approvatore, ha letto destinazione e valori e l'ha approvato. Una volta sola; l'esito torna nella conversazione.
_Avoid_: automazione, bot, compilazione automatica

**Computer**:
La macchina di un'istanza, separata dalla cella, senza rete e senza segreti, dove l'istanza esegue comandi su copie dei file del workspace e rimette lì quelli che produce. Un container sul server di Annie o una micro-VM su Fly.io; in Annie Cloud sempre una micro-VM, raggiunta attraverso il control plane. La accende l'owner; i suoi file restano finché l'owner non la azzera.
_Avoid_: sandbox (è quella dei tool proposti), VM, server

**Brief del mattino**:
Il task programmato di una persona che ogni mattina le riassume impegni del giorno, mail che chiedono una risposta e quello che l'istanza ricorda di lei, leggendo senza cambiare niente.
_Avoid_: digest, report giornaliero, newsletter

## Controllo

**Egress policy**:
L'elenco di ciò che un'istanza può raggiungere: provider di modelli, canali, connettori. Tutto il resto è negato.
_Avoid_: firewall, whitelist

**Approvazione**:
La decisione di un approvatore su un'azione che l'istanza non può compiere da sola: inviare una mail, attivare un tool proposto, inviare un modulo sul web (questa la può decidere anche chi l'ha chiesta, nella sua conversazione privata).
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

**Scheda**:
Il messaggio a un approvatore con la pratica, la bozza e i pulsanti Approva, Modifica, Scarta.
_Avoid_: notifica (quando ha pulsanti), card
