import json,os
T="2026-10-1{d}T{h}:00:00+02:00"
def lead(fullName=None,company=None,email=None,phone=None,product=None,qty=None,urgency=None,missing=(),title=None,lang="it"):
    return dict(fullName=fullName,title=title,company=company,email=email,phone=phone,productOrService=product,quantity=qty,urgency=urgency,missingFields=list(missing),source="email",originalLanguage=lang)
def draft(mustAsk=(),noPrices=True,allowedAmounts=(),bullets=False,mustMention=(),mustNotMention=(),salutation=None,note=None):
    d=dict(register="lei",language="it",mustAsk=list(mustAsk),mustNotInventPrices=noPrices,allowedAmounts=list(allowedAmounts),mustListItemsAsBullets=bullets,mustAskPriority=bullets,mustMention=list(mustMention),mustNotMention=list(mustNotMention),autonomousSend=False)
    if salutation: d["expectedSalutationContains"]=salutation
    if note: d["note"]=note
    return d
STD=dict(praticaAction="create",crmUpsertExpected=1,expectedStatusAfterPipeline="draft_ready",telegramButtons=["Approva","Modifica","Scarta"],sendAllowedOnlyAfterApprove=True)
C=[]
def add(n,slug,tags,crit,frm,subj,body,cls,ld,dr,mid=None,thread=None,flow=None,multi=None,sched=None,notes=None):
    cid=f"{n:03d}-{slug}"
    e=dict(messageId=mid or f"<{cid}@mail.example.it>",from_=frm,to="preventivi@officine-fittizie.example",subject=subj,receivedAt=T.format(d=3+n%3,h=9+n%9),body=body)
    if thread: e.update(thread)
    e["from"]=e.pop("from_")
    f=dict(STD); f.update(flow or {})
    exp=dict(classification=cls,lead=ld,requests=multi or ([] if ld is None else [dict(productOrService=ld["productOrService"],quantity=ld["quantity"])]),missingFields=[] if ld is None else ld["missingFields"],draft=dr,flow=f)
    if sched: exp["telegramCard"]=sched
    C.append(dict(id=cid,tags=tags,specRefs=crit,email=e,expected=exp,notes=notes or ""))

# --- completi (baseline)
add(1,"completo-macchinari",["complete","formal","no_price_in_email"],["§7.2-11","§7.2-12","§7.2-17","§7.2-18","§7.1-1","§7.1-2"],
 "Giulia Ferraresi <giulia.ferraresi@tornerie-valdorme.example>","Richiesta preventivo tornio CNC",
 "Buongiorno,\nsono Giulia Ferraresi, responsabile acquisti di Tornerie Valdorme Srl.\nVi chiediamo un preventivo per 2 torni CNC a 3 assi, consegna presso il nostro stabilimento di Fossano (CN) entro fine gennaio.\nP.IVA 01234560900. Tel. 0172 000111.\nCordiali saluti\nGiulia Ferraresi",
 "richiesta_preventivo",lead("Giulia Ferraresi","Tornerie Valdorme Srl","giulia.ferraresi@tornerie-valdorme.example","0172 000111","tornio CNC 3 assi","2","entro fine gennaio"),
 draft(salutation="Gentile Signora Ferraresi"))
add(2,"completo-servizio-pulizie",["complete","formal","service"],["§7.2-11","§7.2-12","§7.2-17","§7.2-18"],
 "Paolo Annunziata <p.annunziata@studio-lumen.example>","Preventivo pulizie uffici",
 "Gentili,\nper lo Studio Lumen Associati chiedo un preventivo per la pulizia dei nostri uffici di 180 mq in via dei Ciclamini 4, Bologna, 3 volte a settimana, a partire da novembre.\nMi può contattare al 333 0000222.\nGrazie\nPaolo Annunziata",
 "richiesta_preventivo",lead("Paolo Annunziata","Studio Lumen Associati","p.annunziata@studio-lumen.example","333 0000222","pulizia uffici 180 mq, 3 volte a settimana","1","da novembre"),
 draft(salutation="Gentile Signor Annunziata"))
add(3,"completo-urgente",["complete","formal","urgent"],["§7.2-11","§7.2-12","§7.2-17"],
 "Ufficio Acquisti Cartotecnica Brenta <acquisti@cartotecnica-brenta.example>","URGENTE - preventivo bancali",
 "Buongiorno,\nci servono 400 bancali EPAL usati di prima scelta, consegna a Cittadella (PD) entro venerdì prossimo. Referente: Sara Molon, 049 0000333.\nP.IVA 09876540221.\nGrazie, Sara Molon - Cartotecnica Brenta Spa",
 "richiesta_preventivo",lead("Sara Molon","Cartotecnica Brenta Spa","acquisti@cartotecnica-brenta.example","049 0000333","bancali EPAL usati prima scelta","400","entro venerdì prossimo"),
 draft(salutation="Gentile Signora Molon"))
