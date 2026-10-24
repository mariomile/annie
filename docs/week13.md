# Settimana 13: Owni su WhatsApp

Branch `week-13`. Fase 4 del [piano](piano-cloud.md).

## Cosa funziona (verificato dai test, con un finto Graph API di Meta)

- **Un numero WhatsApp Business per istanza** (`test/whatsapp.test.ts`): l'owner lo collega in Impostazioni → WhatsApp con token di accesso, ID del numero e app secret. Meta controlla token e numero prima che cambi qualcosa. Token e app secret restano nel registro dei segreti e non tornano mai alla console.
- **Webhook** `/hooks/whatsapp/<istanza>`: risponde alla verifica di Meta solo con il nostro token, e accetta solo consegne firmate con l'app secret (HMAC-SHA256 sul corpo grezzo). La console mostra indirizzo e token di verifica da incollare nell'app Meta.
- **Messaggi**: testo e documenti con didascalia, scaricati solo per chi può scrivere, al massimo 20 MB, con il token mandato solo agli host di Meta in https. Un file che non si può scaricare non blocca niente: il messaggio arriva con una nota. Un messaggio che fallisce tre volte viene lasciato andare e scritto nel log, così Meta smette di riconsegnarlo. Note vocali, foto e sticker per ora vengono ignorati. Ogni chat è una persona sola, quindi la sua memoria vale.
- **Chi può scrivere**: numeri con prefisso internazionale; gli altri non ricevono risposta. Una consegna ripetuta da Meta non produce una seconda risposta.
- **Risposte**: testi lunghi in più messaggi da 4096 caratteri, senza spezzare le emoji; file come documenti con il loro tipo (PDF, Office, testo, immagini; gli altri tipi vengono rifiutati).
- **Finestra di 24 ore**: un messaggio che Meta non consegna, anche se lo segnala dopo sul webhook, finisce nel log con il motivo.

Non coperti da test dedicati, ma sullo stesso codice di Telegram: le schede di approvazione con i pulsanti Approva e Rifiuta (ora un'unica funzione per entrambi i canali), il possibile doppione, i task programmati in una chat WhatsApp che agiscono per conto di quella persona.

## Review indipendente

Due revisori separati. Corretti:

- **Alta.** Un file che non si poteva scaricare (oltre 20 MB, su un indirizzo inatteso) faceva rispondere 500 al webhook: Meta riconsegnava per giorni e i messaggi successivi nella stessa consegna non passavano. Ora il messaggio passa con una nota, e un messaggio che fallisce tre volte viene lasciato andare.
- **Media.** I file partivano come `application/octet-stream`, che WhatsApp probabilmente rifiuta: ora con il tipo giusto. Il fallimento fuori dalle 24 ore arriva di solito dopo, sul webhook, e veniva ignorato: ora finisce nel log. Mancavano alcuni codici di Meta da ritentare (131056 e gli errori temporanei).
- **Bassa.** Emoji spezzate al confine dei messaggi; token mandato anche in http; credenziali salvate rovinate bloccavano l'avvio; documenti che dicevano WhatsApp fuori perimetro.

## Limiti

| Cosa | Limite |
|---|---|
| Prova dal vivo | solo contro un finto Graph API: serve un'app Meta con numero di test (docs/chiavi.md, punto 9) |
| Messaggi oltre le 24 ore | brief e promemoria arrivano solo se la persona ha scritto nelle ultime 24 ore; per gli altri servono i template approvati da Meta |
| Voce, immagini | ignorate: arriveranno con la voce |
| Gruppi | la Cloud API lavora con chat individuali |
| Nomi utente WhatsApp | chi scrive è riconosciuto dal numero; chi usa un nome utente al posto del numero non passerebbe l'elenco «Chi può scrivere» |
| Dati in UE | i messaggi passano da Meta: da verificare l'archiviazione locale della Cloud API |
| Costi | Meta fa pagare le conversazioni secondo il suo listino, a parte dall'abbonamento a Owni |
