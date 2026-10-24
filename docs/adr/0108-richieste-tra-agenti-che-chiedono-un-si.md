# 0108: Richieste tra agenti che chiedono un sì

Un agente A scrive a un agente B con `agent_message` ([ADR 0042](0042-agenti-che-si-scrivono.md)). B lavora in una conversazione sul canale `agente` (`<A>~<canale>~<conversazione>`), con origine `agent` ([ADR 0088](0088-conferme-solo-dalla-persona.md)). Quando uno strumento di B arriva a un passo che `requirePersonFor` tiene per una persona (emettere, confermare, cambiare qualcosa che non si disfa), la risposta finora era un rifiuto secco: «lo conferma solo chi ti scrive». A non poteva confermare, giustamente, ma nemmeno nessun altro: la richiesta moriva lì. Le azioni dei connettori ([ADR 0025](0025-azioni-dei-connettori-con-approvazione.md)) e i moduli web ([ADR 0011](0011-moduli-web-con-approvazione.md)) chiesti in quella conversazione andavano già agli approvatori di B, ma la scheda non diceva che li aveva chiesti un altro agente.

## Decisione

- **Il passo va a chi approva per B.** `requirePersonFor`, in un turno `agent`, avvisa lo strumento con `ctx.needsPerson(cosa, chiamata?)` oltre a rifiutare. Gli strumenti di B sono avvolti da `withAgentRequests` (`src/core/agent-requests.ts`): se una chiamata in una conversazione sul canale `agente` ha ricevuto quell'avviso, diventa una richiesta in attesa, in `agent-requests/` dell'agente. Fuori dal canale `agente` (una persona, una stanza) non cambia niente.
- **Uno strumento con anteprima consegna la chiamata confermata.** Dove il passo è «anteprima, poi conferma», lo strumento calcola l'anteprima come farebbe per una persona e la passa con la chiamata esatta da eseguire (`chiamata = { args, preview }`): in attesa va quella chiamata, non quella fatta dal modello, e l'anteprima entra nella scheda («Cosa scriverei»), intera, così chi approva vede cosa verrà scritto. Un'anteprima oltre 8.000 caratteri è rifiutata, mai tagliata; in chat la scheda la mostra se ci sta, altrimenti si approva dalla console.
- **Le fatture di vendita sono il primo registro aperto.** Il caso: Vendite chiede ad Amministrazione la fattura di un preventivo accettato. In un turno di un altro agente, nella sua conversazione con B, `sales_invoices` con `op: "draft"` prepara la bozza come per una persona, poi ne chiede l'emissione: l'anteprima dell'emissione (righe, totali, scadenza, magazzino, DDT) e la chiamata `issue` con `confirm: true` e l'impronta della bozza (`version`) vanno agli approvatori di B. Approvata, l'emissione gira una volta; se la bozza è cambiata nel frattempo non la emette e lo dice. Il modello di B, che risponde ad A, non vede mai la bozza: sente solo che la richiesta aspetta, o che la fattura non si può preparare (dati mancanti, o dati che solo una persona dice: l'ultimo numero, il bollo, la ritenuta, una bozza da sostituire, un cliente nuovo). Ad A torna solo l'esito, mai la fattura scritta.
- **Gli approvatori sono quelli di B, con le regole di sempre.** Il proprietario e gli approvatori dell'agente B (`isApprover`). La richiesta compare nella console in Approvazioni e, con i pulsanti Approva e Rifiuta, nelle chat Telegram e WhatsApp degli approvatori. Una scheda troppo lunga per la chat si approva solo dalla console; dalla chat si può rifiutare.
- **La scheda dice chi chiede, con le sue parole, e cosa parte.** Il nome di A, il testo che A ha scritto (registrato dal sistema quando il messaggio parte, in `agent-asks.json`, non preso da quello che A dice di sé), l'azione nelle parole del controllo dello strumento e ogni argomento, intero. Nella scheda il testo di A è segnato come richiesta, non approvazione; nell'esito che torna ad A è chiuso fra delimitatori casuali (`fencedAgentRequest`), come dati e mai istruzioni.
- **Approvata, gira una volta, con quegli argomenti.** La coda è `ActionQueue` ([ADR 0011](0011-moduli-web-con-approvazione.md)): stato `running` su disco prima del lavoro, la prima decisione vince, un secondo tocco non cambia niente, un riavvio a metà lascia l'esito incerto e mai una seconda esecuzione. Lo strumento gira con origine `person` e fuori dalla conversazione con A (senza conversazione): il sì della persona vale per quella chiamata e quegli argomenti, non per altre, e nessun controllo dello strumento la scambia per il turno di A.
- **L'esito torna ad A.** Fatta, rifiutata, non riuscita, incerta o scaduta (24 ore), arriva come avviso nella conversazione di A da cui era partita la domanda, con origine `agent`: non vale mai come sì di una persona. Ogni passo va nel registro: `agent_request.proposed`, `.approved`, `.done`, `.rejected`, `.failed`, `.uncertain`, `.expired`, `.unreachable`, e `user.denied` per chi non può decidere.
- **Il testo di A non approva, e nemmeno le persone di A.** L'approvazione arriva solo dalla console o dai pulsanti, da un approvatore di B. Un approvatore di A che non approva per B riceve `NotAnApprover` (403 nella console).
- **Senza approvatori raggiungibili, B lo dice.** Se B non ha nessun approvatore raggiungibile (il proprietario o un approvatore web nella console, o un approvatore su un Telegram o WhatsApp collegato), lo strumento risponde con un errore chiaro e B lo riferisce ad A. Niente resta in attesa.
- **Azioni dei connettori e moduli web chiesti da A** portano `askedBy` sulla scheda (console e chat): chi chiede e con quali parole.

