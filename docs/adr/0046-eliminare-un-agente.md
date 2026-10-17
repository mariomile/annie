# Eliminare un agente

Con più agenti per tenant ([ADR 0041](0041-agenti.md)) serviva anche il contrario di «Nuovo agente»: toglierne uno fatto per prova, o che non serve più. Finora l'owner poteva solo togliere a tutti il permesso di scrivergli, e l'agente restava lì con bot, chiavi, automazioni e file.

## Decisione

- **Solo l'owner, dalla console**, nella card «Elimina agente» in fondo a Impostazioni. Il dialogo dice cosa se ne va e che non si può annullare, e il pulsante si attiva solo quando l'owner scrive il nome dell'agente com'è adesso. Il server ricontrolla il nome (`DELETE /api/instances/:id` con `{ "confirm": "<nome>" }`): un nome sbagliato o mancante è un 400, un membro riceve 403.
- **Non si eliminano l'agente principale né la segreteria.** Il principale è quello che Annie crea a ogni avvio (`ANNIE_INSTANCE_ID`, con il bot del `.env`): eliminarlo lo farebbe solo ricomparire vuoto. La segreteria si configura dal server. Per loro la card non c'è e il server risponde 400.
- **Prima si ferma tutto quello che arriva all'agente da fuori**, così niente lo riapre mentre se ne va: la chat web e il canale degli altri agenti, il bot Telegram (che in modalità webhook chiede anche a Telegram di smettere di mandare aggiornamenti), il numero WhatsApp e il telefono, e i task programmati e le sentinelle (lo scheduler legge l'elenco degli agenti a ogni giro).
- **Poi il core lo chiude e cancella la sua cartella** (`AnnieRuntime.removeInstance`): l'agente aperto si chiude senza riprendere il lavoro in corso, che se ne va con lui, e nel frattempo nessuno lo può riaprire. La cartella `instances/<id>/` viene prima spostata in `removed/` con un solo `rename`, così l'agente sparisce subito anche se cancellare i file richiede tempo o si interrompe a metà; quello che resta in `removed/` si cancella al prossimo avvio. Nella cartella c'è tutto quello che l'agente aveva: conversazioni, sessione del modello, memoria, persone conosciute, liste, workspace, task, sentinelle, richieste in attesa, tool approvati, connettori, outbox, preferenze di voce, finestra WhatsApp.
- **Infine quello che teneva fuori dalla sua cartella**: le chiavi nel secret store del tenant (token del bot Telegram e segreto del webhook, credenziali WhatsApp e Twilio, token OAuth dei connettori MCP e token incollati nei connettori in un clic; i segreti che l'owner nomina negli header di un connettore restano, perché può usarli anche un altro agente), i browser aperti nelle sue conversazioni, il suo computer e il suo schermo (cancellati con i loro file; uno schermo remoto condiviso non si tocca), e il permesso degli altri agenti di ricevere messaggi da lui. Quest'ultimo conta: un agente nuovo con lo stesso ID non deve ereditare la fiducia del vecchio. Un passo di questa parte che fallisce finisce nel log dell'operatore e non ferma gli altri: l'agente è già eliminato.
- **L'ID torna libero**: un agente creato dopo con lo stesso ID parte vuoto.

## Cosa resta

- **L'audit log del tenant**: è la traccia di cosa è successo, e ci restano le righe dell'agente eliminato, più `instance.deleted` (ID e nome) e `web.instance_deleted` (chi l'ha eliminato).
- **Il registro dei costi**: le spese già fatte restano nel mese in cui sono state fatte.
- **Il numero Twilio** resta puntato su Annie finché l'owner non lo cambia da Twilio; le chiamate vengono rifiutate prima di rispondere, senza costi, come dopo «Scollega».
- **Le risposte di altri agenti** indirizzate all'agente eliminato vengono scartate senza riprovare ([ADR 0042](0042-agenti-che-si-scrivono.md)).