add(4,"completo-software",["complete","formal","service"],["§7.2-11","§7.2-12","§7.2-17"],
 "Marco De Santis <marco.desantis@ortofrutta-sole.example>","Richiesta offerta licenze gestionale",
 "Salve,\nsono Marco De Santis di Ortofrutta del Sole Soc. Coop. Vorremmo un'offerta per 12 licenze del vostro gestionale magazzino con installazione presso la sede di Vittoria (RG). Avvio previsto a marzo 2027.\nP.IVA 01122330465\nCordialmente",
 "richiesta_preventivo",lead("Marco De Santis","Ortofrutta del Sole Soc. Coop.","marco.desantis@ortofrutta-sole.example",None,"licenze gestionale magazzino con installazione","12","marzo 2027"),
 draft(salutation="Gentile Signor De Santis"))
add(5,"completo-solo-persona",["complete","formal","no_company"],["§7.2-11","§7.2-12","§4.1-fullName-o-company"],
 "Elena Cortivo <elena.cortivo@posta-fittizia.example>","Preventivo scaffalature",
 "Buongiorno, vorrei un preventivo per 6 scaffalature metalliche h 2 m per il mio garage a Treviso (via dei Tigli 9), entro dicembre. Sono un privato, non ho partita IVA. Grazie, Elena Cortivo",
 "richiesta_preventivo",lead("Elena Cortivo",None,"elena.cortivo@posta-fittizia.example",None,"scaffalature metalliche h 2 m","6","entro dicembre"),
 draft(salutation="Gentile Signora Cortivo",mustNotMention=["partita IVA"],note="Privato: non chiedere P.IVA; company null è valido perché c'è fullName."))
# --- dati mancanti
add(6,"missing-qty",["missing_qty","formal"],["§6-dati-mancanti","§7.2-13","§7.2-18"],
 "Roberto Zanin <r.zanin@serramenti-zanin.example>","Richiesta preventivo vetri",
 "Buongiorno,\nRoberto Zanin, Serramenti Zanin Snc. Vorremmo un preventivo per vetrocamera basso emissivi 4/16/4, consegna a Pordenone, appena possibile. P.IVA 02233440573.\nSaluti",
 "richiesta_preventivo",lead("Roberto Zanin","Serramenti Zanin Snc","r.zanin@serramenti-zanin.example",None,"vetrocamera basso emissivo 4/16/4",None,"appena possibile",["quantity"]),
 draft(["quantity"],salutation="Gentile Signor Zanin"))
add(7,"missing-sede",["missing_site","formal"],["§6-dati-mancanti","§7.2-13"],
 "Chiara Pellizzari <chiara.p@laboratori-arno.example>","Preventivo installazione cappa",
 "Gentili,\nsono Chiara Pellizzari di Laboratori Arno Srl. Ci servirebbe l'installazione di 2 cappe chimiche aspiranti entro febbraio. P.IVA 03344550680.\nGrazie mille",
 "richiesta_preventivo",lead("Chiara Pellizzari","Laboratori Arno Srl","chiara.p@laboratori-arno.example",None,"installazione cappe chimiche aspiranti","2","entro febbraio",["deliverySite"]),
 draft(["deliverySite"],salutation="Gentile Signora Pellizzari"))
add(8,"missing-piva",["missing_vat","formal"],["§6-dati-mancanti","§7.2-13"],
 "Andrea Ruggeri <andrea.ruggeri@ferramenta-colle.example>","Richiesta preventivo",
 "Buongiorno,\nper Ferramenta del Colle chiedo un preventivo per 50 cassette attrezzi in ABS, consegna a Siena, entro il mese. Per la fatturazione vi mando i dati in seguito.\nAndrea Ruggeri",
 "richiesta_preventivo",lead("Andrea Ruggeri","Ferramenta del Colle","andrea.ruggeri@ferramenta-colle.example",None,"cassette attrezzi in ABS","50","entro il mese",["vatNumber"]),
 draft(["vatNumber"],salutation="Gentile Signor Ruggeri"))
add(9,"missing-prodotto",["missing_product","formal","vague"],["§6-dati-mancanti","§7.2-13","§4.1-productOrService"],
 "Federica Lanza <federica.lanza@hotel-belvedere-lago.example>","Informazioni e preventivo",
 "Buongiorno, ho visto il vostro sito e vorrei ricevere un preventivo per il nostro hotel. Potete ricontattarmi?\nFederica Lanza\nHotel Belvedere sul Lago - Stresa\n0323 000444",
 "richiesta_preventivo",lead("Federica Lanza","Hotel Belvedere sul Lago","federica.lanza@hotel-belvedere-lago.example","0323 000444",None,None,None,["productOrService","quantity"]),
 draft(["productOrService","quantity"],salutation="Gentile Signora Lanza",note="productOrService assente: la bozza chiede cosa serve; non propone prodotti dal catalogo come fossero scelti."))
