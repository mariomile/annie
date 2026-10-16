# Fase 4, voce: chiamate vocali su un numero di telefono, a turni, con Twilio

Annie risponde al telefono. Ogni istanza può avere un numero (Twilio): chi è in elenco chiama, parla, e Annie risponde a voce, un turno alla volta. È la stessa conversazione di sempre (stesso agente, stessi tool, stessa memoria della persona), con un canale in più che si chiama `phone`.

Perché a turni e non in streaming: con la voce in tempo reale servirebbero un riconoscimento e una sintesi vocale nostri, l'audio che passa dalla cella, e un modello che risponde in meno di un secondo. Annie ragiona e usa tool: una risposta può chiedere dieci secondi. A turni Twilio fa riconoscimento e sintesi (`<Gather input="speech">` e `<Say>`), la cella riceve solo testo via webhook, e i tempi lunghi si coprono con un «un momento» invece di un silenzio.

## Come funziona

- L'owner collega il numero dalla console (Impostazioni, Telefono) con Account SID, auth token e numero: Annie controlla le credenziali con Twilio e imposta da sola l'indirizzo delle chiamate del numero (`VoiceUrl`) sul webhook della cella. Serve un indirizzo https pubblico.
- Chi può chiamare lo decide l'owner, numero per numero. Una chiamata da un numero non in elenco viene rifiutata prima di rispondere (`<Reject>`, non costa).
- Ogni webhook è firmato da Twilio (`X-Twilio-Signature`, HMAC-SHA1 con l'auth token su indirizzo e parametri): senza firma giusta, 403.
- La conversazione è per numero, privata: Annie sa con chi parla e usa le sue memorie. Ogni frase detta è un messaggio con un ID (chiamata e turno), quindi un webhook ripetuto non la manda due volte.
- La risposta di Annie arriva come per gli altri canali; il canale la tiene da parte (su disco) e la fa dire a Twilio appena pronta. La cella aspetta fino a 8 secondi per webhook; se serve di più dice «un momento» e Twilio richiama. Dopo circa un minuto la chiamata si chiude con «richiamami»: la risposta resta da parte e Annie la dice all'inizio della chiamata dopo.
- «Ciao», «grazie, ciao», «basta» chiudono la chiamata.

## Limiti voluti

- Niente schede di approvazione al telefono: le richieste che chiedono un'approvazione (moduli web, tool proposti) arrivano su Telegram, WhatsApp o nella console, come sempre.
- Niente file: un file pronto viene solo nominato.
- Annie non chiama per prima.
- Link e formattazione non si leggono ad alta voce: Annie dice «un link» e salta i simboli. Le risposte molto lunghe vengono tagliate.

## Alternative scartate

- **Voce in tempo reale** (Twilio Media Streams, un modello vocale): latenza migliore, ma audio nella cella, costi per minuto molto più alti e niente tool lunghi. Dopo, se le persone lo chiedono.
- **Chiamate WhatsApp**: l'API di Meta per le chiamate passa da WebRTC, che chiede un server media. Più tardi.
- **Un altro provider (Telnyx, Vonage)**: Telnyx parla lo stesso TwiML, ma firma diversamente. Si aggiunge quando serve.

## Conseguenze

- La voce va a Twilio, che fa riconoscimento e sintesi: per i dati in UE Twilio offre la regione Irlanda (`ANNIE_TWILIO_API`), da scegliere prima di aprire il servizio.
- Il costo delle chiamate lo fattura Twilio all'owner; non passa dal contatore di spesa di Annie, che conta solo il modello.
- Auth token e Account SID vivono nel registro dei segreti del tenant, mai nei log.