## Scartato

- **Far confermare ad A.** A è un modello: il suo «sì» è testo, e il testo di un altro agente non è il sì di una persona (ADR 0088).
- **Mandare la richiesta alle persone di A.** Approvano per A, non per B: il passo cambia le cose di B, e lo decide chi risponde per B.
- **Rimandare ad A anche la risposta dello strumento.** L'esito sì, il contenuto no: quello che lo strumento di B risponde (dati di B) resta a chi approva per B. Ad A arriva solo cosa è successo.
- **Riprovare da sola la chiamata dopo l'approvazione con un nuovo turno di B.** Il modello potrebbe cambiare gli argomenti: approvata parte la chiamata registrata, così com'è.

## Quali strumenti chiedono agli approvatori e quali rifiutano ancora

| Strumento | Per un altro agente | Perché |
|---|---|---|
| `sales_invoices` `draft` (nella conversazione con l'altro agente) | prepara la bozza e ne chiede l'emissione agli approvatori di B, con l'anteprima | ha già «anteprima, poi conferma»: l'anteprima è quella che vedrebbe una persona |
| `sales_invoices` le altre operazioni | rifiuta, tranne `list` (conti e totali) | `issue` diretta richiederebbe ad A di conoscere una bozza che non vede; `show`, `credit_note`, `remove`, `settings` mostrano o cambiano dati che restano di B |
| `sales_invoices` in una stanza | rifiuta, e non prepara niente | non c'è una conversazione di B con A a cui far tornare l'esito |
| `quotes` | rifiuta, tranne le letture di conti | non ha un passo «anteprima, poi conferma»: crea e cambia subito; l'invio passa già dall'approvazione delle mail |
| ddt, magazzino, ordini, appuntamenti, personale, banca, clienti, fornitori, listino, rinnovi, fatture ricorrenti, cassa, carico da fattura | rifiutano con il loro controllo, prima di `requirePersonFor` | molti tengono per una persona ogni modifica, senza anteprima; gli altri hanno un'anteprima propria e una bozza propria. Aprirli chiede per ognuno la stessa cura delle fatture (cosa preparare nel turno di A, quale chiamata consegnare, l'impronta, cosa non dire ad A): una scelta per strumento, non un interruttore |

## Limiti

- **Una bozza resta se la richiesta è rifiutata o scade.** La bozza BZ preparata per l'altro agente resta nel registro di B; una persona la toglie con `remove`, o la emette lei.
- **La data è quella dell'approvazione.** L'anteprima calcola data e scadenza del giorno in cui A chiede; approvata un altro giorno, la fattura prende la data e il numero di quel giorno, come per una persona che conferma più tardi.
- **Azioni dei connettori e moduli web** chiesti da A seguono il loro percorso: l'esito torna nella conversazione di B con A, e B lo riferisce ad A con la sua risposta, non con un avviso diretto.
- **Il proprietario c'è sempre.** Nell'app il proprietario esiste sempre ed è raggiungibile dalla console, quindi l'errore «nessun approvatore raggiungibile» si vede solo senza persone (provato nei test unitari).
- **A vede solo l'esito.** Se A ha bisogno del risultato (un numero, un documento), deve chiederlo di nuovo a B dopo l'approvazione.

## Conseguenze

- `requirePersonFor` accetta un `needsPerson` facoltativo nel contesto dello strumento e, da chi ha un'anteprima, la chiamata confermata; il rifiuto resta identico per il turno di B.
- Il modello locale di sviluppo esegue un `/tool` anche quando è tutta la richiesta di un altro agente, così un test guida tutti e due i lati (solo sviluppo e test).
- Nuovi file per agente: `agent-requests/` (la coda) e `agent-asks.json` (l'ultima richiesta di ogni agente per conversazione, al più 200).
- Console: nuove rotte `GET /api/instances/:id/agent-requests` (solo per chi approva) e `POST .../agent-requests/:rid/decision`; il contatore delle cose da approvare le conta. Chat: pulsanti `agent:<id>:approved|rejected`.
- All'avvio le richieste rimaste a metà diventano incerte e A lo sa; quelle in attesa sono riproposte nelle chat che non hanno ancora la scheda.
