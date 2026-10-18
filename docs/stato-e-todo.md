# Stato del progetto e cose da fare

Aggiornato al 18 ottobre 2026.

## Dove siamo

Su `main` ci sono le settimane da 1 a 55, e la CI controlla ogni PR con typecheck, test ed eval deterministiche. Le fasi del [piano cloud](piano-cloud.md) sono scritte tutte; dalla settimana 21 si aggiungono funzioni per chi usa Annie ogni giorno (sotto, «Funzioni»). I riassunti delle settimane dalla 6 in poi sono nei loro `weekN.md`.

- Settimana 1: nucleo durevole su Pi Durable dietro un adapter, multi-tenant, canale Telegram ([week1.md](week1.md)).
- Settimana 2: allowlist degli utenti per istanza, lock dell'istanza e outbox persistente delle risposte ([week2.md](week2.md)).
- CI: typecheck, test ed eval su ogni PR, con la regola di un PR per settimana ([contributing.md](contributing.md)).
- Settimana 3: logica della segreteria commerciale (pratiche, approvazione obbligatoria, routing dei modelli, tetti di spesa, 35 eval), provata solo con fake ([week3.md](week3.md), [spec](spec-segreteria-commerciale.md)).
- Settimana 5 (branch `week-5`, parte da `week-4`): agente generale (connettori MCP, file, task programmati, tool proposti in sandbox con approvazione), console web, processo unico `pnpm start`, Docker e runbook ([week5.md](week5.md), [prodotto finito](prodotto.md)).
- Settimana 4 (branch `week-4`): segreteria funzionante end-to-end. `pnpm dev:segreteria` con Gmail e HubSpot live, pulsanti su Telegram, estrazione con Haiku e bozza con Sonnet sotto i controlli della CI, avviso doppioni, giudice notturno sulla pipeline vera ([week4.md](week4.md)).

Documenti di riferimento: [piano iniziale](piano-iniziale.md), [architettura](architettura.md).

## Cose da fare

### Per la prova reale (servono i segreti di Mario)

- [ ] Un bot Telegram dedicato alla segreteria (da @BotFather), diverso da quello di `dev:telegram`
- [ ] Chiave Anthropic
- [ ] Client OAuth Google e refresh token con scope `gmail.readonly` e `gmail.send` (app in modalità «Testing»: il refresh token scade dopo 7 giorni)
- [ ] Token di una private app HubSpot con scope `crm.objects.contacts.read` e `crm.objects.contacts.write`
- [ ] User ID Telegram dei commerciali in `ANNIE_TELEGRAM_ALLOWED_USERS`; ognuno apre il bot e preme Start
- [ ] `ANNIE_JUDGE_MODEL_KEY` tra i secret del repo, per il giudice notturno
- [ ] Verifiche dal vivo: Gmail conserva il nostro `Message-ID`? Valori di `hs_lead_status` del portale (`GET /crm/v3/properties/contacts/hs_lead_status`). Costo per pratica (stima da verificare: 1-2 centesimi di dollaro). Primo report del giudice

### Decisioni che spettano a Mario

- [x] Licenza: Apache-2.0, confermata da Mario il 16 ottobre 2026
- [x] Merge di `week-4` e `week-5` su `main`, con l'ok di Mario il 16 ottobre 2026 (#3 `e5f9f4f`, #4 `a55e9f0`)

### Dopo (proposta)

- [x] Ritentativi nello stesso processo, con backoff, per risposte e schede (risposte: settimana 6; schede: a ogni giro dalla settimana 4)
- [x] Pulizia delle outbox: le risposte consegnate da più di 30 giorni si cancellano all'apertura dell'istanza (settimana 6). I file del workspace non si cancellano da soli: sono dati delle persone, li toglie chi li gestisce
- [x] Sandbox: container di Annie con privilegi minimi, che il processo del tool eredita (settimana 6). L'utente di sistema separato è scartato: richiederebbe di ridare ad Annie i privilegi per cambiare utente ([ADR 0002](adr/0002-tool-proposti-sandbox-e-approvazione.md))
- [x] Creare istanze dalla console (branch `week-6`, vedi [week6.md](week6.md))
- [x] 2FA per la console: verifica in due passaggi facoltativa con app di autenticazione (settimana 6)

### Annie Cloud (deciso il 16 ottobre 2026, [piano](piano-cloud.md), [ADR 0007](adr/0007-annie-cloud-a-celle.md))

