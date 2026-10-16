# Settimana 15: WhatsApp oltre le 24 ore

Branch `week-15`. Fase 4 del [piano](piano-cloud.md).

WhatsApp lascia scrivere liberamente solo entro 24 ore dall'ultimo messaggio della persona. Il brief del mattino e i promemoria arrivano spesso dopo, e prima di questa settimana Meta li scartava senza che la persona lo sapesse.

## Cosa funziona (verificato dai test, con un finto Graph API)

- **Annie sa quando la finestra è aperta** (`test/whatsapp.test.ts`): ricorda quando ogni persona ammessa ha scritto l'ultima volta, su disco, così vale anche dopo un riavvio. Conta l'ora del messaggio: uno vecchio che Meta riconsegna non riapre niente. Gli estranei non vengono registrati.
- **Fuori finestra il messaggio aspetta**: viene tenuto da parte una volta sola (anche se l'invio viene ritentato), al massimo 20 per persona, e consegnato appena la persona scrive, prima della risposta al suo nuovo messaggio, con i suoi pulsanti. Esce dall'attesa solo dopo essere partito; se la consegna fallisce a metà, resta e riparte con l'avviso di possibile doppione.
- **Avviso con template**: se l'owner ha fatto approvare un template da Meta e lo indica nella console (nome e lingua), Annie lo manda con un estratto del messaggio nella variabile `{{1}}`, su una riga sola come Meta chiede. Uno solo per finestra chiusa, anche con più messaggi in attesa. Se Meta rifiuta il template, il messaggio aspetta comunque e il log lo dice.
- **Senza template**: il messaggio aspetta in silenzio e il log lo dice.
- **I file non aspettano**: fuori finestra vengono rifiutati, e l'errore lo dice.
- **Console**: nome e lingua del template nella scheda WhatsApp, controllati; vuoti lo tolgono.

## Review indipendente

Due revisori separati. Corretti:

- **Alta.** Se l'invio del template falliva, il messaggio restava in attesa e l'invio veniva ritentato: la persona l'avrebbe ricevuto più volte. Ora un messaggio si tiene una volta sola (per chiave) e un template rifiutato non fa fallire l'invio. Un messaggio vecchio riconsegnato da Meta segnava la finestra come aperta e i messaggi in attesa partivano verso un rifiuto, persi.
- **Media.** I messaggi uscivano dall'attesa prima di partire (persi in caso di crash); ogni messaggio in attesa mandava il suo template a pagamento; salvare la scheda WhatsApp chiamava Meta anche senza cambiare il template; gli estranei riempivano il file.
- **Bassa.** Estratto troppo lungo per il limite di Meta e con emoji spezzate; file rovinato che bloccava il canale (ora messo da parte); controllo del template salvato.

## Limiti

| Cosa | Limite |
|---|---|
| Template | va creato e fatto approvare in WhatsApp Manager (docs/chiavi.md, sezione 9, passo 8); la console controlla solo il formato del nome, non che Meta l'abbia approvato |
| Prima risposta | per chi non ha ancora scritto dopo l'aggiornamento la finestra non è nota: il messaggio parte e, se Meta lo rifiuta dopo, finisce nel log |
| Messaggi in attesa | al massimo 20 per persona: i più vecchi si perdono (scritto nel log). Nel registro un messaggio in attesa risulta consegnato |
| Ordine | un messaggio che parte mentre quelli in attesa vengono consegnati può arrivare tra loro |
| Costo | Meta fa pagare ogni template secondo il suo listino: uno per finestra chiusa |