add(10,"missing-multipli",["missing_qty","missing_site","missing_vat","informal_short"],["§6-dati-mancanti","§7.2-13","§7.2-17"],
 "Luca <luca.b@posta-fittizia.example>","prev",
 "salve mi fate un prezzo per dei pannelli fonoassorbenti? grazie Luca",
 "richiesta_preventivo",lead("Luca",None,"luca.b@posta-fittizia.example",None,"pannelli fonoassorbenti",None,None,["quantity","deliverySite","vatNumber"]),
 draft(["quantity","deliverySite","vatNumber"],salutation="Gentile",mustNotMention=["Luca,"],note="Nome solo di battesimo: saluto neutro (es. 'Gentile cliente' o 'Buongiorno'), non 'Caro Luca'. vatNumber: vedi ambiguità A3."))
# --- registro
add(11,"informale-tu",["informal","register_correction"],["§7.2-17","§1-registro"],
 "Matteo Rinaldi <matteo@birrificio-quercia.example>","ciao, preventivo fusti",
 "Ciao! Sono Matteo del Birrificio La Quercia. Mi mandi un preventivo per 30 fusti in acciaio da 20 litri? Consegna a Perugia entro 3 settimane. P.IVA 04455660797. Grazie mille, a presto!",
 "richiesta_preventivo",lead("Matteo Rinaldi","Birrificio La Quercia","matteo@birrificio-quercia.example",None,"fusti in acciaio da 20 litri","30","entro 3 settimane"),
 draft(salutation="Gentile Signor Rinaldi",mustNotMention=["Ciao","ti ","tuo"],note="Il cliente dà del tu: la bozza resta in lei."))
add(12,"informale-dialettale",["informal","register_correction","missing_qty"],["§7.2-17","§7.2-13"],
 "Gino Fabbri <gino.fabbri@autofficina-fabbri.example>","x il ponte sollevatore",
 "ciao ragazzi, mi serve un ponte sollevatore per l'officina a Cesena, quanto viene? fatemi sapere che ho fretta. Gino, Autofficina Fabbri",
 "richiesta_preventivo",lead("Gino Fabbri","Autofficina Fabbri","gino.fabbri@autofficina-fabbri.example",None,"ponte sollevatore",None,"urgente",["quantity","vatNumber"]),
 draft(["quantity","vatNumber"],salutation="Gentile Signor Fabbri",note="'quanto viene' è una richiesta di prezzo: la bozza NON dà importi, spiega che seguirà il preventivo."))
add(13,"formale-molto-formale",["formal","complete","title"],["§7.2-17","§6-titoli"],
 "Ing. Valeria Morelli <v.morelli@impianti-morelli.example>","Richiesta di offerta - quadri elettrici",
 "Spett.le Ditta,\ncon la presente la sottoscritta Ing. Valeria Morelli, per conto di Impianti Morelli Srl, richiede cortese offerta per n. 4 quadri elettrici di distribuzione IP65, da consegnarsi presso il cantiere di Lecce entro il 30 novembre p.v.\nP.IVA 05566770904.\nDistinti saluti",
 "richiesta_preventivo",lead("Valeria Morelli","Impianti Morelli Srl","v.morelli@impianti-morelli.example",None,"quadri elettrici di distribuzione IP65","4","entro il 30 novembre",title="Ing."),
 draft(salutation="Gentile Ing. Morelli"))
# --- prezzi
add(14,"prezzo-citato-cliente",["price_in_email","formal"],["§6-prezzo-citato","§7.2-18"],
 "Davide Conti <davide.conti@tipografia-adige.example>","Preventivo carta patinata",
 "Buongiorno,\nTipografia Adige Srl, Davide Conti. L'anno scorso ci avete fornito 200 risme di carta patinata 150 g a 6,50 € a risma. Ci serve la stessa quantità, consegna a Verona entro novembre, P.IVA 06677880913. Potete confermare lo stesso prezzo?",
 "richiesta_preventivo",lead("Davide Conti","Tipografia Adige Srl","davide.conti@tipografia-adige.example",None,"carta patinata 150 g (risme)","200","entro novembre"),
 draft(noPrices=True,allowedAmounts=["6,50 €"],mustNotMention=["confermiamo il prezzo","confermiamo lo stesso prezzo"],note="Può citare 6,50 € solo riprendendo la richiesta, mai altri importi, e non conferma né contraddice: rimanda al commerciale."))
