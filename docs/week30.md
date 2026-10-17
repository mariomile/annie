# Settimana 30: azioni dei connettori con approvazione

Branch `week-30`. Decisione: [ADR 0025](adr/0025-azioni-dei-connettori-con-approvazione.md). Gli strumenti dei servizi collegati che cambiano qualcosa (creare una issue su Linear, una pagina su Notion, un rimborso su Stripe) non partono più da soli: Annie prepara la richiesta, chi l'ha chiesta o un approvatore la legge intera e preme «Approva», e solo allora Annie la fa, una volta. Gli strumenti che il servizio indica come di sola lettura restano immediati.

## Cosa funziona (verificato dai test)

- **Lettura subito, scrittura su richiesta** (`test/connector-actions.test.ts`, server MCP di prova con uno strumento che scrive): la ricerca risponde subito; la nota non viene creata finché qualcuno non approva. Approvata, parte una volta sola, senza il motivo che Annie scrive per chi approva, e l'esito torna nella conversazione, recintato come dati.
- **Rifiuto e errori**: una richiesta rifiutata non parte mai; un errore del servizio è «non fatta», mai «fatta». Decidere due volte non cambia niente.
- **Chi decide**: la persona che l'ha chiesta (finché può scrivere ad Annie) o un approvatore. Un'altra persona non la vede e riceve 403.
- **Esattamente una volta**: lo stato «in corso» è scritto prima della chiamata; un riavvio a metà la segna «esito incerto» e non la rifà. Una richiesta scaduta (24 ore) non parte.
- **Solo dove è stata chiesta**: se nel frattempo il connettore punta a un altro servizio, la richiesta approvata non parte.
- **Spenta per connettore**: l'owner può togliere l'approvazione a un servizio di cui si fida; rimettendola, gli strumenti tornano ad aspettare.
- **Console** (Chromium, desktop e telefono, nessun errore): card in Approvazioni e sopra la chat da cui è partita, contatore nel menu, casella nel modulo del connettore, riga sulla card del connettore con gli strumenti che chiedono. Su Telegram e WhatsApp la card ha «Approva» e «Rifiuta».

## Review indipendente

Due revisori separati (standard e sicurezza, spec e uso). Corretti:

- **Alta.** La console mostrava i valori tagliati a 2.000 caratteri ma l'approvazione faceva partire quelli interi: ora un valore oltre 5.000 caratteri è rifiutato e chi approva vede sempre tutto quello che parte.
- **Media.** Nessun limite al numero di dati e ai nomi: card troppo lunghe per la chat e righe false («Azione: …») con un a capo nel nome o nel motivo; titolo dello strumento scelto dal servizio mostrato come unica descrizione e messo fuori dal recinto nell'esito; il modello invitato a richiamare lo strumento a ogni sollecito; «l'ha rifiutata la persona» anche quando decideva un approvatore; la card dei moduli lunghi che rimandava alla console anche chi non poteva decidere lì; nessuna card nella chat web.
- **Bassa.** Richiesta approvata che seguiva il connettore anche se ora puntava a un altro server; un rifiuto della egress policy contato come «esito incerto»; una richiesta già decisa annunciata di nuovo a una nuova esecuzione; argomento dello strumento con lo stesso nome del motivo; avviso rosso «può cancellare» su ogni scrittura; testi («Approvata, Annie la fa», «falle decidere prima», «Annie legge da sola» anche quando il servizio non lo dice); ordine degli import e nomi.

Lasciati e scritti nell'ADR: l'avviso alla conversazione quando una richiesta scade, la lista degli strumenti di sola lettura scelta dall'owner, il fatto che `readOnlyHint` lo dichiara il servizio, il limite di richieste in attesa che con molte proposte insieme può essere superato di poco (come per i moduli).

## Limiti

| Cosa | Limite |
|---|---|
| Richieste in attesa per istanza | 20 |
| Validità di una richiesta | 24 ore |
| Dati per richiesta | 50, nomi fino a 100 caratteri |
| Un valore | 5.000 caratteri (tutti i dati: 20.000) |
| Card in chat con «Approva» | valori fino a 300 caratteri, card fino a 1.500 |
| Risposta del servizio conservata | 8.000 caratteri |
