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

## Cosa funziona (verificato dai test)

`test/appointment-slots.test.ts`: orari con le pause, festivi e chiusure; conflitti, fuori orario, chiuso, ora passata, appuntamento escluso quando si sposta; risorse; orari liberi in una finestra; gli orari più vicini; i buchi del giorno; il 25 ottobre e il 29 marzo con gli stessi orari.

`test/appointments.test.ts`: appuntamento dettato fissato subito, con nome e riferimento solo nel recinto e audit con operazione e conteggio, nessun doppio con la stessa chiamata; cliente simile e durata non conosciuta con proposta e controllo (sbagliato rifiutato, avviso non della persona rifiutato); cliente nuovo e «alle 3»; conflitto con gli orari vicini, domenica, Immacolata, fuori orario e ora passata; risorse; cambio dell'ora con «adesso» letto nel fuso giusto; spostamento «stessa ora», disdetta che libera l'ora, non presentato solo dopo l'inizio, fatti tutti quelli di oggi; orari liberi, agenda con i buchi, storico con «di solito fa»; promemoria nel recinto con i contatti delle schede e mai mandati; brief una volta al giorno; altri agenti solo conteggi; CSV protetto; impostazioni con chiusura che avvisa degli appuntamenti; fattura degli appuntamenti fatti con prezzi dal listino e prezzo chiesto, bozza che li tiene, segnati all'emissione una volta sola, mai due volte; appuntamento non più fatto che blocca l'emissione prima del numero; nota di credito per il cliente sbagliato che li rimette da fatturare; istradamento.
