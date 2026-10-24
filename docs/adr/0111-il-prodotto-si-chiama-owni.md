# 0111: Il prodotto si chiama Owni

Il prodotto, fin qui chiamato Annie, diventa Owni. Il cambio arriva insieme a un giro di rifinitura dell'identità e dell'interfaccia, per un aspetto più curato: il nome è la prima cosa che una persona vede, sul sito, nell'app installata sul telefono (PWA), nell'app per Mac e nei messaggi che riceve su Telegram, WhatsApp e per mail. Tenere due nomi, uno nel prodotto e uno nel codice, è accettabile solo se il confine è chiaro e sta dentro il repo, non davanti alle persone.

## Decisione

- **Il nome che si vede è Owni, ovunque.** Interfaccia web, PWA, app per Mac (finestre, icona nella barra, menu, notifiche, helper per il controllo del computer), testi dell'agente, errori, mail, messaggi Telegram e WhatsApp, output da riga di comando, metadati dei file prodotti (PDF, DOCX, calendari ICS), user agent delle richieste web, documentazione e README. Il nome predefinito dell'istanza, quando `ANNIE_INSTANCE_NAME` non è impostata, è «Owni».
- **I nomi interni restano quelli di prima, come nome in codice.** Variabili d'ambiente `ANNIE_*`, nomi dei pacchetti e dei crate (`annie`, `annie-desktop`, `annie_desktop_lib`), identificatori e nomi dei file del codice, chiavi del `localStorage`, nomi delle cartelle dei dati, nomi di tabelle e cache, il repository `mariomile/annie` e la sua storia. Cambiarli non porta niente a chi usa il prodotto e costringe chi ha già un'installazione a migrare configurazione e dati. Si rinominano quando si rinomina il repository, in un unico passaggio.
- **Gli ADR vecchi restano dove sono.** I nomi dei file non cambiano, per non rompere i collegamenti; dentro il testo il nome del prodotto è Owni.
- **L'identificatore dell'app per Mac diventa `app.owni.desktop`** (prima `app.annie.desktop`), e il pacchetto si chiama `Owni.app`. È il nome con cui macOS riconosce l'app: per il sistema è un'app nuova. I permessi dati alla vecchia (Accessibilità e Registrazione dello schermo per il controllo del computer, notifiche) vanno concessi di nuovo, e la cartella dei dati dell'app locale (`~/Library/Application Support/app.owni.desktop`) parte vuota: i dati della vecchia sono ancora in `app.annie.desktop` e si possono copiare a mano.

## Conseguenze

- Chi ha un'installazione non deve cambiare niente: variabili, cartelle dei dati e indirizzi restano validi.
- Chi usa l'app per Mac deve installare `Owni.app`, togliere la vecchia Annie dall'elenco dei permessi e rifare il consenso, come descritto in `docs/desktop.md`. Chi vuole tenere i dati dell'app locale copia la cartella dalla vecchia posizione.
- Nel codice e nei log di basso livello compaiono ancora `annie` e `ANNIE_*`: è voluto, e la regola è che ogni testo che una persona legge dice Owni.
- Un'istanza già creata con il nome «Annie» lo tiene finché il nome non viene cambiato: il nome predefinito vale solo per le istanze nuove.
- Il giorno in cui si rinomina il repository si aggiornano insieme variabili, pacchetti, crate, chiavi e cartelle, con una migrazione dei dati esistenti. Questo ADR non la fa.
