/** Shorten saved refusals from older gateways without changing task history. */
export function formatPlanningReply(text: string): string {
  const refusals = [
    {
      prefix: 'The selected sources do not confirm coverage for these requested details: ',
      suffix: '. No quote was created and nothing was executed. Clarify the required data or limit the request to confirmed fields.',
      reply: 'I couldn’t confirm that the available sources cover this request. Nothing was run or charged.',
    },
    {
      prefix: 'The plan does not yet confirm that these supplied inputs or filters are preserved: ',
      suffix: '. No quote was created and nothing was executed. Clarify the requested selection or try planning again.',
      reply: 'I couldn’t preserve all your filters in a plan. Try again. Nothing was run or charged.',
    },
    {
      prefix: 'De geselecteerde bronnen dekken deze gevraagde gegevens nog niet aantoonbaar: ',
      suffix: '. Er is geen prijsvoorstel gemaakt en niets uitgevoerd. Verduidelijk de gewenste gegevens of beperk de vraag tot bevestigde velden.',
      reply: 'Ik kon niet bevestigen dat de beschikbare bronnen deze vraag kunnen beantwoorden. Er is niets uitgevoerd of afgeschreven.',
    },
    {
      prefix: 'Het plan behoudt deze opgegeven gegevens of filters nog niet aantoonbaar: ',
      suffix: '. Er is geen prijsvoorstel gemaakt en niets uitgevoerd. Verduidelijk de gewenste selectie of probeer de planning opnieuw.',
      reply: 'Ik kon nog geen plan maken dat al je filters behoudt. Probeer opnieuw. Er is niets uitgevoerd of afgeschreven.',
    },
  ]
  return refusals.find(({ prefix, suffix }) => text.startsWith(prefix) && text.endsWith(suffix))?.reply ?? text
}
