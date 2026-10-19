# Settimana 74: appuntamenti e prenotazioni

Branch `week-74`. Annie tiene gli appuntamenti di un'attività di servizi (parrucchiere, estetista, studio, officina, consulente): li fissa controllando orari, chiusure e sovrapposizioni, trova gli orari liberi, segna com'è andata, prepara i promemoria per i clienti senza mandarli, e fattura gli appuntamenti fatti. Le scelte sono nell'[ADR 0094](adr/0094-appuntamenti-e-prenotazioni.md).

## Cosa cambia per chi usa Annie

- **«Fissa la signora Rossi giovedì alle 15 per taglio e piega»**: fissato se tutto è chiaro e l'ora è libera; se l'ora è presa o il negozio è chiuso, i tre orari liberi più vicini; se il cliente o un servizio sono solo simili a come sono stati detti, o non sa quanto dura un servizio (conta 30 minuti), prima la proposta.
- **«Quando ho un'ora libera giovedì pomeriggio?»**: gli orari in cui si può cominciare, per risorsa se ci sono.
- **«Sposta Rossi a venerdì stessa ora»**, **«Rossi ha disdetto»**, **«Rossi non si è presentata»**, **«segna fatti quelli di oggi»**: solo con la parola della persona; l'appuntamento resta nello storico.
- **«Cosa ho domani?»**, la settimana: quanti, da che ora a che ora, i buchi liberi.
- **«Com'è andata con Rossi?»**: le ultime visite, i «non presentato», cosa fa di solito.
- **«Fammi il messaggio di promemoria per gli appuntamenti di domani»**: un testo per cliente, con il nome dell'attività; per chi ha l'email, la bozza della mail con approvazione; gli altri si copiano su WhatsApp o SMS.
- **«Fattura gli appuntamenti fatti da Bianchi questo mese»**: la bozza con una riga per servizio, i prezzi dal listino e quelli che mancano chiesti; segnati fatturati solo quando la fattura è emessa.
- **«Siamo aperti mar-sab 9-13 e 14:30-19»**, **«chiusi dal 10 al 20 agosto»**, **«il taglio dura 30 minuti»**, **«le poltrone sono Marco e Giulia»**: le impostazioni.
- **Nel brief**: gli appuntamenti di oggi e quelli di ieri ancora da segnare.

## Dopo la revisione

- «Alle 3» diventa le 15 solo se di mattina sei chiuso e di pomeriggio aperto, e lo dice; se vanno bene tutte e due, o nessuna, chiede. «07:30» resta 7:30. Capisce «alle 3 e mezza», «15 e 30», «mezzogiorno».
- «Giovedì» detto di giovedì con l'ora già passata è giovedì prossimo, e lo dice.
- Se l'appuntamento comincia in orario ma finirebbe nella pausa o dopo la chiusura, lo spiega e propone gli orari vicini, raggruppati per giorno. Su una sovrapposizione dice con cosa; con «fissalo lo stesso» lo fissa.
- Disdire, spostare o segnare un appuntamento con un nome solo simile al cliente chiede prima «Intendi questo appuntamento?».
- Gli orari liberi sono finestre («sei libero dalle 14 alle 17:30»); i buchi per risorsa; gli orari scritti compatti.
- I promemoria hanno il saluto con il titolo («signora Rossi»), la data, e per chi ha il cellulare il link di WhatsApp con il testo già scritto: lo tocchi e lo mandi tu. Dopo aver fissato, propone il messaggio di conferma; il calendario Google solo se è collegato.
- I «non presentato» sono contati («È la terza volta che non si presenta»).
- Fattura degli appuntamenti: chiede se il cliente ha già pagato con lo scontrino (punto fiscale aperto, da vedere con il commercialista); le voci a ore contano i minuti; se detti voci che sono appuntamenti fatti, chiede prima; dopo una nota di credito per cliente sbagliato, la fattura si rifà allo stesso modo intestata al cliente giusto.

## Cosa funziona (verificato dai test)

`test/appointment-slots.test.ts`: orari con le pause, festivi e chiusure; conflitti, fuori orario, chiuso, ora passata, appuntamento escluso quando si sposta; risorse; orari liberi in una finestra; gli orari più vicini; i buchi del giorno; il 25 ottobre e il 29 marzo con gli stessi orari.

`test/appointments.test.ts`: appuntamento dettato fissato subito, con nome e riferimento solo nel recinto e audit con operazione e conteggio, nessun doppio con la stessa chiamata; cliente simile e durata non conosciuta con proposta e controllo (sbagliato rifiutato, avviso non della persona rifiutato); cliente nuovo e «alle 3»; conflitto con gli orari vicini, domenica, Immacolata, fuori orario e ora passata; risorse; cambio dell'ora con «adesso» letto nel fuso giusto; spostamento «stessa ora», disdetta che libera l'ora, non presentato solo dopo l'inizio, fatti tutti quelli di oggi; orari liberi, agenda con i buchi, storico con «di solito fa»; promemoria nel recinto con i contatti delle schede e mai mandati; brief una volta al giorno; altri agenti solo conteggi; CSV protetto; impostazioni con chiusura che avvisa degli appuntamenti; fattura degli appuntamenti fatti con prezzi dal listino e prezzo chiesto, bozza che li tiene, segnati all'emissione una volta sola, mai due volte; appuntamento non più fatto che blocca l'emissione prima del numero; nota di credito per il cliente sbagliato che li rimette da fatturare; istradamento.

`test/appointments-review.test.ts` (revisione): nome simile che chiede «Intendi questo appuntamento?» con controllo legato all'operazione; mattino o pomeriggio dagli orari, «07:30», «3 e mezza», «mezzogiorno», «15 e 30», domanda quando vanno bene tutti e due o nessuno; fatto e non presentato per riferimento solo dopo l'inizio; stessa chiamata ripetuta per fissare, spostare e disdire; nota di credito per cliente sbagliato e fattura rifatta al cliente giusto, domanda sullo scontrino; voci dettate che sono appuntamenti fatti; export solo con la parola della persona; impostazioni sotto il blocco; giorni oltre un anno; file illeggibile nel brief; voci a ore; fine nella pausa; «fissalo lo stesso» solo della persona e mai nel passato; giorno di oggi con l'ora passata; buchi per risorsa e più corti del servizio più breve; finestre tagliate agli orari e orari compatti; tre «non presentato»; ieri da segnare nel brief; cellulari italiani; conferma con link WhatsApp e calendario solo se collegato; istradamento. `test/appointment-slots.test.ts` in più: indice per giorno, buchi per risorsa, posto fino alla pausa e `force`.
