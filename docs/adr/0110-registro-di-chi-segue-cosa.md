# 0110: Registro di chi segue cosa

Ogni agente ha i suoi registri, separati da quelli degli altri ([ADR 0041](0041-agenti.md)): clienti, fornitori, preventivi, ordini, appuntamenti, fatture di vendita, DDT. È voluto: chi parla con un agente vede solo quello che quell'agente sa. Il risultato però è che due agenti possono seguire lo stesso cliente senza saperlo. Vendite fa un preventivo ad Alfa srl mentre Acquisti ha già un ordine aperto ad Alfa srl come fornitore, e nessuno dei due lo dice alla persona. I messaggi tra agenti ([ADR 0042](0042-agenti-che-si-scrivono.md)) non aiutano: un agente chiede solo quando sa che c'è qualcosa da chiedere.

## Decisione

- **Un registro comune per tenant, non dati unificati.** Accanto alla board, in `tenants/<id>/subjects.json`, c'è un registro di chi segue cosa: per ogni record di ogni agente, l'agente, il registro, l'ID del record nel suo registro (`CL-0012`, `OR-0003`, `2026-004`), il tipo detto in italiano (cliente, fornitore, preventivo, ordine, appuntamento, fattura, DDT), la scheda a cui è collegato se c'è, e quando è stato creato o cambiato l'ultima volta. I record restano dove sono, nei registri di ogni agente, con le loro regole. Mettere in comune i dati avrebbe significato un'anagrafica unica dei clienti e dei fornitori, letta e scritta da tutti gli agenti: è una migrazione di sette registri, e cancella proprio la separazione che rende sicuro dare un agente a una persona e un altro a un'altra. Il registro comune dice solo che c'è sovrapposizione, non cosa c'è dentro i record degli altri.
- **Lo stesso soggetto si riconosce dalla controparte, non dall'ID.** Gli ID sono numerati per agente: il `CL-0001` di Vendite e il `CL-0001` di Acquisti sono due clienti diversi. Per questo il registro confronta il cliente o il fornitore di ogni record: partita IVA, codice fiscale e nome senza forma giuridica (lo stesso confronto dei registri, `businessKey`). Queste chiavi sono salvate solo come hash (SHA-256, primi 16 caratteri): il file non contiene nomi, partite IVA o importi. Nell'avviso compaiono l'ID e il tipo del record dell'altro agente, perché è quello che la persona può chiedere all'altro agente.
- **Si scrive dopo ogni scrittura dei registri.** Gli strumenti dei sette registri, più `timesheet` (crea preventivi), `recurring_invoices` (crea bozze di fattura) e `stock` (un carico segna un ordine), sono avvolti da un aggancio unico (`withSubjects` in `src/core/subjects.ts`): dopo una chiamata che può aver scritto (non una lettura, secondo il `*CallReads` di ogni registro), rilegge i registri dell'agente e aggiorna il registro comune. Un record nuovo o cambiato prende la data di adesso; un record che non c'è più esce dal registro. La prima lettura di un registro registra quello che c'è già senza avvisi: non è una novità. I registri non sono stati toccati: l'aggancio sta in `register-tools.ts`.
- **L'avviso è nel risultato dello strumento.** Se un record appena creato o cambiato ha la stessa controparte di un record di un altro agente, il risultato aggiunge: «Attenzione, lo stesso cliente o fornitore lo segue anche un altro agente: Acquisti ha già ordine OR-0003 (scheda #12). Dillo alla persona prima di andare avanti.» Al massimo cinque, i più recenti, poi «e altri N». Solo nome dell'agente, tipo, ID e numero della scheda, mai il nome del cliente o il contenuto del record, come per gli altri conteggi tra agenti ([ADR 0090](0090-prezzi-d-acquisto.md)). Se il registro comune non si scrive, la chiamata non fallisce: il registro dell'agente ha già scritto, e l'errore va nel log.
- **Schede e record.** `board_create` e `board_update` accettano `subjects`: gli ID dei record dell'agente di cui parla la scheda. Il collegamento sta nel registro comune, non nella scheda: la scheda non cambia forma. Un ID che l'agente non ha è un errore, prima di creare la scheda. `board_update` collega solo le schede assegnate all'agente o create da lui, sostituisce i collegamenti di prima, e con `[]` li toglie. Anche qui il risultato porta l'avviso se altri agenti seguono gli stessi soggetti.
- **La vista dell'owner.** Nella finestra della scheda, l'owner vede «Chi segue cosa»: i record collegati, con agente, tipo e ID, e i record degli altri agenti sulla stessa controparte, con la loro scheda se c'è. Viene da `GET /api/board/:id/subjects`, solo owner. I membri non la vedono: per loro resta la separazione tra agenti.
- **Cancellazioni.** Un record eliminato esce dal registro alla prima chiamata di scrittura dello stesso agente (è quella che lo elimina). Una scheda eliminata scioglie i suoi collegamenti. Un agente eliminato ([ADR 0046](0046-eliminare-un-agente.md)) porta via tutte le sue righe.

## Scartato

- **Anagrafica unica dei clienti e dei fornitori.** Vedi sopra: è la cosa giusta solo se gli agenti devono condividere i dati, non solo sapere che si sovrappongono. Si può fare dopo, partendo da questo registro.
- **Confronto per ID del record.** Sbagliato per costruzione: ogni agente numera da 1.
- **Salvare i nomi in chiaro nel registro comune**, per un confronto più tollerante. Il registro è letto per tutti gli agenti: un nome in chiaro sarebbe un dato di un agente che finisce in un file comune.
- **Un'istruzione che chiede all'agente di consultare il registro.** Il modello se ne dimentica; l'aggancio sugli strumenti no.
- **Avvisare anche la conversazione di chi ha chiesto, nelle richieste tra agenti.** Nelle richieste tra agenti i registri non scrivono (`requirePersonFor`, [ADR 0042](0042-agenti-che-si-scrivono.md)): non c'è scrittura da segnalare, e l'aggancio salta quei turni.

## Limiti

- Il confronto è per partita IVA, codice fiscale o nome senza forma giuridica: due grafie diverse dello stesso nome senza partita IVA non si riconoscono, e due aziende diverse con lo stesso nome sì.
- Il registro si aggiorna solo quando l'agente scrive. Record creati prima di questa PR entrano alla prima scrittura dell'agente in quel registro, senza avviso. Un record cambiato fuori dagli strumenti (a mano sul file) entra alla scrittura successiva.
- Rileggere i registri dopo ogni scrittura costa una lettura di sette file: per i registri di una piccola attività è trascurabile.
- L'avviso lo vede l'agente che scrive, nel risultato dello strumento; dirlo alla persona dipende dal modello. L'owner ha sempre la vista sulla scheda.
- Nella vista dell'owner compaiono i record collegati a quella scheda e le loro sovrapposizioni, non un elenco di tutto il tenant.

## Conseguenze

- Due agenti che seguono lo stesso cliente o fornitore lo scoprono quando scrivono, e la persona lo sente prima di mandare un secondo preventivo o un secondo ordine.
- Le schede possono dire di quali record parlano, e l'owner vede chi altro li segue.
- Un registro nuovo con una controparte entra nel registro comune con una riga in `readSubjects` e una in `READS`.