add(15,"budget-dichiarato",["price_in_email","budget","formal"],["§6-prezzo-citato","§7.2-18"],
 "Simona Galli <simona.galli@asilo-girasole.example>","Arredi aula",
 "Buongiorno, sono Simona Galli, coordinatrice dell'Asilo Il Girasole (cooperativa sociale). Dobbiamo arredare un'aula: 20 sedioline e 5 tavoli per bambini 3-5 anni, consegna a Lodi entro gennaio. Il budget massimo è 3.000 euro IVA inclusa. C.F./P.IVA 07788990021.",
 "richiesta_preventivo",lead("Simona Galli","Asilo Il Girasole","simona.galli@asilo-girasole.example",None,"sedie e tavoli per bambini 3-5 anni","20 sedie, 5 tavoli","entro gennaio"),
 draft(allowedAmounts=["3.000 euro"],note="Budget del cliente: può essere ripreso, nessun altro importo, nessuna promessa di rientrarci."))
add(16,"chiede-listino",["asks_price_list","formal","missing_qty"],["§7.2-18","§7.2-13"],
 "Stefano Barbieri <s.barbieri@agriturismo-poggio.example>","Listino prezzi",
 "Buonasera, potreste inviarmi il listino prezzi aggiornato dei vostri tavoli in legno da esterno? Agriturismo Poggio Alto, Montalcino. Stefano Barbieri",
 "richiesta_preventivo",lead("Stefano Barbieri","Agriturismo Poggio Alto","s.barbieri@agriturismo-poggio.example",None,"tavoli in legno da esterno",None,None,["quantity","vatNumber"]),
 draft(["quantity","vatNumber"],mustNotMention=["in allegato il listino","listino allegato"],note="Non allegare né promettere un listino non disponibile; nessun importo."))
# --- multi
add(17,"multi-prodotto",["multi_request","formal","complete"],["§6-multi","§7.2-14"],
 "Irene Basile <irene.basile@ristorante-due-ponti.example>","Preventivo attrezzature cucina",
 "Buongiorno,\nper il Ristorante Due Ponti (Pisa, via Lungarno Fittizio 3) chiediamo preventivo per:\n- 1 abbattitore di temperatura 5 teglie\n- 2 frigoriferi verticali 700 l\n- 1 lavastoviglie a capotta\nConsegna entro metà dicembre. P.IVA 08899000130.\nIrene Basile",
 "richiesta_preventivo",lead("Irene Basile","Ristorante Due Ponti","irene.basile@ristorante-due-ponti.example",None,"attrezzature cucina (3 voci)",None,"entro metà dicembre"),
 draft(bullets=True,mustMention=["abbattitore","frigorifer","lavastoviglie"]),
 multi=[dict(productOrService="abbattitore di temperatura 5 teglie",quantity="1"),dict(productOrService="frigorifero verticale 700 l",quantity="2"),dict(productOrService="lavastoviglie a capotta",quantity="1")],
 flow=dict(crmUpsertExpected=1,praticheExpected=1))
add(18,"multi-prodotto-servizio-missing",["multi_request","missing_qty","formal"],["§6-multi","§7.2-14","§7.2-13"],
 "Tommaso Greco <tommaso.greco@palestra-atlante.example>","Tapis roulant e manutenzione",
 "Salve, gestisco la Palestra Atlante a Bari. Vorrei preventivo per dei tapis roulant nuovi e, separatamente, per un contratto di manutenzione annuale delle macchine esistenti (circa 25). P.IVA 09900110249. Tommaso Greco",
 "richiesta_preventivo",lead("Tommaso Greco","Palestra Atlante","tommaso.greco@palestra-atlante.example",None,"tapis roulant + manutenzione annuale",None,None,["quantity"]),
 draft(["quantity"],bullets=True,mustMention=["tapis roulant","manutenzione"]),
 multi=[dict(productOrService="tapis roulant",quantity=None),dict(productOrService="contratto manutenzione annuale macchine",quantity="25")],
 flow=dict(crmUpsertExpected=1,praticheExpected=1))
# --- allegati
add(19,"allegato-citato-assente",["attachment_missing","formal"],["§6-allegati"],
 "Nicola Ferri <nicola.ferri@carpenteria-ferri.example>","Richiesta preventivo da disegno",
 "Buongiorno,\nin allegato trovate il disegno tecnico con quantità e misure per le staffe in acciaio inox che ci servono. Consegna a Brescia entro dicembre. P.IVA 01011120324.\nNicola Ferri - Carpenteria Ferri Srl",
 "richiesta_preventivo",lead("Nicola Ferri","Carpenteria Ferri Srl","nicola.ferri@carpenteria-ferri.example",None,"staffe in acciaio inox (da disegno)",None,"entro dicembre",["quantity"]),
 draft(["quantity"],mustNotMention=["come da disegno","nel disegno indicat"],note="Allegati non letti in v1: la bozza non finge di averlo letto; può chiedere quantità/misure o dire che il commerciale lo esaminerà."),
 sched=dict(mustNote="allegato"))
