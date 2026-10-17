# Settimana 36: grafici

Branch `week-36`. Annie dava i numeri come elenchi. Ora `chart_create` disegna un grafico a barre, a linee o a torta e lo manda in chat come una foto, su Telegram, WhatsApp o nella console, oppure lo salva per metterlo in un Word o in un PDF con `document_create`. Come funziona, i limiti e le alternative scartate sono nell'[ADR 0030](adr/0030-grafici.md).

## Cosa cambia per chi usa Annie

- **«Fammi un grafico del fatturato di quest'anno»**: barre per mese con gli importi in «€ 12,5 mila», il mese migliore e l'ultimo scritti sopra, e se lo chiedi la linea dell'obiettivo.
- **«Come sono andate le visite nell'ultimo anno?»**: una linea con le date in italiano e il valore finale.
- **«Dove vanno le spese?»**: una torta con il totale al centro e le voci con importo e quota; le più piccole in «Altri».
- **«I prodotti più venduti»**: barre in ordine, in orizzontale quando i nomi sono lunghi.
- **«Fammi un grafico da questo CSV»**: le etichette dalla prima colonna, una serie per colonna; anche con gli anni come intestazione, e senza contare due volte la riga «Totale».
- **«Mettilo nel report»**: il grafico salvato va dentro il PDF o il Word.

## Cosa funziona (verificato dai test)

- Rasterizzatore: copertura esatta sui bordi (mezzo pixel, mezzo grigio), pezzi sovrapposti che si sommano, buchi delle lettere, bordi obliqui fuori dall'immagine tagliati al pixel giusto (`test/charts.test.ts`).
- Numeri: formato italiano, unità, scala corta comune ad asse e valori, decimali per i numeri piccoli, arrotondamento come è scritto (12,45 → 12,5), passi dell'asse rotondi e mai più di una dozzina anche con intervalli minimi o enormi.
- Grafici: colori nell'ordine fisso per barre, barre impilate e linee; barre in orizzontale con nomi lunghi; torta con «Altri» in grigio; ordine per valore; date in italiano; obiettivo in legenda; emoji tolte e altri alfabeti segnalati.
- Rifiuti con il motivo: nessuna serie, troppe serie, valori in più delle etichette, valori non numerici, troppo grandi o troppo piccoli, torta con negativi o con più serie, linea di un punto, troppe barre, barre troppo sottili, tipo sconosciuto.
- Worker: una linea di 8 serie da 1.000 punti disegnata nel worker; gli errori arrivano con il loro messaggio.
- Il tool: grafico salvato in `grafici/` e mandato; solo salvato con `send: false`; numeri scritti come testo; CSV con colonne di note, anni come intestazione, riga «Totale», troppo lungo o troppo largo; nomi doppi nello stesso secondo; nessun file esistente sostituito fuori da `grafici/`.
- In un'istanza vera: dalla chat un grafico a torta arriva nella conversazione e finisce in un PDF.
- Nel browser: in chat della console il grafico compare come immagine e tra i file. Nessun errore in console.

## Review indipendente

Due revisori: sicurezza e standard; specifiche e uso, con 34 grafici disegnati e guardati a dimensione di telefono. Corretti:

- **Alta (sicurezza).** Una linea con due valori quasi uguali (0,1 + 0,2 e 0,3) faceva girare il calcolo dei passi dell'asse all'infinito e teneva occupato per 20 secondi uno dei due worker che leggono i documenti di tutti. Ora i passi sono contati, al massimo una dozzina. Valori enormi (1e308) davano immagini vuote: ora c'è un limite.
- **Media (sicurezza).** Un CSV di 500.000 righe faceva cadere il tool e uno di un milione di colonne bloccava il processo per 3 secondi: ora righe e colonne sono contate prima di leggere i numeri. Il rasterizzatore sbagliava l'area dei bordi obliqui che uscivano dall'immagine. Due grafici nello stesso secondo si sovrascrivevano, e un `path` poteva sostituire una foto. Lo schema rifiutava i numeri scritti come testo che il tool sapeva leggere. Mancava la licenza del font in `NOTICE`.
- **Alta (uso).** Il testo era leggibile solo ingrandendo: ora l'immagine è 1200 × 900 e le scritte sono 1,3-1,6 volte più grandi. I valori sulle barre uscivano tagliati («€ 12.4…»): ora una scala corta («€ 12,5 mila») e solo i valori che entrano. 0,003 diventava 0,00. Un CSV con gli anni come intestazione perdeva l'intestazione. Le etichette delle barre affiancate si coprivano. Asse e valori usavano scale diverse.
- **Media (uso).** 40 settimane finivano in una classifica orizzontale; i titoli lunghi erano tagliati a metà parola senza dirlo; il totale di una barra con entrate e uscite sembrava il valore dell'ultimo pezzo; «Altri» prendeva il rosso; il totale di una torta in percentuale non aveva senso; la riga «Totale» di un CSV era contata due volte; le emoji diventavano «?».
- **Bassa.** Date in formato ISO, nomi lunghi su una riga sola, niente ordinamento né linea di obiettivo, etichette mancanti numerate 1, 2, 3 senza dirlo, messaggi d'errore con tre due punti di fila, lo spazio tra i pezzi impilati più sottile della regola.

Lasciato, scritto nell'ADR: niente interattività (è una foto), solo lettere latine.