- [ ] Fase 1: la cella. Fatti e su `main` (settimane 7 e 8): Telegram via webhook, celle che si spengono e si risvegliano, control plane con registrazione, link via SMTP, celle container (ADR 0008). Misure: circa 4 s dalla registrazione alla prima risposta e per il risveglio, circa 100 MB di memoria da accesa, 0,1 MB di disco da spenta. Mancano: la scelta del provider (Railway in valutazione, spike con `RAILWAY_API_TOKEN`), dominio con PSL, servizio SMTP, prova dal vivo
- [x] Fase 2: l'agente personale (memoria della persona, Google per persona in sola lettura, brief del mattino). Restano la verifica dell'app presso Google e la misura sul campo (`pnpm annie brief` dopo una settimana d'uso vero)
- [ ] Fase 3: il computer dell'agente. Fatte la navigazione web in sola lettura (settimana 10, ADR 0009), l'invio di moduli con approvazione (settimana 16, [ADR 0011](adr/0011-moduli-web-con-approvazione.md)) e il terminale in un computer per istanza senza rete (settimana 18, [ADR 0013](adr/0013-terminale-in-un-computer-senza-rete.md), per ora solo installando Annie su un proprio server), il browser con clic nel Chromium della cella (settimana 19, [ADR 0014](adr/0014-browser-con-clic-nella-cella.md), anche in Annie Cloud) e il computer su micro-VM Fly.io, che lo accende anche in Annie Cloud (settimana 20, [ADR 0015](adr/0015-computer-su-micro-vm.md)). Manca la prova dal vivo su Fly con un token vero (`FLY_API_TOKEN`, [chiavi](chiavi.md) §12)
- [ ] Fase 4: pagamento, voce, WhatsApp. Pronti la misura della spesa per tenant (`pnpm cloud status`), l'abbonamento Stripe con prova, quota fissa e consumo a contatore (settimana 12, ADR 0010) il canale WhatsApp (settimana 13) e i messaggi vocali trascritti (settimana 14). Mancano le cifre (decisione di Mario, si impostano su Stripe), le prove dal vivo con le chiavi di test di Stripe, Meta e Mistral, il template WhatsApp da far approvare a Meta (il codice c'è, settimana 15) e la prova dal vivo delle chiamate vocali (settimana 17, [ADR 0012](adr/0012-chiamate-vocali-con-numero-twilio.md)), che chiede un numero Twilio italiano

### Funzioni (dal 17 ottobre 2026, una PR per funzione)

