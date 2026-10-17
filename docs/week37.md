# Settimana 37: tabelle e conti esatti

Branch `week-37`. Annie faceva i conti a mente. Ora `table_query` risponde a domande su un CSV, un Excel o un foglio OpenDocument con numeri esatti, e `calculate` fa l'aritmetica di un preventivo o di una divisione al centesimo. Come funziona, i limiti e le alternative scartate sono nell'[ADR 0031](adr/0031-conti-esatti.md).

## Cosa cambia per chi usa Annie

- **«Quanto ho fatturato a marzo?»** sull'export delle fatture: la somma esatta, senza contare la riga «Totale» in fondo.
- **«I cinque clienti migliori» e «quanto pesa ciascuno»**: classifica per fatturato con la quota sul totale.
- **«Entrate e uscite di ottobre»** sull'estratto conto: Annie salta i dati del conto sopra la tabella e i saldi, somma Dare e Avere e il netto.
- **«Le vendite per mese, in un grafico»**: raggruppa per mese, salva il CSV e `chart_create` lo disegna.
- **«Incasso per prodotto»** con quantità e prezzo in due colonne: un'espressione «Quantità * Prezzo».
- **«Un foglio per mese, il totale dell'anno»**: `sheet: "*"` unisce i fogli.
- **«Imponibile 3 × 450, più IVA»**: `calculate` con le righe che si chiamano, risultato a due decimali.
- **«Non hai fatturato nulla a ottobre»?** Se un filtro non trova niente, Annie lo sa e vede i valori che la colonna ha davvero.

## Cosa funziona (verificato dai test)

- Calcolatrice: righe con nomi, numeri con punto o virgola (1.500 è millecinquecento), funzioni con i nomi italiani, precedenze, percentuali, esponenti esatti; rifiuti con il motivo e la riga (divisione per zero, nomi sconosciuti, parentesi, virgole ambigue, operatore mancante, `eval` impossibile) (`test/data.test.ts`).
- Tabelle: descrizione delle colonne, gruppi per mese in ordine di tempo, gruppi di testo senza badare a maiuscole e spazi, filtri su mese, importo, parole, celle vuote e liste, totali sulle righe filtrate, somme al centesimo su 10.000 righe, colonne per pezzo del nome o lettera, colonne senza intestazione, quote sul totale, espressioni.
- Export reali: estratto conto con righe sopra l'intestazione, saldi, date a due cifre e Dare/Avere; importi senza simbolo con i centesimi; colonne con il punto decimale; CSV con un titolo sopra; segni + e negativi tra parentesi o con il meno in fondo.
- Excel e OpenDocument: titolo sopra l'intestazione, altri fogli detti, fogli uniti, valori salvati e non arrotondati dal formato, righe e celle ripetute di OpenDocument, il foglio fatto da Annie con `document_create`, somma in fondo senza nome lasciata fuori.
- Sicurezza: tutto il testo del file dentro il recinto, anche nelle note e negli errori; marcatori finti di fogli restano celle; niente formule nel CSV salvato; nessun file sovrascritto; worker con i suoi limiti.
- In un'istanza vera: dalla chat un CSV scritto nel workspace, la domanda raggruppata e la calcolatrice.
- Nel browser: nella chat della console tabella e risultati compaiono; nessun errore in console.

## Review indipendente

Due revisori: sicurezza e standard; specifiche e uso, con estratti conto ed export veri provati a mano. Corretti:

- **Alta (sicurezza).** Excel era letto dal testo formattato: una colonna col formato «0» sommava 40 invece di 41,6. Ora i valori sono quelli salvati. OpenDocument scriveva una volta le righe e le celle ripetute: tre righe uguali contavano come una. Il foglio veniva riletto dal testo, e una cella «## Foglio «Altro»» ne inventava uno: ora le righe arrivano strutturate.
- **Media (sicurezza).** Nomi di fogli e colonne arrivavano al modello fuori dal recinto, anche negli errori; il CSV salvato poteva portare formule; una colonna di 0.500 e 1.25 sommava 503,75; `1.500` era 1,5 per la calcolatrice e 1500 per le tabelle; `round(2,5)` era round(2; 5); gli esponenti avevano errori di arrotondamento; `sheet: "2"` sceglieva un foglio con «2» nel nome; una prima colonna di anni diventava intestazione; la somma in fondo scartava anche dati veri.
- **Alta (uso).** Gli importi senza € perdevano i centesimi; un titolo sopra un CSV sbagliava il separatore; i dati del conto sopra un estratto diventavano intestazione; «Totale fatture» e «Saldo finale» erano contati; un filtro senza risultati dava 0 senza dirlo; le date 17/10/26 e i numeri +150,00, 1.000,00-, (2,50) non erano letti.
- **Media (uso).** Una colonna scelta per prefisso poteva essere quella sbagliata (ora parola intera, e detta); mancavano colonne calcolate, filtri «in», fogli uniti e quote sul totale; nomi dei risultati non documentati e ordinamento per op; media per periodo spiegata nella descrizione.
- **Bassa.** Errori della calcolatrice più chiari (nomi con spazi, operatore mancante), la divisione con il centesimo che avanza, «Mostro 1 riga».

Lasciato, scritto nell'ADR: le settimane senza righe non compaiono; le etichette dei periodi restano ordinabili e il modello le scrive per le persone.