# --- lingua
add(20,"inglese",["lang_en","formal","complete"],["§6-lingua"],
 "James Whitfield <j.whitfield@harbour-yachts.example>","Quote request - teak decking",
 "Hello,\nI'm James Whitfield from Harbour Yachts Ltd. We'd like a quote for 40 sqm of teak decking panels, delivered to our yard in La Spezia by end of January. VAT GB000000000.\nBest regards",
 "richiesta_preventivo",lead("James Whitfield","Harbour Yachts Ltd","j.whitfield@harbour-yachts.example",None,"pannelli teak decking","40 mq","entro fine gennaio",lang="en"),
 draft(salutation="Gentile Signor Whitfield",note="Bozza in italiano (lei) come da spec; scheda mostra lingua originale EN. Vedi ambiguità A1."),
 sched=dict(mustNote="lingua originale: inglese"))
add(21,"misto-it-en",["lang_mixed","formal","missing_site"],["§6-lingua","§7.2-13"],
 "Laura Bassi <laura.bassi@techstart-milano.example>","Preventivo standing desk",
 "Hi, buongiorno! Sono Laura Bassi, office manager di TechStart Milano Srl. We need 15 standing desks per il nuovo open space, ASAP please. P.IVA 02122230432. Thanks!",
 "richiesta_preventivo",lead("Laura Bassi","TechStart Milano Srl","laura.bassi@techstart-milano.example",None,"scrivanie regolabili in altezza (standing desk)","15","al più presto",["deliverySite"],lang="it+en"),
 draft(["deliverySite"],salutation="Gentile Signora Bassi"),sched=dict(mustNote="lingua originale"))
# --- spam / non preventivo
add(22,"spam-newsletter",["spam"],["§6-spam","§7.2-15"],
 "Shop Offerte <newsletter@shop.example>","-30% questo weekend",
 "Solo per te: -30% su tutto il catalogo fino a domenica! Clicca qui per approfittarne. Disiscriviti.",
 "spam",None,None,flow=dict(praticaAction="create_skip",crmUpsertExpected=0,expectedStatusAfterPipeline="classified_skip",telegramButtons=["Approva","Modifica","Scarta"]))
add(23,"spam-phishing",["spam","phishing"],["§6-spam","§7.2-15"],
 "Servizio Clienti Banca <sicurezza@banca-fittizia-verifica.example>","Il suo conto è sospeso",
 "Gentile cliente, il suo conto è stato sospeso. Per riattivarlo inserisca le credenziali al link seguente entro 24 ore. Richiesta preventivo n. 2231 allegata.",
 "spam",None,None,flow=dict(praticaAction="create_skip",crmUpsertExpected=0,expectedStatusAfterPipeline="classified_skip",telegramButtons=["Approva","Modifica","Scarta"]),
 notes="Contiene la parola 'preventivo' come esca: non deve essere classificata richiesta_preventivo.")
add(24,"non-preventivo-fornitore",["not_quote","vendor_pitch"],["§6-spam","§7.2-15"],
 "Alessio Marra <alessio.marra@webagency-nova.example>","Proposta collaborazione SEO",
 "Buongiorno, sono Alessio Marra di Web Agency Nova. Vi proponiamo un pacchetto SEO per aumentare le vostre richieste di preventivo. Posso inviarvi la nostra offerta?",
 "altro",None,None,flow=dict(praticaAction="create_skip",crmUpsertExpected=0,expectedStatusAfterPipeline="classified_skip",telegramButtons=["Approva","Modifica","Scarta"]),
 notes="Un fornitore che vende a noi: non-preventivo.")
add(25,"non-preventivo-assistenza",["not_quote","support"],["§6-spam","§7.2-15"],
 "Rita Colombo <rita.colombo@panificio-colombo.example>","Problema con la fattura",
 "Buongiorno, nella fattura di settembre c'è un errore sull'indirizzo di fatturazione. Potete riemetterla? Rita Colombo, Panificio Colombo",
 "altro",None,None,flow=dict(praticaAction="create_skip",crmUpsertExpected=0,expectedStatusAfterPipeline="classified_skip",telegramButtons=["Approva","Modifica","Scarta"]),
 notes="Cliente esistente ma richiesta amministrativa: non crea lead. Vedi ambiguità A4.")
