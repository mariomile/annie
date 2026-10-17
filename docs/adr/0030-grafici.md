# Grafici: barre, linee e torta come immagini

Annie leggeva e scriveva tabelle (ADR 0026, 0029) ma, davanti a «fammi vedere l'andamento del fatturato», poteva solo elencare numeri. Un grafico è la risposta che una persona si aspetta in chat, e in un report o in un preventivo. Il computer di Annie poteva disegnarlo con Python, ma non tutte le istanze hanno il computer, e un grafico non deve costare una macchina virtuale.

## Decisione

Un tool, `chart_create`: Annie passa le etichette e le serie di numeri (o un CSV del workspace) e ottiene un PNG in `grafici/`, mandato nella conversazione come una foto, oppure salvato per metterlo in un documento con `document_create` (`![grafico](grafici/…png)`). Tre forme: barre (anche impilate, in orizzontale, in ordine di valore), linee, torta ad anello. Tutto scritto qui, senza dipendenze e senza font installati sul server: un rasterizzatore che riempie forme con l'antialiasing esatto (l'area di ogni pixel coperta dalla forma, come font-rs) e i contorni delle lettere latine di DejaVu Sans copiati nel codice da uno script.

## Come appare

- **Le regole del grafico pulito.** Barre sottili con l'estremità arrotondata e la base dritta, linee di 2 punti, griglia leggera, otto colori in un ordine fisso già verificato per il daltonismo (gli stessi del metodo dei grafici che usiamo), testo in nero o grigio e mai nel colore della serie, legenda da due serie in su. Una sola scala: niente due assi.
- **Per il telefono.** 1200 × 900 pixel, pensato per essere visto a circa 360 punti di larghezza in una chat: le scritte degli assi arrivano a 9 punti circa, il titolo a 15.
- **Numeri all'italiana.** 1.234,5; € e $ davanti, % e le altre unità dopo. Da 10 mila in su una scala corta, la stessa sull'asse e sui valori: «€ 12,5 mila», «2,3 Mln», «1,8 Mld». I decimali sono quelli con cui sono scritti i dati, e abbastanza per i numeri piccoli (0,003 resta 0,003).
- **Valori scritti dove entrano.** Su poche barre tutti; quando non entrano tutti, il più alto, il più basso e l'ultimo; mai un numero tagliato o sopra una barra. Le linee hanno il valore finale di ogni serie, se le serie sono al massimo quattro e non si accavallano.
- **Etichette.** Sotto le barre su due righe; se non entrano, le barre vanno in orizzontale (fino a 24), a meno che siano periodi (mesi, settimane, trimestri, anni, date), che restano in fila da sinistra a destra con un'etichetta ogni tanto. Le date diventano «17 ott», con l'anno dove cambia.
- **Torta.** Al massimo sei fette, le più piccole raccolte in «Altri» in grigio; il totale al centro (non per le percentuali, che sono già quote); accanto il nome, il valore e la quota di ogni fetta.
- **Obiettivo.** `target` disegna una linea di riferimento (un obiettivo, un budget, una media); nome e valore stanno nella legenda, mai sopra le barre.
- **Cosa non va, detto.** Il risultato del tool dice cosa è cambiato: un titolo accorciato, le voci raccolte in «Altri», i nomi che sotto le barre non entrano, lettere di altri alfabeti scritte come «?» (le emoji sono tolte), una riga «Totale» di un CSV lasciata fuori, colonne che non sono numeri.

## Sicurezza e limiti

I numeri possono venire da un CSV scaricato dal web o da un messaggio. Per questo:

- Il disegno gira nel worker dei documenti (20 secondi, 512 MB, due alla volta), come la lettura e la creazione dei documenti: un grafico pesante costa un worker, non il processo.
- Limiti contati prima del lavoro: al massimo 8 serie, 120 barre, 1.000 punti per linea, CSV fino a 2 MB, 1.000 righe e 64 colonne; valori tra 1e-9 e 1e15 (oltre, l'asse non si può disegnare onestamente); barre troppo sottili rifiutate con il consiglio di raggrupparle.
- I passi dell'asse sono sempre multipli interi del passo, al massimo una dozzina, qualunque siano i numeri: nessun intervallo può far girare il calcolo all'infinito.
- Il rasterizzatore taglia ogni bordo al riquadro della forma in modo esatto, e alloca solo il riquadro della forma dentro l'immagine.
- Un `path` scelto dal modello non sostituisce un file esistente fuori da `grafici/` (potrebbe essere la foto di qualcuno); due grafici con lo stesso nome nello stesso secondo prendono `-2`, `-3`.

## Alternative scartate

- **Il computer di Annie con Python e matplotlib.** Va bene per analisi lunghe, ma non tutte le istanze lo hanno e accenderlo per un grafico è lento.
- **Il browser della cella con una libreria JavaScript.** Non c'è in tutte le istanze, e servirebbe una pagina per ogni grafico.
- **SVG.** Telegram e WhatsApp non lo mostrano come foto, e Word lo vuole con un PNG accanto.
- **Una libreria (node-canvas, sharp).** Moduli nativi da compilare e un'altra superficie da tenere aggiornata, per disegnare rettangoli e testo.
- **Interattività** (valori al passaggio del mouse): una foto in chat non ne ha; i valori scritti e la legenda fanno la loro parte.

## Conseguenze

- Le lettere sono latine (latino base, Latin-1, Latin Extended-A e ș ț): un nome in greco o in cirillico esce con «?», e Annie lo dice.
- I contorni di DejaVu Sans sono nel codice (circa 140 KB), con la licenza Bitstream Vera per intero in testa al file e in `NOTICE`.
- Un grafico non si modifica: si rifà, con i dati cambiati.
