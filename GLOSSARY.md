# Annie

Piattaforma open source di agenti sempre attivi per aziende attente a privacy e controllo dei processi: ogni cliente ha i suoi agenti, che parlano con le persone sui canali, usano i sistemi dell'azienda e non fanno nulla di irreversibile senza un'approvazione.

## Chi

**Owner**:
Chi gestisce un tenant: in self-host chi installa Annie (Buildrs o l'IT del cliente), in Annie Cloud chi si registra. Crea istanze e decide cosa possono raggiungere.
_Avoid_: admin, superuser

**Operatore**:
Chi gestisce Annie Cloud per tutti i tenant (Buildrs). Non legge le conversazioni dei tenant.
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
L'ambiente isolato di un tenant in Annie Cloud: lo stesso Annie del self-host, su una macchina tutta sua, che si spegne quando non lavora.
_Avoid_: container, pod, istanza (un'istanza è un agente, dentro la cella)

**Control plane**:
La parte di Annie Cloud comune a tutti i tenant: registrazione, pagamento, smistamento dei messaggi alla cella giusta, risveglio delle celle. Inoltra i messaggi senza conservarli.
_Avoid_: backend, piattaforma

## Conversazioni

**Canale**:
Un luogo dove le persone parlano con un'istanza: Telegram, l'interfaccia web.
_Avoid_: gateway, integrazione

**Thread**:
Una conversazione su un canale: una chat Telegram, una chat nell'interfaccia web.
_Avoid_: sessione, chat (nel codice)

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

**Task programmato**:
Un'istruzione che un'istanza esegue da sola a un'ora stabilita, una volta o a ripetizione, consegnando il risultato a un thread.
_Avoid_: cron, job, promemoria, routine

## Controllo

**Egress policy**:
L'elenco di ciò che un'istanza può raggiungere: provider di modelli, canali, connettori. Tutto il resto è negato.
_Avoid_: firewall, whitelist

**Approvazione**:
La decisione di un approvatore su un'azione che l'istanza non può compiere da sola: inviare una mail, attivare un tool proposto.
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
