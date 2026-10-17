# Le immagini al modello: foto dai canali e dal workspace

Fino alla settimana 20 una foto mandata ad Annie si perdeva: su Telegram e WhatsApp non arrivava, sul web era un file come un altro. Ora Annie vede le foto che le persone le mandano e può riaprire le immagini del workspace.

## Come funziona

- **Riconosciute dal contenuto.** Un file è un'immagine se i suoi primi byte sono di un JPEG, un PNG, un GIF o un WebP, qualunque nome o tipo dichiari. SVG no: può contenere script, e non serve al modello.
- **Un solo percorso per tutti i canali.** L'adapter consegna gli allegati, il gateway li salva in `uploads/` e passa le immagini con il messaggio; il core le controlla (al massimo 4 per messaggio, 20 MB ciascuna) e scrive nel testo quelle lasciate fuori e perché, così il modello può dirlo alla persona. Nel testo resta anche il percorso di ogni immagine, per riaprirla dopo con `image_view`.
- **Telegram**: la dimensione più grande della foto entro il limite; un album (una foto per update) diventa un messaggio solo, nello stesso giro di polling o aspettando 1,5 secondi le altre foto via webhook. Una foto che non si può scaricare è detta nel messaggio, non lo fa perdere. **WhatsApp**: foto con la didascalia come testo, e gli sticker fermi (WebP). **Web**: le foto si allegano con File, si trascinano o si incollano, si vedono prima di inviare e restano in miniatura nella conversazione; il caricamento non sovrascrive mai un file con lo stesso nome.
- **Rimpicciolite per strada.** Una foto più grande di quanto il modello accetti (4,5 MiB in base64, il limite di Anthropic con margine) viene raddrizzata, scalata e ricodificata con Photon in un worker, nell'adapter di Pi Durable. Il workspace tiene l'originale.
- **Solo le ultime nel contesto.** La storia durevole tiene le immagini, ma a ogni richiesta solo i 2 messaggi più recenti con immagini le mostrano al modello; negli altri c'è una riga che dice di riaprirle con `image_view`. Così una chat lunga non manda di nuovo ogni foto a ogni turno (costo e limite di 32 MB per richiesta).
- **Mai nell'audit.** `message.received` conta le immagini, non le contiene. La console mostra in pagina solo file le cui byte sono immagini, con `nosniff` e senza cache.
- **Modelli senza vista**: Pi sostituisce le immagini con un segnaposto, e il modello lo dice.

## Alternative scartate

- **Rimpicciolire nel browser**: copre solo il web. Farlo nell'adapter vale per tutti i canali e per `image_view`.
- **Tenere le foto fuori dalla storia durevole** (solo un riferimento al file): la storia di Pi deve poter rifare una richiesta identica dopo un crash; togliere le immagini dalla singola richiesta (hook `beforeRequest`) ottiene lo stesso risparmio senza toccarla.
- **Un tool di visione separato** (descrivere la foto con un altro modello): più costi e una perdita di dettaglio; i modelli di oggi leggono le immagini direttamente.

## Conseguenze

- Le foto restano nel workspace finché qualcuno non le cancella, come gli altri file, e nella storia della conversazione dentro Pi Durable.
- Un'immagine da rimpicciolire prende un secondo o due di CPU nel worker; il worker si chiude da solo dopo 30 secondi senza immagini.
- `image_view` può aprire qualunque immagine del workspace dell'istanza, come `file_read` per i file.
