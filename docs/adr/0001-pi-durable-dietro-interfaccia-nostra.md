# Pi Durable dietro un'interfaccia nostra

Il nucleo durevole è Pi Durable 1.3.0, sperimentale e senza garanzie di stabilità dell'API. Lo usiamo perché è l'unico harness che riprende una conversazione a metà tool dopo un crash, ma solo attraverso `DurableEngine` e `ModelClient`, interfacce nostre: tutto il codice Pi vive in `src/core/adapters/pi-durable*` e un test impedisce import di Pi altrove. Sostituirlo significa riscrivere l'adapter, non Owni. Dettagli nel [piano iniziale](../piano-iniziale.md) e in [architettura](../architettura.md).
