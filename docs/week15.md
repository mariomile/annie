# Settimana 15: WhatsApp oltre le 24 ore

Branch `week-15`. Fase 4 del [piano](piano-cloud.md).

WhatsApp lascia scrivere liberamente solo entro 24 ore dall'ultimo messaggio della persona. Il brief del mattino e i promemoria arrivano spesso dopo, e prima di questa settimana Meta li scartava senza che la persona lo sapesse.

## Cosa funziona (verificato dai test, con un finto Graph API)

- **Annie sa quando la finestra è aperta** (`test/whatsapp.test.ts`): ricorda quando ogni numero ha scritto l'ultima volta, su disco, così vale anche dopo un riavvio.
- **Fuori finestra il messaggio aspetta**: viene tenuto da parte (al massimo 20 per persona) e consegnato appena la persona scrive, prima della risposta al suo nuovo messaggio, con i suoi pulsanti. Se la consegna fallisce, torna in attesa.
- **Avviso con template**: se l'owner ha fatto approvare un template da Meta e lo indica nella console (nome e lingua), Annie lo manda subito con un estratto del messaggio nella variabile `{{1}}`, su una riga sola come Meta chiede.
- **Senza template**: il messaggio aspetta in silenzio e il log lo dice.
- **I file non aspettano**: fuori finestra vengono rifiutati, e l'errore lo dice.
- **Console**: nome e lingua del template nella scheda WhatsApp, controllati; vuoti lo tolgono.

## Limiti

| Cosa | Limite |
|---|---|
| Template | va creato e fatto approvare in WhatsApp Manager (docs/chiavi.md, punto 9) |
| Prima risposta | per chi non ha ancora scritto dopo l'aggiornamento la finestra non è nota: il messaggio parte e, se Meta lo rifiuta dopo, finisce nel log |
| Messaggi in attesa | al massimo 20 per persona: i più vecchi si perdono |
| Costo | ogni template è una conversazione a pagamento secondo il listino di Meta |