- [x] Foto e immagini: Annie vede le foto mandate su Telegram, WhatsApp e web e riapre le immagini del workspace (settimana 21, [week21.md](week21.md), [ADR 0016](adr/0016-immagini-al-modello.md))
- [x] Ricerca sul web: Annie cerca con Brave Search e apre le pagine trovate dai siti consentiti (settimana 22, [week22.md](week22.md), [ADR 0017](adr/0017-ricerca-sul-web.md)). Serve la chiave `ANNIE_SEARCH_API_KEY` ([chiavi](chiavi.md) §13)
- [x] Sentinelle: Annie controlla una pagina da sola e scrive quando cambia o quando un prezzo passa una soglia (settimana 23, [week23.md](week23.md), [ADR 0018](adr/0018-sentinelle.md))
- [x] Primo avvio guidato («Primi passi») e console installabile come app (settimana 24, [week24.md](week24.md), [ADR 0019](adr/0019-primi-passi-e-console-come-app.md))
- [x] Console pulita, chat al centro: conversazioni nella barra laterale, casella arrotondata, gestione nel menu dell'account, niente tolto ([console.md](console.md))
- [x] Qualsiasi modello AI: 18 provider (Claude, GPT, Gemini, Grok, Mistral, DeepSeek, Kimi, OpenRouter e altri), scelti dall'owner in Impostazioni con la chiave del server o la sua ([ADR 0032](adr/0032-qualsiasi-modello.md))
- [x] Il modello di ogni chat: una pillola nel box di scrittura, come su Grok, per scegliere fra i modelli dei provider permessi; l'owner può aggiungerne uno con la sua scelta ([ADR 0036](adr/0036-modello-per-chat.md))
- [x] Il modello della chat anche da Telegram e WhatsApp, con il comando `/modello` ([ADR 0037](adr/0037-modello-dai-canali.md))
- [x] In console ogni risposta dice quale modello l'ha scritta, accanto all'ora ([ADR 0036](adr/0036-modello-per-chat.md))
- [x] App desktop con Tauri sul modello di Reflect: finestra sul server, icona nella barra, scorciatoia globale, installer da GitHub Actions; da fare firma e aggiornamenti automatici ([desktop.md](desktop.md))
- [x] Risposte a voce: un vocale in risposta a un vocale su Telegram e WhatsApp, a scelta di ogni persona, e «Ascolta» nella console (settimana 25, [week25.md](week25.md), [ADR 0020](adr/0020-risposte-a-voce.md)). Serve `ANNIE_SPEECH_API_KEY` ([chiavi](chiavi.md) §14)
- [x] Scrivere su calendario e mail, con approvazione: mail, risposte, bozze ed eventi che la persona approva dalla card in chat (settimana 26, [week26.md](week26.md), [ADR 0021](adr/0021-google-scrivere-con-approvazione.md)). Serve `ANNIE_GOOGLE_WRITE=1` ([chiavi](chiavi.md) §4)
- [x] Ricerca approfondita con report: più ricerche insieme, le pagine migliori lette, un report Markdown con le fonti numerate e controllate (settimana 27, [week27.md](week27.md), [ADR 0022](adr/0022-report-di-ricerca.md))
- [x] Immagini su richiesta: crea e ritocca immagini, varianti, sfondo trasparente; le foto arrivano come foto su Telegram e WhatsApp (settimana 28, [week28.md](week28.md), [ADR 0023](adr/0023-immagini-su-richiesta.md)). Serve `ANNIE_IMAGE_API_KEY` ([chiavi](chiavi.md) §15)
- [x] Connettori in un clic: una galleria di servizi noti (Notion, Linear, Jira, Stripe, GitHub e altri) che si collegano entrando con l'account o con un token (settimana 29, [week29.md](week29.md), [ADR 0024](adr/0024-connettori-in-un-clic.md)). Serve `ANNIE_PUBLIC_URL` in https
- [x] Azioni dei connettori con approvazione: gli strumenti dei servizi collegati che cambiano qualcosa aspettano che chi l'ha chiesto o un approvatore approvi la richiesta esatta (settimana 30, [week30.md](week30.md), [ADR 0025](adr/0025-azioni-dei-connettori-con-approvazione.md))
- [x] Avviso quando una richiesta da approvare scade: la conversazione che l'ha chiesta lo sa, una volta (settimana 31, [week31.md](week31.md))
- [x] Leggere i documenti: PDF, Word, Excel, PowerPoint e OpenDocument mandati in chat o nel workspace, a pezzi se sono lunghi (settimana 32, [week32.md](week32.md), [ADR 0026](adr/0026-documenti.md))
- [x] PDF e documenti trovati sul web: `web_read` li legge, `web_download` li salva nel workspace, la ricerca approfondita ne usa il testo (settimana 33, [week33.md](week33.md), [ADR 0027](adr/0027-documenti-dal-web.md))
- [x] Scansioni: Annie guarda le pagine dei PDF scansionati con `image_view` e ne legge il testo da sé (settimana 34, [week34.md](week34.md), [ADR 0028](adr/0028-pagine-scansionate.md))
- [x] Documenti creati da Annie: Word, Excel e PDF dalla chat (un preventivo, una lettera, un listino, un CSV in Excel), con tabelle, immagini e formule, pronti da mandare (settimana 35, [week35.md](week35.md), [ADR 0029](adr/0029-documenti-creati-da-annie.md))
- [x] Grafici: barre, linee e torta dalla chat o da un CSV, mandati come foto o messi nei documenti, leggibili sul telefono (settimana 36, [week36.md](week36.md), [ADR 0030](adr/0030-grafici.md))
- [x] Conti esatti: domande a CSV, Excel e OpenDocument (totali, medie, classifiche, filtri, gruppi per mese, quote, fogli uniti) e una calcolatrice per preventivi e IVA, mai a mente (settimana 37, [week37.md](week37.md), [ADR 0031](adr/0031-conti-esatti.md))
- [x] Registrazioni lunghe: riunioni, chiamate, vocali lunghi e video trascritti a pezzi, con il minuto di ogni passaggio e le voci, per verbali e riassunti (settimana 38, [week38.md](week38.md), [ADR 0033](adr/0033-registrazioni-lunghe.md)). Da provare dal vivo con Mistral il campo delle voci
- [x] Cerca nei file: le parole dentro tutti i file del workspace (PDF, Word, Excel, trascrizioni, note) e nei nomi, con il passaggio, la pagina o il minuto e il punto da cui leggere (settimana 39, [week39.md](week39.md), [ADR 0035](adr/0035-cerca-nei-file.md))
- [x] Liste: la spesa, le cose da fare, i regali, di una persona o condivise, con voci da aggiungere, spuntare e togliere a parole o per numero (settimana 40, [week40.md](week40.md), [ADR 0038](adr/0038-liste.md))
- [x] Meteo: adesso, stasera e i prossimi giorni per un posto, con le fasce di oggi e domani (settimana 41, [week41.md](week41.md), [ADR 0039](adr/0039-meteo.md))
- [x] Cambi delle valute: i tassi ufficiali BCE, oggi o alla data di una fattura, più importi, elenco e andamento (settimana 42, [week42.md](week42.md), [ADR 0040](adr/0040-cambi.md))
- [x] Agenti: più agenti per tenant, ognuno con nome, emoji, compito e tono, oltre a memoria, task, file e bot suoi; pagina Agenti e nuovo agente da un modello ([ADR 0041](adr/0041-agenti.md))
- [x] Agenti che si scrivono: un agente chiede a un altro con `agent_message`, se l'owner lo permette, e la risposta torna nella chat di partenza ([ADR 0042](adr/0042-agenti-che-si-scrivono.md))
- [x] Notizie: i titoli recenti dai feed dei giornali, per argomento, giornale o sezione, di oggi o di ieri, con fonte, ora e link (settimana 43, [week43.md](week43.md), [ADR 0043](adr/0043-notizie.md))
- [x] Browser interno: il browser della conversazione si vede e si guida da un pannello accanto alla chat della console ([ADR 0044](adr/0044-browser-interno.md)); TODO: clic sulla foto
- [x] Schermo: un desktop Linux con Firefox per agente, guidato con Cua (guarda, clicca, scrive, tasti, scorre, apre programmi e indirizzi); senza internet di default, l'owner lo accende in Impostazioni ([ADR 0045](adr/0045-schermo-cua.md)). Serve `ANNIE_DESKTOP` e l'immagine di Cua ([chiavi](chiavi.md) §19)
- [x] Partita IVA e codice fiscale: controllo formale sempre, e con il VIES attiva o no con nome, indirizzo e ora del controllo (settimana 44, [week44.md](week44.md), [ADR 0047](adr/0047-partita-iva.md))
- [x] Date e scadenze: giorni e giorni lavorativi, scadenze delle fatture anche fine mese, festivi con il 4 ottobre, età (settimana 45, [week45.md](week45.md), [ADR 0048](adr/0048-date-e-scadenze.md))
- [x] Partita IVA nella segreteria: controllata senza rete, non salvata se sbagliata, la bozza chiede di ricontrollarla (settimana 46, [week46.md](week46.md), [ADR 0049](adr/0049-partita-iva-nella-segreteria.md))
- [x] Fatture elettroniche: XML e .p7m dello SdI (anche semplificate) lette ovunque come riepilogo in italiano, con scadenza, IVA, ritenute e IBAN; i documenti firmati .p7m letti come quello che contengono (settimana 47, [week47.md](week47.md), [ADR 0052](adr/0052-fatture-elettroniche.md))
- [x] Scadenzario: le fatture del workspace da pagare e da incassare, scadute, per controparte, segnate pagate, con le note di credito tolte (settimana 48, [week48.md](week48.md), [ADR 0053](adr/0053-scadenzario.md))
- [x] Solleciti di pagamento: tre livelli, al netto delle note di credito, con l'IBAN dell'azienda, inviati solo dopo l'approvazione o copiati dal telefono (settimana 49, [week49.md](week49.md), [ADR 0054](adr/0054-solleciti-di-pagamento.md))
- [x] Preventivi: numerati per anno, IVA esatta anche con prezzi ivati, forfettario, ritenuta e cassa, PDF o Word con carta intestata, stato e scadenza (settimana 50, [week50.md](week50.md), [ADR 0055](adr/0055-preventivi.md))
- [x] Allegati nelle mail: preventivi, fatture dei solleciti e file del workspace, con la card che mostra cosa parte e il controllo che il file non sia cambiato (settimana 51, [week51.md](week51.md), [ADR 0056](adr/0056-allegati-nelle-mail.md))
- [x] Spese e prima nota: la foto dello scontrino diventa una spesa, con riepiloghi per categoria, prima nota con incassi e uscite ed export CSV per il commercialista (settimana 52, [week52.md](week52.md), [ADR 0057](adr/0057-spese-e-prima-nota.md))
- [x] Ore di lavoro: ore per cliente a voce o con il timer, tariffe e arrotondamenti, report per il cliente e preventivo fatto dalle ore non fatturate (settimana 53, [week53.md](week53.md), [ADR 0058](adr/0058-ore-di-lavoro.md))
- [x] Rinnovi e abbonamenti: assicurazioni, domini, software e contratti con l'avviso prima della scadenza e della data entro cui disdire, i costi all'anno e al mese e il pagamento registrato fra le spese (settimana 54, [week54.md](week54.md), [ADR 0064](adr/0064-rinnovi-e-abbonamenti.md))
- [x] Previsione di cassa: quanti soldi ci saranno sul conto da fatture, rinnovi, preventivi accettati, spese e voci proprie, con il punto più basso, «se compro…», «se Rossi paga in ritardo…» e l'avviso nel brief sotto una soglia (settimana 55, [week55.md](week55.md), [ADR 0065](adr/0065-previsione-di-cassa.md))
- [ ] Schermo: prova dal vivo con Docker vero su un server amd64 (avvio dell'immagine con le sole capability previste e un init, tempo di avvio, indirizzo del container su una rete interna con il traffico fra container spento, strumenti di `cua-spacesd` 0.3.0 e `scope: "desktop"`, nomi dei tasti e combinazioni)
- [ ] Schermo: vista dal vivo nella console e ultima schermata visibile all'owner, per vedere quello che Annie fa (il VNC c'è nel container ma non è pubblicato)
- [x] Eliminare un agente dalla console: il nome da scrivere per conferma, poi via bot, numeri, automazioni, chiavi, file, computer e schermo, e il permesso degli altri agenti di sentirlo ([ADR 0046](adr/0046-eliminare-un-agente.md))
- [x] Board: le cose da fare in quattro colonne, affidate agli agenti; l'agente ci lavora in una conversazione con chi gliel'ha affidata, la manda in «Da rivedere», e la chiude una persona; si crea anche dalla chat ([ADR 0050](adr/0050-board.md))
- [x] Board: le schede si trascinano fra le colonne, e chi deve rivedere una scheda lo sa dalla console e, se è l'owner, anche su Telegram o WhatsApp ([ADR 0051](adr/0051-board-trascinare-e-avvisi.md))
- [x] Automazioni: un indirizzo segreto per agente che il modulo del sito, Stripe o Zapier chiamano, e l'agente lavora con i dati ricevuti nella conversazione di chi l'ha creata, una volta per consegna e al più 30 volte l'ora ([ADR 0060](adr/0060-automazioni.md)), con la pagina «Automazioni» nella console
- [x] Board: una scheda può andare da sola fino alla fine, senza aspettare risposte, con un tetto di 10 risposte e 2 ore, poi in «Da rivedere» ([ADR 0061](adr/0061-agenti-da-soli.md))
- [x] Board: sotto-schede, e un agente che passa una parte della sua scheda a un altro agente; il risultato gli torna nella conversazione ([ADR 0066](adr/0066-sotto-schede.md))
- [x] Skill: procedure salvate di un agente, con un nome che è anche il comando (`/chiusura-del-mese`), scritte dalla chat come bozze che la persona attiva con `/attiva-skill`, o salvate dalla console, aperte da sole quando servono, importate ed esportate come SKILL.md ([ADR 0059](adr/0059-skill.md)), con la pagina «Skill» nella console; da fare il menu di Telegram
- [x] Memoria con archivio: le memorie essenziali con ogni messaggio, i dettagli in un archivio di 1000 per persona che Annie cerca quando servono; con le essenziali piene la più vecchia va in archivio invece di un rifiuto ([ADR 0062](adr/0062-memoria-con-archivio.md))
- [x] Stanze: una conversazione della console fra una persona e da 2 a 5 agenti, che chiama chi le serve con @nome (o @tutti); ogni agente riceve quello che si è perso, e può chiamarne un altro, al più 3 volte di fila ([ADR 0063](adr/0063-stanze.md))
- [ ] Scansioni JBIG2 e JPEG 2000: oggi solo dal computer di Annie o con una foto

### Prima di rendere pubblico il repo

- [x] LICENSE (Apache-2.0, confermata)
- [x] Runbook per installazione e operatività ([runbook.md](runbook.md))
- [x] Action della CI su Node 24 (`checkout`, `setup-node`, `upload-artifact` v5). Resta `pnpm/action-setup@v4`: da verificare alla prima PR se dà ancora l'avviso

## Chi fa cosa

Craft segue prodotto ed esperienza, Ship codice, PR, CI e merge (su `main` solo con l'ok di Mario), AI Guru stack agenti, Pi Durable, modelli ed eval.
