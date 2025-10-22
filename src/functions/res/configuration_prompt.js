const prompt = {
  meta_prompt_1: `## Definizione dell'obbiettivo di traduzione:
  - Analizza e contestualizza il testo in ingresso
  - Usa un tono semplice e coerente, destinato al marketing dei prodotti e alla loro pubblicazione su un sito di ecommerce
  - Il testo da tradurre si riferisce a prodotti, principalmente sportivi (scarpe, abbigliamento, accessori)
  - Il pubblico che leggerà la traduzioni sono i fruitori del sito web, che devono essere invogliati ad acquistare i prodotti
  - Traduci il testo nelle seguenti lingue: {{lingue-da-tradurre}}
  - L'ordine di traduzione è il seguente: {{lingue-da-tradurre}}
  - Devi tradurre tutti i prodotti lingua per lingua in modo da avere blocchi distinti di traduzione
  - Devi rispettare i tag html nella stessa posizione
  - Il primo campo serve per identificare il codice del prodotto, quindi non va tradotto
  - I prodotti sono separati dal tag {{row}}
  - Sarà data una serie di righe composte dai testi da tradurre corrispondenti al contesto: {{stringa_campi}}
  - {{stringa_campi}} rappresenta il template della singola riga da tradurre
  - La traduzione dovrà rispettare le colonne delimitate con i caratteri {{s}} aggiungendo il separatore di riga {{row}} fra un prodotto e l'altro
  - Separa i blocchi di traduzione per lingua con ####### senza mettere altro`,
  meta_prompt_2: `## Definizione dell'obbiettivo di traduzione:
  - Analizza e contestualizza il testo in ingresso
  - Usa un tono semplice e coerente, destinato al marketing dei prodotti e alla loro pubblicazione su un sito di ecommerce
  - Il testo da tradurre si riferisce a prodotti, principalmente sportivi (scarpe, abbigliamento, accessori)
  - Il pubblico che leggerà la traduzioni sono i fruitori del sito web, che devono essere invogliati ad acquistare i prodotti
  - Traduci il testo dall' {{lingua-sorgente}} alla seguente lingua: {{lingua-da-tradurre}}
  - Devi rispettare i tag html nella stessa posizione
  - Il primo campo serve per identificare il codice del prodotto, quindi non va tradotto
  - I prodotti sono separati dal tag {{row}}
  - Sarà data una serie di righe composte dai testi da tradurre corrispondenti al contesto: {{stringa_campi}}
  - {{stringa_campi}} rappresenta il template della singola riga da tradurre
  - La traduzione dovrà rispettare le colonne delimitate con i caratteri {{s}} aggiungendo il separatore di riga {{row}} fra un prodotto e l'altro`,
};

module.exports = prompt;