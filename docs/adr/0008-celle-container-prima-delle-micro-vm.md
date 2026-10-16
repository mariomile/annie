# Prima delle micro-VM, celle come container su un server in UE

L'ADR 0007 mette ogni cella su una micro-VM. Per i primi clienti di Annie Cloud abbiamo deciso di partire con le celle come **container Docker su un solo server in UE**, dietro la stessa interfaccia `CellProvider`: un container e un volume per tenant su una rete dove i container non si vedono fra loro, utente senza privilegi (uid 1000, mai root), file system in sola lettura, nessuna capability Linux, limiti di memoria, CPU e processi, porta pubblicata solo su 127.0.0.1 per il control plane.

Perché: si può aprire oggi, su un server che costa poche decine di euro al mese, senza scegliere e misurare un cloud di micro-VM; il percorso registrazione, cella, prima risposta, sonno e risveglio è lo stesso, verificato su un daemon vero (circa 4 secondi dalla registrazione alla prima risposta e per il risveglio; una cella accesa usa circa 100 MB di memoria, una spenta 0,1 MB di disco). Quando il numero di tenant o il «computer dell'agente» (Fase 3) lo chiedono, si cambia provider senza toccare il control plane.

## Alternative scartate

- **Aspettare il provider di micro-VM**: blocca i primi clienti su una scelta (Fly.io o altro) che va prima misurata in costi e tempi di risveglio.
- **Processi sullo stesso utente** (il provider locale): nessun isolamento fra tenant, solo per sviluppo.

## Conseguenze

- L'isolamento è quello di un container: il kernel è condiviso. Basta per conversazioni e file; per eseguire codice arbitrario (browser e terminale della Fase 3) servono le micro-VM. Anche il «firewall di egress a livello di container» che l'ADR 0002 chiede per garanzie forti sui tool proposti resta da fare: oggi una cella esce su internet come un'installazione self-host, e i tool proposti restano limitati dall'approvazione e dagli host dichiarati.
- Le celle non si vedono fra loro (rete con traffico fra container spento). Sul server va bloccato l'accesso dei container all'endpoint dei metadati del cloud e a qualunque servizio dell'host in ascolto su indirizzi non locali (runbook 6c), con Docker 28 o successivo (prima, le porte su 127.0.0.1 erano raggiungibili dalla rete locale).
- Il control plane parla con il socket di Docker, che equivale a root sull'host: gira con un utente suo nel gruppo `docker` e ascolta solo su 127.0.0.1 dietro il reverse proxy. I segreti di ogni cella stanno nell'ambiente del suo container, leggibili da chi è root sul server (come nel self-host).
- Resta valida la regola dell'ADR 0007 sul dominio: le celle su un dominio separato da quello della registrazione, registrato nella Public Suffix List.
- Un solo server è un solo punto di guasto: backup dei volumi ogni notte, e il control plane riparte le celle da sé al primo messaggio. Aggiornare l'immagine o la chiave del modello: `pnpm cloud upgrade` ricrea i container tenendo i volumi.