# --- thread
add(26,"reply-thread-risposta-domande",["thread_reply"],["§6-thread","§7.2-16"],
 "Giulia Ferraresi <giulia.ferraresi@tornerie-valdorme.example>","Re: Re: Richiesta preventivo tornio CNC",
 "Buongiorno,\ngrazie per la risposta. Confermo: l'accesso al capannone è con muletto, carico massimo 3 t. Resto in attesa del preventivo.\nGiulia Ferraresi\n\n> Gentile Signora Ferraresi, la ringraziamo...",
 "risposta_thread",lead("Giulia Ferraresi","Tornerie Valdorme Srl","giulia.ferraresi@tornerie-valdorme.example","0172 000111","tornio CNC 3 assi","2","entro fine gennaio"),
 draft(note="Follow-up v1 sulla pratica esistente; nessun prezzo; ringrazia per l'informazione."),
 thread=dict(threadId="thr-001",inReplyTo="<sent-reply-001@officine-fittizie.example>",references=["<001-completo-macchinari@mail.example.it>","<sent-reply-001@officine-fittizie.example>"]),
 flow=dict(praticaAction="attach_to_existing",existingPraticaRef="001-completo-macchinari",existingStatus="sent",crmUpsertExpected="0 nuovi lead (eventuale update stesso lead)",expectedStatusAfterPipeline="draft_ready"),
 sched=dict(header="Nuova mail sul thread"))
add(27,"reply-thread-nuova-richiesta",["thread_reply","multi_request"],["§6-thread","§7.2-16","§6-multi"],
 "Irene Basile <irene.basile@ristorante-due-ponti.example>","Re: Preventivo attrezzature cucina",
 "Buongiorno, aggiungerei alla richiesta anche 1 macchina sottovuoto professionale. La priorità resta l'abbattitore. Grazie, Irene Basile",
 "risposta_thread",lead("Irene Basile","Ristorante Due Ponti","irene.basile@ristorante-due-ponti.example",None,"attrezzature cucina (4 voci)",None,"entro metà dicembre"),
 draft(bullets=False,mustMention=["sottovuoto"],note="Nuova voce nello stesso thread: resta la stessa pratica (no nuova pratica, no nuovo lead). Vedi ambiguità A5."),
 multi=[dict(productOrService="macchina sottovuoto professionale",quantity="1")],
 thread=dict(threadId="thr-017",inReplyTo="<sent-reply-017@officine-fittizie.example>",references=["<017-multi-prodotto@mail.example.it>","<sent-reply-017@officine-fittizie.example>"]),
 flow=dict(praticaAction="attach_to_existing",existingPraticaRef="017-multi-prodotto",existingStatus="sent",crmUpsertExpected="0 nuovi lead",expectedStatusAfterPipeline="draft_ready"),
 sched=dict(header="Nuova mail sul thread"))
# --- titoli / PII
add(28,"titolo-dott-pii",["title","pii","formal","complete"],["§6-titoli","§7.2-17"],
 "Dott. Fabrizio Neri <f.neri@poliambulatorio-aurora.example>","Preventivo lettini visita",
 "Buongiorno,\nsono il Dott. Fabrizio Neri, direttore sanitario del Poliambulatorio Aurora (Ancona). Ci servono 3 lettini da visita elettrici entro dicembre. Per la fattura: C.F. NREFBR70A01A271X, P.IVA 03132330444. Il mio cellulare personale è 347 0000555, la mia data di nascita 01/01/1970 se serve per l'anagrafica.",
 "richiesta_preventivo",lead("Fabrizio Neri","Poliambulatorio Aurora","f.neri@poliambulatorio-aurora.example","347 0000555","lettini da visita elettrici","3","entro dicembre",title="Dott."),
 draft(salutation="Gentile Dott. Neri",mustNotMention=["NREFBR70A01A271X","01/01/1970","347 0000555"],note="Codice fiscale e data di nascita fittizi; non devono comparire nella bozza né nella scheda oltre i campi lead."))
add(29,"titolo-avv",["title","formal","missing_qty"],["§6-titoli","§7.2-13"],
 "Avv. Beatrice Sala <b.sala@studiolegale-sala.example>","Richiesta preventivo arredo studio",
 "Spett.le azienda, lo Studio Legale Sala di Como necessita di librerie su misura per la sala riunioni. Gradirei un preventivo e un sopralluogo. P.IVA 04142430455. Avv. Beatrice Sala",
 "richiesta_preventivo",lead("Beatrice Sala","Studio Legale Sala","b.sala@studiolegale-sala.example",None,"librerie su misura sala riunioni",None,None,["quantity"],title="Avv."),
 draft(["quantity"],salutation="Gentile Avv. Sala",mustNotMention=["sopralluogo gratuito","sopralluogo confermato"],note="Non promettere il sopralluogo né date: impegni non inventati."))
