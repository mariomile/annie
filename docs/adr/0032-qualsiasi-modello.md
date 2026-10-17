# Qualsiasi modello AI, scelto dall'owner

Annie girava solo su Anthropic o OpenAI, e il modello lo sceglieva chi gestisce il server, una volta, con `ANNIE_MODEL_PROVIDER` e `ANNIE_MODEL_ID`. Chi usa Annie vuole scegliere: Claude per scrivere, Gemini perché costa poco, Grok, Mistral perché è europeo, DeepSeek o Kimi, o tutti quelli di OpenRouter con una chiave sola. Annie è l'alternativa a Grok che non ti lega a un modello.

## Decisione

- **Un catalogo dei provider offerti** in `src/core/model-providers.ts`: diciotto provider (Anthropic, OpenAI, Google, xAI, Mistral, DeepSeek, Moonshot, Z.AI, MiniMax, Meta, OpenRouter, Vercel AI Gateway, Groq, Cerebras, Together, Fireworks, Hugging Face, NVIDIA), ciascuno con il nome, la variabile della chiave e il modello di partenza. È una scelta di prodotto, nel core e senza Pi.
- **I modelli li conosce pi-ai.** L'adapter (`pi-durable-models.ts`) costruisce ogni provider e ne elenca i modelli come dati semplici: nome, se guarda le foto, se ragiona, contesto e prezzi. Nessun elenco di modelli scritto a mano da tenere aggiornato: si aggiorna con pi-ai. Un test controlla che ogni provider del catalogo esista nell'adapter e abbia il suo modello di partenza.
- **L'owner sceglie in Impostazioni → Modello AI**: provider, modello, e la sua chiave se il server non ce l'ha. Il cambio vale dalla risposta successiva; chat, file e memoria restano.
- **Le chiavi del server.** Ogni chiave nell'ambiente (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, ...) va nel secret store all'avvio, così l'owner può passare a quei provider senza chiave sua. La chiave di un provider che il server ha non si sostituisce dalla console: è dell'operatore.

## Sicurezza

- Solo l'owner vede e cambia il modello. La chiave va dalla pagina al secret store del tenant e non torna mai indietro: l'API dice solo «del server», «salvata» o «manca». L'audit registra il cambio di modello e il nome del segreto, mai il valore.
- Scegliere un provider lo aggiunge alla policy di egress dell'istanza, accanto a quelli già consentiti: è un'azione esplicita dell'owner. Il motore riceve solo la chiave dei provider consentiti, come prima.
- Il modello deve essere nel catalogo di quel provider; il modello locale di prova non si sceglie dalla console.
- Una chiave salvata si toglie solo se nessuna istanza usa quel provider.
- Le chiavi stanno nel file dei segreti del tenant (0600), non cifrato, come le altre (architettura.md).

## Alternative scartate

- **Un elenco di modelli nostro.** Invecchia ogni mese; pi-ai lo aggiorna con i prezzi.
- **Un endpoint compatibile OpenAI con indirizzo libero** (Ollama, LM Studio, vLLM). Utile in locale, ma su Annie Cloud aprirebbe la cella verso qualsiasi indirizzo. Si potrà fare per i server senza celle, con l'indirizzo scelto dall'operatore.
- **Bedrock, Azure, Vertex.** Vogliono più di una chiave (regione, progetto, credenziali cloud): restano per ora fuori.
- **Il modello per singola chat.** Il motore apre una sessione per istanza con un modello; cambiarlo a metà conversazione è il passo successivo.

## Conseguenze

- `pnpm annie check` prova la chiave di Anthropic e OpenAI chiedendo l'elenco dei modelli; per gli altri provider dice che la chiave c'è e la verifica la prima risposta.
- Le celle di Annie Cloud ricevono tutte le variabili delle chiavi dei provider.
