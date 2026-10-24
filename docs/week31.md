# Settimana 31: avviso quando una richiesta scade

Branch `week-31`. Le richieste che aspettano una persona (moduli da inviare, ADR 0011; mail ed eventi Google, ADR 0021; azioni dei connettori, ADR 0025) scadono dopo 24 ore. Fino a ieri scadevano in silenzio: Owni aveva detto «l'esito ti arriva qui» e poi non arrivava niente. Ora la conversazione che l'ha chiesta riceve un avviso, una volta: la richiesta è scaduta, non è stata fatta, se serve ancora si può chiedere di nuovo. Owni lo dice in una frase e non la ripropone da sola.

## Come funziona

- **Il giro**: lo scheduler, dopo task e sentinelle, guarda al più ogni 5 minuti le tre code di ogni istanza (non la segreteria). Per ogni richiesta scaduta e non ancora annunciata, prima la segna come annunciata (in fila con le decisioni, così un «Approva» arrivato all'ultimo istante non si incrocia con l'avviso), poi manda l'avviso alla conversazione.
- **Una volta sola**: se l'avviso non parte (canale tolto, conversazione sparita) non viene ritentato a ogni giro: resta nell'audit con il motivo. L'ID dell'avviso è fisso, quindi anche un riavvio a metà non lo fa arrivare due volte.
- **Niente arretrati**: una richiesta scaduta da più di 6 ore (Owni spenta, o richieste di prima di questa versione) si chiude senza avviso. Nessuno riceve «la richiesta di tre settimane fa è scaduta».
- **Cosa sente il modello**: per i connettori anche cosa era la richiesta (recintata come dati), perché dopo 24 ore il turno originale può non essere più in contesto; di non citare il codice della richiesta; di non riproporla da sola. Per Google, che decide solo il titolare dell'account, «la persona non l'ha approvata né rifiutata».
- **Audit**: `connector_action.expired`, `web_action.expired`, `google_action.expired` con `told` e, se non annunciata, `reason` (`stale`, `no_conversation` o il tipo di errore).

## Cosa funziona (verificato dai test)

- Una richiesta lasciata lì 24 ore arriva in chat come scaduta, una volta; un secondo giro non dice niente e l'audit ha un solo evento; approvarla dopo non la fa partire (`test/connector-actions.test.ts`).
- Una richiesta scaduta da più di 6 ore si chiude senza messaggi (`told: false, reason: "stale"`).
- La coda dei moduli espone le scadute non annunciate e le annuncia una volta sola; il testo dice che il modulo non è partito e di non riproporlo.

## Review indipendente

Due revisori (correttezza e sicurezza, testi e uso). Corretti:

- **Media.** Un avviso che non poteva partire (canale tolto) veniva ritentato ogni 30 secondi per 30 giorni, con un evento di audit a ogni giro. Al primo avvio dopo il rilascio sarebbero arrivate in un colpo tutte le scadute degli ultimi 30 giorni. Un file illeggibile fermava il giro per tutte le istanze.
- **Bassa.** Un «Approva» all'ultimo millisecondo poteva arrivare insieme all'avviso di scadenza; il giro leggeva tutti i file ogni 30 secondi; la segreteria era inclusa; testi senza «non riproporla da sola», senza dire cosa era la richiesta e con «nessuno» anche per Google; il messaggio della richiesta che prometteva l'esito solo «quando viene decisa».

Lasciati: le card con i pulsanti già mandate su Telegram e WhatsApp non vengono modificate (un tocco risponde «scaduta») e gli approvatori non ricevono l'avviso, solo la conversazione che ha chiesto. Su WhatsApp l'avviso arriva spesso fuori dalla finestra di 24 ore di Meta: va nella coda dei messaggi in attesa o nel template, come gli altri messaggi di Owni. In un gruppo l'avviso arriva al gruppo dove la richiesta è nata.
