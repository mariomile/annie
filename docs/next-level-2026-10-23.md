# Controllo del lavoro e browser personale: Verifica del 23 ottobre 2026

Sviluppo locale su `feat/agent-performance`, successivo al [rapporto del 22 ottobre](performance-2026-10-22.md). Le funzioni seguenti sono implementate nel repository; merge, pubblicazione cloud e app desktop installata sono verifiche separate.

## Cosa cambia per la persona

- **Chat:** Stato del lavoro e passaggi degli strumenti, con Stop per quella conversazione. Reload e riconnessione rileggono lo stato persistente.
- **Attività, Task e Automazioni:** Storico delle esecuzioni con origine, esito del motore e collegamento alla chat del risultato. Una chiamata webhook ammessa non viene presentata come lavoro già riuscito.
- **Browser:** Nella propria chat privata, anche un membro può prendere il controllo, scrivere direttamente in un campo e inviare un modulo semplice. Può poi restituire il browser a Owni o cancellare gli accessi salvati. Ogni persona e agente hanno un profilo di cookie separato.

## Affidabilità e prestazioni

L'intenzione di Stop viene salvata prima dell'annullamento del motore. Le regressioni coprono crash con SIGKILL in entrambe le finestre, lavoro attivo e in coda, esito già completato, altre conversazioni indipendenti e fallimenti temporanei dell'annullamento. Un errore di Stop non lascia la conversazione bloccata: Il nuovo tentativo recupera solo l'intenzione pendente di quella chat.

Lo storico conserva 1.000 esecuzioni terminali, tutte quelle ancora attive e al massimo 32 progressi per esecuzione. Non conserva prompt, argomenti o risultati degli strumenti. Autorizzazioni e filtri vengono applicati prima del limite; anche gli eventi live ricontrollano sessione e proprietà della chat.

Una fixture di 1.000 esecuzioni con 32 progressi ciascuna occupa 3.826.669 byte. Su 40 eventi senza variazioni, passare da due letture a una riduce la mediana da 14,28 a 8,30 ms e il p95 da 15,79 a 10,47 ms. È una misura locale con filesystem caldo, non una promessa sulla latenza del modello. I progressi consecutivi identici vengono esclusi prima della lettura dello storico.

Il browser mantiene i controlli di egress e di indirizzo a ogni richiesta. Il login usa cookie del profilo anche dopo il redirect; un POST 307/308 viene bloccato. Revoca e cancellazione chiudono i browser della persona e impediscono che risposte tardive ripubblichino il vecchio profilo. Il testo privato non entra nella chat o nell'audit.

Le revisioni di Astra e Claude Opus 5.5 hanno prodotto regressioni aggiuntive. Nel recupero di Stop, il caso decisivo avvia lo scheduler e poi fa fallire il commit dell'annullamento: Il blocco deve restare attivo e le altre chat devono poter proseguire. Nel browser, le prove sospendono l'autorizzazione mentre viene cancellato il profilo, controllano cookie HTTP che tentano di prevalere su cookie Secure e verificano testo privato dentro URL di moduli, titoli, etichette, paginazione, errori e link di file prima del troncamento. Coprono anche i valori effettivi dopo Backspace o un limite `maxlength`, la chiusura sicura quando non è possibile conservarli e l'assenza di immagini salvate da `web_browse` dopo un inserimento privato.

Le prove sui moduli che si inviano automaticamente durante la digitazione hanno esposto un'altra finestra: La pagina precedente poteva sparire prima della lettura del campo. Il valore effettivo viene ora conservato prima di autorizzare la navigazione. I controlli coprono anche conferme mancanti o non valide, documenti precedenti, iframe e sessioni già cancellate.

## Evidenza verificata

I test usano Pi Durable reale con modello `faux`, servizi simulati e fixture HTTP su loopback. Nessuna chiamata a modelli a pagamento o account esterni.

- `pnpm typecheck` e `pnpm build`: Superati. Il progetto non ha uno script lint.
- `pnpm test`: 2.768 test superati e 18 saltati, 141 file superati e tre saltati, dopo le correzioni delle revisioni. Durata 125,37 secondi su questa macchina.
- `pnpm eval:agente`: Catalogo e quattro scenari di esito superati, con 29 verifiche degli esiti.
- `pnpm eval:segreteria`: 37 casi, zero errori di controlli, schema, flusso e IVA.
- Chromium reale: Login e ripresa dopo riavvio, separazione di persone/tenant/istanze, cancellazione con risposta HTTP tardiva, revoca, azioni dell'agente sospese durante il controllo umano, blocco di invii non supportati e redirect, testo privato e serializzazione delle azioni.
- Interfaccia effettiva: Progressi prima della risposta; Stop; messaggio esplicito di interruzione; reload; storico; automazione chiamata via webhook e risultato nella propria chat; controllo umano, login con credenziali sintetiche, rilascio, sito salvato e cancellazione confermata degli accessi. Stop e login sono stati ripetuti dopo il riavvio della preview con le ultime correzioni. Controllati layout desktop e mobile, senza overflow orizzontale o errori JavaScript.

La revisione finale del recupero di Stop è approvata: Otto test mirati e il riproduttore indipendente confermano la chiusura dell'ultimo caso di ammissione assente. Il controllo precedente aveva confermato anche l'assenza di effetti dopo SIGKILL e la possibilità di lavorare su un'altra chat mentre un annullamento continua a fallire.

Anche la revisione finale del browser è approvata nel perimetro dichiarato. Il riproduttore originale dell'invio automatico non espone più il valore privato in URL, testo o risultato dello strumento. Sono passati 11 test indipendenti e cinque prove aggiuntive su limiti, conferme fuori contesto, revoca durante l'attesa e cancellazione del profilo durante l'ultima lettura di autorizzazione; nessun cookie è uscito nei casi rifiutati.

La preview T3 ha restituito due volte `Preview snapshot failed: Preview automation snapshot timed out after 15000ms.`. La verifica visiva ha quindi usato Playwright installato e Google Chrome, contro Owni locale. Non è una verifica dell'app desktop Tauri.

## Limiti e lavoro successivo

`succeeded` significa che il motore ha risposto. Non certifica il successo commerciale di un'azione esterna; consegna e approvazioni restano distinte. Stop impedisce passaggi successivi e propaga l'annullamento, ma non ritira effetti già prodotti. Uno strumento che ignora il segnale può proseguire fino al proprio timeout; le deleghe in background non vengono fermate automaticamente.

Il browser supporta cookie e moduli URL-encoded della pagina principale, sullo stesso origin. Non supporta login con XHR/fetch POST, multipart, iframe, passkey o localStorage. Dopo un inserimento privato, l'agente può usare la vista testuale oscurata ma non ottenere screenshot della stessa sessione; la persona mantiene il proprio pannello visivo. La politica prudente sui cookie `Domain` può interrompere accessi distribuiti fra sottodomini. I cookie sono in file privati sul server, senza cifratura applicativa. Un GET autenticato può avere effetti sul sito: Il solo metodo HTTP non garantisce un'azione di sola lettura.

La pianificazione e la qualità linguistica di modelli reali restano da misurare con casi rappresentativi e un budget approvato. La compatibilità con i login dei servizi effettivamente usati richiede prove dedicate. Questi risultati non dimostrano parità di qualità con Grok Bot.

Decisioni e contratti: [ADR 0105](adr/0105-stato-stop-e-storico-del-lavoro.md), [ADR 0106](adr/0106-browser-personale-e-controllo-umano.md).
