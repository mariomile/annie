# Prima delle micro-VM, celle come container su un server in UE

L'ADR 0007 mette ogni cella su una micro-VM. Per i primi clienti di Annie Cloud abbiamo deciso di partire con le celle come **container Docker su un solo server in UE**, dietro la stessa interfaccia `CellProvider`: un container, un volume e una rete per tenant, utente senza privilegi, file system in sola lettura, nessuna capability Linux, limiti di memoria, CPU e processi, porta pubblicata solo su 127.0.0.1 per il control plane.

Perché: si può aprire oggi, su un server che costa poche decine di euro al mese, senza scegliere e misurare un cloud di micro-VM; il percorso registrazione, cella, prima risposta, sonno e risveglio è lo stesso, verificato su un daemon vero (4 secondi dalla registrazione alla prima risposta, meno di 4 per il risveglio). Quando il numero di tenant o il «computer dell'agente» (Fase 3) lo chiedono, si cambia provider senza toccare il control plane.

## Alternative scartate

- **Aspettare il provider di micro-VM**: blocca i primi clienti su una scelta (Fly.io o altro) che va prima misurata in costi e tempi di risveglio.
- **Processi sullo stesso utente** (il provider locale): nessun isolamento fra tenant, solo per sviluppo.

## Conseguenze

- L'isolamento è quello di un container: il kernel è condiviso. Basta per conversazioni e file; per eseguire codice arbitrario (browser e terminale della Fase 3) servono le micro-VM.
- Le celle non si vedono fra loro (reti separate). Sul server va bloccato l'accesso dei container all'endpoint dei metadati del cloud (169.254.169.254) e a qualunque servizio dell'host in ascolto su indirizzi non locali (runbook).
- Un solo server è un solo punto di guasto: backup dei volumi ogni notte, e il control plane riparte le celle da sé al primo messaggio.