# --- encoding
add(30,"encoding-qp-html",["encoding","html","formal","complete"],["§5.2-encoding","§7.2-11"],
 "=?UTF-8?Q?Nicol=C3=B2_Cant=C3=B9?= <nicolo.cantu@vinicola-perla.example>","=?UTF-8?Q?Richiesta_preventivo_etichettatrice_=E2=80=93_urgente?=",
 "<p>Buongiorno,</p><p>sono Nicol=C3=B2 Cant=C3=B9 della Vinicola La Perla S.r.l. di Canel=\nli (AT). Vorrei un preventivo per 1 etichettatrice semiautomatica per bottiglie, entro l&#39;inizio della vendemmia tardiva (fine ottobre). P.IVA 05152530464.</p><p>Grazie &amp; saluti</p>",
 "richiesta_preventivo",lead("Nicolò Cantù","Vinicola La Perla S.r.l.","nicolo.cantu@vinicola-perla.example",None,"etichettatrice semiautomatica per bottiglie","1","entro fine ottobre"),
 draft(salutation="Gentile Signor Cantù"),notes="Header RFC2047 e corpo quoted-printable + HTML: il parser deve decodificare prima dell'estrazione.")
# --- mittente invalido
add(31,"mittente-non-valido",["invalid_sender"],["§6-mittente-invalido"],
 "Modulo sito <>","Richiesta dal form contatti",
 "Nome: Ottavio Riva\nAzienda: Riva Costruzioni\nEmail: ottavio.riva(at)rivacostruzioni\nMessaggio: preventivo per 10 ponteggi a Monza",
 "richiesta_preventivo",lead("Ottavio Riva","Riva Costruzioni",None,None,"ponteggi","10",None,["email","deliverySite"]),
 draft(note="Nessun destinatario valido: stato failed; Approva risponde «Non posso inviare: manca un destinatario valido.»"),
 flow=dict(expectedStatusAfterPipeline="failed",approveResponse="Non posso inviare: manca un destinatario valido.",sendReplyExpected=0,crmUpsertExpected="da decidere (ambiguità A2)"))
# --- idempotenza
add(32,"duplicato-restart",["duplicate_ingest"],["§6-restart","§7.1-4"],
 "Giulia Ferraresi <giulia.ferraresi@tornerie-valdorme.example>","Richiesta preventivo tornio CNC",
 C[0]["email"]["body"],"richiesta_preventivo",C[0]["expected"]["lead"],C[0]["expected"]["draft"],
 mid="<001-completo-macchinari@mail.example.it>",
 flow=dict(praticaAction="noop_duplicate",existingPraticaRef="001-completo-macchinari",crmUpsertExpected=0,praticheExpected=0),
 notes="Stesso messageId del caso 001: da eseguire dopo 001 nello stesso tenant; nessuna seconda pratica, nessun upsert.")

add(33,"piva-richiesta-tenant",["missing_vat","tenant_requires_vat","formal"],["§6-dati-mancanti","§7.2-13","A3"],
 "Mirko Venturi <m.venturi@edilnova-fittizia.example>","Preventivo cartongesso",
 "Buongiorno, sono Mirko Venturi di Edilnova Srl. Vorremmo un preventivo per 300 mq di lastre in cartongesso idrorepellente, consegna al cantiere di Rimini entro 2 settimane. Grazie",
 "richiesta_preventivo",lead("Mirko Venturi","Edilnova Srl","m.venturi@edilnova-fittizia.example",None,"lastre cartongesso idrorepellente","300 mq","entro 2 settimane",["vatNumber"]),
 draft(["vatNumber"],salutation="Gentile Signor Venturi"))
add(34,"non-commerciale-candidatura",["non_commercial","job_application"],["A4"],
 "Sofia Liguori <sofia.liguori@posta-fittizia.example>","Candidatura spontanea",
 "Buongiorno, vi invio la mia candidatura spontanea come impiegata commerciale. Resto a disposizione per un colloquio. Sofia Liguori",
 "non_commerciale",None,None)
add(35,"pii-iban-indirizzo",["pii","formal","complete"],["§6-titoli","A7"],
 "Carlo Mancuso <carlo.mancuso@enoteca-mancuso.example>","Preventivo frigo cantina",
 "Buongiorno, sono Carlo Mancuso, titolare dell'Enoteca Mancuso. Vorrei un preventivo per 2 frigo cantina da 150 bottiglie, consegna a casa mia in via delle Viole 12, 90100 Palermo, entro novembre. Per eventuale acconto il mio IBAN è IT60X0542811101000000123456. Cellulare 338 0000777. P.IVA 06162630476.",
 "richiesta_preventivo",lead("Carlo Mancuso","Enoteca Mancuso","carlo.mancuso@enoteca-mancuso.example","338 0000777","frigo cantina 150 bottiglie","2","entro novembre"),
 draft(salutation="Gentile Signor Mancuso",mustNotMention=["IT60X0542811101000000123456","338 0000777","via delle Viole"],note="A7: la bozza non ripete IBAN, cellulare, indirizzo."))

# ===== Decisioni Craft A1-A8 (15 ott 2026) =====
import re
BTN=["Approva","Modifica","Scarta"]
by={c["id"][:3]:c for c in C}
def vat_of(body):
    m=re.search(r"P\.?\s?IVA\s*(\d{11})",body); return m.group(1) if m else None
for c in C:
    e=c["expected"]; c.setdefault("tenantConfig",{"requireVatNumber":False})
    e["flow"]["telegramLanguage"]="it"
    if e["lead"]:
        e["lead"]["vatNumber"]=vat_of(c["email"]["body"])
        # A3: vatNumber non richiesto di default
        for L in (e["lead"]["missingFields"],):
            if "vatNumber" in L: L.remove("vatNumber")
        e["missingFields"]=e["lead"]["missingFields"]
    if e["draft"]:
        d=e["draft"]
        if "vatNumber" in d["mustAsk"]: d["mustAsk"].remove("vatNumber")
        d["mustNotAskVatNumber"]=True
        d["piiCheck"]=True
# 008: P.IVA assente, tenant default -> NON si chiede
by.update({x["id"][:3]:x for x in C})
c=by["033"]; c["tenantConfig"]={"requireVatNumber":True}
c["expected"]["draft"]["mustAsk"]=["vatNumber"]; c["expected"]["lead"]["missingFields"]=["vatNumber"]; c["expected"]["missingFields"]=["vatNumber"]; c["expected"]["draft"]["mustNotAskVatNumber"]=False
c=by["034"]; c["expected"]["flow"].update(praticaAction="notify_only",crmUpsertExpected=0,expectedStatusAfterPipeline="logged",telegramButtons=[],telegramNotice="notifica breve, nessuna bozza")
c=by["005"]; c["expected"]["draft"]["note"]+=" A3: privato, P.IVA mai chiesta."
c=by["008"]; c["tags"]=["vat_absent_default","formal","complete"]; c["specRefs"]+=["A3"]
c["expected"]["draft"]["note"]="Tenant default (requireVatNumber=false): la P.IVA non si chiede anche se assente."
# A1 lingua
c=by["020"]; d=c["expected"]["draft"]; d.update(language="en",register="formal_en",expectedSalutationContains="Dear Mr Whitfield",note="A1: bozza nella lingua del cliente (inglese, registro formale). Scheda Telegram in italiano.")
c["specRefs"]+=["A1"]
c=by["021"]; c["expected"]["draft"]["note"]="A1: mail mista IT/EN con italiano presente -> default italiano (lei)."; c["specRefs"]+=["A1"]
# A2 mittente invalido
c=by["031"]; f=c["expected"]["flow"]; c["specRefs"]+=["A2"]
f.update(praticaAction="log_only",crmUpsertExpected=0,sendReplyExpected=0,expectedStatusAfterPipeline="failed",telegramButtons=[],telegramNotice="avviso senza pulsanti: mittente non valido, pratica solo registrata")
f.pop("approveResponse",None); c["expected"]["draft"]=None
# A4 non_commerciale
for k,note in (("024","Proposta di un fornitore: non commerciale, non spam."),("025","Richiesta amministrativa di cliente esistente.")):
    c=by[k]; e=c["expected"]; e["classification"]="non_commerciale"; c["specRefs"]+=["A4"]; c["notes"]=note
    e["flow"].update(praticaAction="notify_only",crmUpsertExpected=0,expectedStatusAfterPipeline="logged",telegramButtons=[],telegramNotice="notifica breve, nessuna bozza")
# A5 nuova richiesta nel thread
c=by["027"]; e=c["expected"]; c["specRefs"]+=["A5"]
e["requests"]=[dict(productOrService="abbattitore di temperatura 5 teglie",quantity="1"),dict(productOrService="frigorifero verticale 700 l",quantity="2"),dict(productOrService="lavastoviglie a capotta",quantity="1"),dict(productOrService="macchina sottovuoto professionale",quantity="1")]
e["flow"].update(crmUpsertExpected=1,leadUpdate="same_lead_add_products",newLeadExpected=0,telegramButtons=BTN)
e["draft"]["note"]="A5: upsertLead sullo stesso lead (stesso crmLeadId) con il prodotto aggiunto; nuova bozza da approvare."
# A7 PII
c=by["028"]; c["specRefs"]+=["A7"]; c["expected"]["draft"]["note"]="A7: in CRM solo i contatti scritti dal mittente (email, cellulare). C.F. e data di nascita non sono contatti: non vanno nel lead. La bozza nomina solo nome e azienda."
c["expected"]["crmMustNotContain"]=["NREFBR70A01A271X","01/01/1970"]

for c in C:
    json.dump(c,open(f"cases/{c['id']}.json","w"),ensure_ascii=False,indent=2)
print(len(C))
